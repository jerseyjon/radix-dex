/**
 * A minimal alert sink for the OwnerPool bot and watcher: a plain HTTP POST of a short text body
 * (ntfy-style: POST https://ntfy.sh/<topic> with the message as the body). Nothing is sent when no
 * URL is configured. Repeats of the same condition are rate-limited by `AlertLimiter`.
 *
 * Sending never throws: an alert that cannot be delivered is reported to the caller (to log), and
 * the bot carries on.
 */

export type AlertFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

/** Per-condition rate limit: one alert per `key` per `intervalMs`. The map is plain data so it can be kept in a state file. */
export class AlertLimiter {
  readonly last: Record<string, number>;
  readonly intervalMs: number;
  constructor(intervalMs: number, last: Record<string, number> = {}) {
    this.intervalMs = intervalMs;
    this.last = { ...last };
  }
  /** True (and remembers `now`) when an alert for `key` may go out now. */
  allow(key: string, now: number): boolean {
    const prev = this.last[key];
    if (prev !== undefined && now - prev < this.intervalMs && now >= prev) return false;
    this.last[key] = now;
    return true;
  }
  /** Forget `key`, so the next occurrence alerts at once (use when a condition clears). */
  clear(key: string): void {
    delete this.last[key];
  }
}

export interface AlertResult { key: string; sent: boolean; suppressed?: boolean; error?: string; text: string }

/** Cap on one alert's body: ntfy shows the first ~4 KB; a phone notification much less. */
export const ALERT_MAX_CHARS = 1000;

export class AlertSink {
  readonly limiter: AlertLimiter;
  readonly url: string | undefined;
  private readonly fetchFn: AlertFetch;
  private readonly prefix: string;
  private readonly timeoutMs: number;
  constructor(url: string | undefined, o: { intervalMs: number; last?: Record<string, number>; fetch?: AlertFetch; prefix?: string; timeoutMs?: number }) {
    this.url = url || undefined;
    this.limiter = new AlertLimiter(o.intervalMs, o.last);
    this.fetchFn = o.fetch ?? (globalThis.fetch as unknown as AlertFetch);
    this.prefix = o.prefix ?? '';
    this.timeoutMs = o.timeoutMs ?? 10_000;
  }

  get enabled(): boolean { return !!this.url; }

  /**
   * Alert for condition `key` with `text`, unless the same key alerted within the interval. With no
   * URL nothing is sent (the result says so; the limiter still records it, so logs show what would have gone).
   */
  async alert(key: string, text: string, now = Date.now()): Promise<AlertResult> {
    const body = (this.prefix + text).slice(0, ALERT_MAX_CHARS);
    if (!this.limiter.allow(key, now)) return { key, sent: false, suppressed: true, text: body };
    if (!this.url) return { key, sent: false, text: body };
    try {
      const res = await this.fetchFn(this.url, { method: 'POST', headers: { 'content-type': 'text/plain; charset=utf-8' }, body, signal: AbortSignal.timeout(this.timeoutMs) });
      if (res.ok) return { key, sent: true, text: body };
      this.limiter.clear(key); // not delivered: try again next time rather than stay silent for an interval
      return { key, sent: false, error: `HTTP ${res.status}`, text: body };
    } catch (e) {
      this.limiter.clear(key);
      return { key, sent: false, error: String((e as Error)?.message ?? e).slice(0, 200), text: body };
    }
  }
}
