// TEST/DRILL ONLY: a fault-injecting proxy in front of a Radix Gateway, for failure-path tests of the
// OwnerPool bot and watcher (docs/owner-pool-bot.md, "Failure-path tests on the ledger"). It binds to
// 127.0.0.1 only and forwards every request to the upstream Gateway unchanged, unless the mode file says
// otherwise. The mode is read from the file on EVERY request, so a test switches it mid-run.
//
//   tsx scripts/gateway-fault-proxy.ts --port 18081 --upstream https://stokenet.radixdlt.com \
//       --mode-file data/soak/fault-stokenet.txt --log data/soak/proxy-stokenet.jsonl
//
// Modes (first word of the file; missing or empty file = pass):
//   pass            forward everything
//   submit-503      POST /transaction/submit answers HTTP 503 and is NOT forwarded (nothing reaches the
//                   network); everything else is forwarded. Reads and previews keep working.
//   submit-reject   /transaction/submit answers 200 {"duplicate": false} and is NOT forwarded;
//                   /transaction/status answers PermanentlyRejected (so the client sees a rejected send)
//   down-503        every call answers HTTP 503
//   down-reset      every connection is destroyed without an answer
//   down-hang       every call is left unanswered (the client's own timeout fires)
//
// Then bot and watcher are pointed at it with --gateway-url http://127.0.0.1:18081 (Stokenet) and/or
// --mainnet-gateway-url http://127.0.0.1:18082 (a second instance in front of the mainnet Gateway,
// which the bot only READS: venue quotes by preview).
import http from 'node:http';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (n: string): string | undefined => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const port = Number(opt('port') ?? 18081);
const upstream = (opt('upstream') ?? 'https://stokenet.radixdlt.com').replace(/\/$/, '');
const modeFile = opt('mode-file') ?? 'data/soak/fault-mode.txt';
const logPath = opt('log');
const MODES = ['pass', 'submit-503', 'submit-reject', 'down-503', 'down-reset', 'down-hang'];

const mode = (): string => {
  if (!existsSync(modeFile)) return 'pass';
  const m = readFileSync(modeFile, 'utf8').trim().split(/\s+/)[0] || 'pass';
  return MODES.includes(m) ? m : 'pass';
};
const log = (o: Record<string, unknown>) => {
  const line = JSON.stringify({ t: new Date().toISOString(), port, ...o });
  if (logPath) appendFileSync(logPath, line + '\n'); else console.log(line);
};

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', async () => {
    const path = req.url ?? '/';
    const m = mode();
    const reply = (status: number, body: unknown, action: string) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
      log({ path, mode: m, action, status });
    };
    if (m === 'down-reset') { log({ path, mode: m, action: 'reset' }); req.socket.destroy(); return; }
    if (m === 'down-hang') { log({ path, mode: m, action: 'hang' }); return; }
    if (m === 'down-503') return reply(503, { message: 'fault injector: gateway down' }, 'injected');
    if (path.startsWith('/transaction/submit')) {
      if (m === 'submit-503') return reply(503, { message: 'fault injector: submit unavailable' }, 'injected (not forwarded)');
      if (m === 'submit-reject') return reply(200, { duplicate: false }, 'swallowed (not forwarded)');
    }
    if (m === 'submit-reject' && path.startsWith('/transaction/status')) {
      return reply(200, { intent_status: 'PermanentlyRejected', intent_status_description: 'fault injector: rejected', error_message: 'fault injector: rejected', known_payloads: [] }, 'injected');
    }
    try {
      const r = await fetch(upstream + path, {
        method: req.method,
        headers: { 'content-type': String(req.headers['content-type'] ?? 'application/json') },
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
        signal: AbortSignal.timeout(60_000),
      });
      const text = await r.text();
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' });
      res.end(text);
      log({ path, mode: m, action: 'forwarded', status: r.status });
    } catch (e) {
      reply(502, { message: `fault proxy: upstream failed: ${String((e as Error)?.message ?? e)}` }, 'upstream-error');
    }
  });
});
// Loopback only: never reachable from another machine.
server.listen(port, '127.0.0.1', () => log({ event: 'listening', host: '127.0.0.1', upstream, modeFile }));
const stop = () => server.close(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
// Hung requests would keep close() waiting: exit regardless after 2 s.
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 2000).unref());
