// Dead-man's switch for the OwnerPool bot and watcher (review M-5): each process writes a heartbeat file
// every tick; this tiny check, run by a timer (deploy/owner-pool-heartbeat.timer, every 2 minutes),
// alerts when a heartbeat is missing, unreadable or older than --max-age. It holds no key and reads no
// ledger. A process killed by SIGKILL, the OOM killer or a lost host sends no "stop" alert itself: this is
// what notices.
//
//   tsx scripts/owner-pool-heartbeat-check.ts --files data/heartbeat/owner-pool-bot-mainnet.json,data/heartbeat/owner-pool-watch-mainnet.json
//     [--max-age <s>] (default 600: about 5 bot intervals, more than one error back-off step)
//     [--alert-url <url>] (or env OWNER_POOL_BOT_ALERT_URL) [--alert-interval <s>] (3600: one alert per dead file per hour)
//     [--state <path>] (default data/heartbeat/check-state.json: the alert rate limiter)
// Exit 0: all alive; 1: at least one dead (alerted).
import { existsSync, readFileSync } from 'node:fs';
import { AlertSink, heartbeatVerdict, optValue } from '../packages/core/src/index.ts';
import { loadJsonWithBackup, saveJsonDurable } from '../packages/core/src/ownerpool-files.ts';

const argv = process.argv.slice(2);
const opt = (n: string) => optValue(argv, n);
const files = (opt('files') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (!files.length) { console.error('--files a,b is required'); process.exit(2); }
const maxAgeSec = Number(opt('max-age') ?? 600);
const intervalSec = Number(opt('alert-interval') ?? 3600);
if (!(maxAgeSec >= 30 && intervalSec >= 60)) { console.error('bad --max-age / --alert-interval'); process.exit(2); }
const statePath = opt('state') ?? 'data/heartbeat/check-state.json';
const st = loadJsonWithBackup<{ alertLast?: Record<string, number> }>(statePath).data ?? {};
const alerts = new AlertSink(opt('alert-url') ?? (process.env.OWNER_POOL_BOT_ALERT_URL || undefined), { intervalMs: intervalSec * 1000, last: st.alertLast, prefix: '[owner-pool heartbeat] ' });
const now = Date.now();
let dead = 0;
for (const f of files) {
  const v = heartbeatVerdict(existsSync(f) ? readFileSync(f, 'utf8') : undefined, now, maxAgeSec * 1000);
  const rec: Record<string, unknown> = { t: new Date(now).toISOString(), file: f, alive: v.alive, reason: v.reason, ...(v.beat ? { program: v.beat.program, network: v.beat.network, note: v.beat.note } : {}) };
  if (!v.alive) {
    dead++;
    const r = await alerts.alert(`dead:${f}`, `NO HEARTBEAT: ${v.beat?.program ?? f} (${v.beat?.network ?? '?'}) ${v.reason}. The process is dead or stuck: check systemctl --user status.`, now);
    rec.alert = { sent: r.sent, ...(r.suppressed ? { suppressed: true } : {}), ...(r.error ? { error: r.error } : {}), ...(alerts.enabled ? {} : { noUrl: true }) };
  } else if (alerts.limiter.last[`dead:${f}`] !== undefined) {
    alerts.limiter.clear(`dead:${f}`);
    const r = await alerts.alert(`alive:${f}`, `Heartbeat back: ${v.beat?.program ?? f} (${v.beat?.network ?? '?'}) ${v.reason}.`, now, { force: true });
    rec.recovered = { sent: r.sent };
  }
  console.log(JSON.stringify(rec));
}
saveJsonDurable(statePath, { alertLast: alerts.limiter.last });
process.exit(dead ? 1 : 0);
