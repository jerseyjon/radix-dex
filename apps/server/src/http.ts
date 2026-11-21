import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { isIPv6 } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** A handler's answer with a status other than 200 (for example /api/health's 503, which still carries a body). */
export class JsonReply {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) { this.status = status; this.body = body; }
}

export type Handler = (ctx: { req: IncomingMessage; url: URL; params: Record<string, string>; body: () => Promise<any> }) => Promise<unknown> | unknown;

interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler; cost: number }

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
};

const MAX_BODY = 64 * 1024;

/**
 * Headers on every response. They cannot break the page: no script or style policy is set here
 * (the Radix connect button injects its own; a full Content-Security-Policy needs testing with the
 * wallet before it is turned on). Framing is refused, so the site cannot be overlaid for clickjacking.
 */
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'content-security-policy': "frame-ancestors 'none'",
  'x-frame-options': 'DENY',
};

/**
 * The rate limit's key for an address. IPv6 clients usually hold a whole /64, so it is counted as one;
 * otherwise one client could take on any number of identities.
 */
export function rateKey(ip: string): string {
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (v4) return v4[1]!;
  if (!isIPv6(ip)) return ip;
  // Expand "::" and keep the first four groups.
  const [head = '', tail = ''] = ip.split('%')[0]!.split('::');
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

/** Tiny JSON router with a per-IP rate limit, body size cap and optional static file serving. */
export class Api {
  private readonly routes: Route[] = [];
  private readonly hits = new Map<string, { count: number; windowStart: number }>();
  private readonly opts: { staticDir?: string; ratePerMinute: number; allowOrigin: string; clientIpHeader?: string; documents: Record<string, unknown> };

  /**
   * `clientIpHeader`: behind a proxy every request arrives from the proxy's address, so the rate
   * limit must read the visitor's address from the header the proxy sets. Only set it when the
   * server cannot be reached except through that proxy, or anyone could forge the header.
   * `documents`: fixed JSON served at exact paths outside /api.
   */
  constructor(opts: { staticDir?: string; ratePerMinute?: number; allowOrigin?: string; clientIpHeader?: string; documents?: Record<string, unknown> } = {}) {
    this.opts = { staticDir: opts.staticDir && resolve(opts.staticDir), ratePerMinute: opts.ratePerMinute ?? 240, allowOrigin: opts.allowOrigin ?? '*', clientIpHeader: opts.clientIpHeader?.toLowerCase(), documents: opts.documents ?? {} };
  }

  /** `cost`: how many requests one call counts as against the rate limit (expensive endpoints count more). */
  on(method: string, path: string, handler: Handler, cost = 1): void {
    const keys: string[] = [];
    const pattern = new RegExp('^' + path.replace(/:([a-z]+)/gi, (_m, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    this.routes.push({ method, pattern, keys, handler, cost });
  }

  private limited(ip: string, cost: number): boolean {
    const now = Date.now();
    const key = rateKey(ip);
    // Drop windows that have ended, rather than wiping everyone's count when the table grows.
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (now - v.windowStart > 60_000) this.hits.delete(k);
    const h = this.hits.get(key);
    if (!h || now - h.windowStart > 60_000) {
      if (this.hits.size > 50_000) return true; // a table this full of live windows is a flood: refuse new clients for the minute
      this.hits.set(key, { count: cost, windowStart: now });
      return cost > this.opts.ratePerMinute;
    }
    h.count += cost;
    return h.count > this.opts.ratePerMinute;
  }

  private async serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
    const dir = this.opts.staticDir;
    if (!dir) return false;
    const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(dir, rel);
    if (!file.startsWith(dir)) return false;
    if (!extname(file)) file = join(dir, 'index.html');
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', ...SECURITY_HEADERS });
      res.end(data);
      return true;
    } catch {
      return false;
    }
  }

  /** Plain http, or https when a key and certificate are given. */
  listen(port: number, host: string, tls?: { key: Buffer; cert: Buffer }): Server {
    const handler = async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const send = (status: number, body: unknown, extra: Record<string, string> = {}) => {
        res.writeHead(status, {
          'content-type': 'application/json',
          'access-control-allow-origin': this.opts.allowOrigin,
          'access-control-allow-headers': 'content-type',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'cache-control': 'no-store',
          ...SECURITY_HEADERS,
          ...extra,
        });
        res.end(JSON.stringify(body));
      };
      try {
        if (req.method === 'OPTIONS') return send(204, null);
        if (req.method === 'GET' && url.pathname in this.opts.documents) return send(200, this.opts.documents[url.pathname]);
        if (!url.pathname.startsWith('/api/')) {
          if (req.method === 'GET' && (await this.serveStatic(url.pathname, res))) return;
          return send(404, { error: 'Not found' });
        }
        const forwarded = this.opts.clientIpHeader ? req.headers[this.opts.clientIpHeader] : undefined;
        const client = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim() || req.socket.remoteAddress || '?';
        for (const route of this.routes) {
          if (route.method !== req.method) continue;
          const m = route.pattern.exec(url.pathname);
          if (!m) continue;
          if (this.limited(client, route.cost)) return send(429, { error: 'Too many requests' }, { 'retry-after': '60' });
          const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]));
          const body = async () => {
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const c of req) {
              size += (c as Buffer).length;
              if (size > MAX_BODY) throw new HttpError(413, 'Request body too large');
              chunks.push(c as Buffer);
            }
            try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new HttpError(400, 'Body is not valid JSON'); }
          };
          const out = await route.handler({ req, url, params, body });
          return out instanceof JsonReply ? send(out.status, out.body) : send(200, out);
        }
        if (this.limited(client, 1)) return send(429, { error: 'Too many requests' }, { 'retry-after': '60' });
        send(404, { error: 'Not found' });
      } catch (e) {
        if (e instanceof HttpError) return send(e.status, { error: e.message });
        // A malformed percent-escape in the path is the client's mistake.
        if (e instanceof URIError) return send(400, { error: 'Malformed URL' });
        console.error(`[http] ${req.method} ${url.pathname} failed:`, e);
        send(500, { error: 'Internal error' });
      }
    };
    const server = tls ? createTlsServer(tls, handler) : createServer(handler);
    server.listen(port, host);
    return server;
  }
}
