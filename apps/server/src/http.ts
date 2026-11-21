import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export type Handler = (ctx: { req: IncomingMessage; url: URL; params: Record<string, string>; body: () => Promise<any> }) => Promise<unknown> | unknown;

interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler }

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
};

const MAX_BODY = 64 * 1024;

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

  on(method: string, path: string, handler: Handler): void {
    const keys: string[] = [];
    const pattern = new RegExp('^' + path.replace(/:([a-z]+)/gi, (_m, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    this.routes.push({ method, pattern, keys, handler });
  }

  private limited(ip: string): boolean {
    const now = Date.now();
    const h = this.hits.get(ip);
    if (!h || now - h.windowStart > 60_000) { this.hits.set(ip, { count: 1, windowStart: now }); return false; }
    if (this.hits.size > 10_000) this.hits.clear();
    return ++h.count > this.opts.ratePerMinute;
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
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff' });
      res.end(data);
      return true;
    } catch {
      return false;
    }
  }

  /** Plain http, or https when a key and certificate are given. */
  listen(port: number, host: string, tls?: { key: Buffer; cert: Buffer }) {
    const handler = async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const send = (status: number, body: unknown) => {
        res.writeHead(status, {
          'content-type': 'application/json',
          'access-control-allow-origin': this.opts.allowOrigin,
          'access-control-allow-headers': 'content-type',
          'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
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
        if (this.limited(client)) return send(429, { error: 'Too many requests' });
        for (const route of this.routes) {
          if (route.method !== req.method) continue;
          const m = route.pattern.exec(url.pathname);
          if (!m) continue;
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
          return send(200, await route.handler({ req, url, params, body }));
        }
        send(404, { error: 'Not found' });
      } catch (e) {
        if (e instanceof HttpError) return send(e.status, { error: e.message });
        console.error(`[http] ${req.method} ${url.pathname} failed:`, e);
        send(500, { error: 'Internal error' });
      }
    };
    const server = tls ? createTlsServer(tls, handler) : createServer(handler);
    server.listen(port, host);
    return server;
  }
}
