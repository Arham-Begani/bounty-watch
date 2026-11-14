import { setTimeout as sleep } from 'node:timers/promises';
import { log } from './util.ts';
export class HttpError extends Error {
  readonly status: number;
  constructor(service: string, status: number) { super(`${service}: HTTP ${status}`); this.name = 'HttpError'; this.status = status; }
}
interface HttpOptions { timeoutMs: number; maxBytes: number; signal: AbortSignal; fetch?: typeof fetch }
export class Http {
  readonly signal: AbortSignal;
  private readonly options: HttpOptions;
  private readonly transport: typeof fetch;
  constructor(options: HttpOptions) { this.options = options; this.signal = options.signal; this.transport = options.fetch ?? fetch; }
  async pause(ms: number): Promise<void> {
    this.signal.throwIfAborted();
    await sleep(Math.max(0, ms), undefined, {signal: this.signal});
  }
  async json(url: string, init: RequestInit, service: string, retries = 3): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      this.signal.throwIfAborted();
      let response: Response;
      let body: string;
      try {
        response = await this.transport(url, {...init, redirect: 'error',
          signal: AbortSignal.any([this.signal, AbortSignal.timeout(this.options.timeoutMs)])});
        const reader = response.body?.getReader();
        const parts: Uint8Array[] = [];
        let size = 0;
        if (reader) {
          try {
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              size += chunk.value.byteLength;
              if (size > this.options.maxBytes) throw new RangeError('HTTP response exceeds size limit');
              parts.push(chunk.value);
            }
          } finally { await reader.cancel().catch(() => {}); }
        }
        body = Buffer.concat(parts).toString('utf8');
      } catch (e) {
        if (this.signal.aborted || e instanceof RangeError || attempt >= retries) throw e;
        log('http_retry', {service, attempt: attempt + 1, reason: 'transport'});
        await this.pause(Math.min(30000, 500 * 2 ** attempt + Math.random() * 250));
        continue;
      }
      let data: unknown = null;
      try { data = body ? JSON.parse(body) as unknown : null; } catch {
        if (response.ok) throw new Error(`${service}: invalid JSON response`);
      }
      if (response.ok) return data;
      const throttled = response.status === 429 || (response.status === 403 && (
        response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after') || /rate limit|abuse detection/i.test(body)));
      if (!(throttled || [408, 500, 502, 503, 504].includes(response.status)) || attempt >= retries)
        throw new HttpError(service, response.status);
      let delay = 500 * 2 ** attempt + Math.random() * 250;
      if (throttled) {
        delay = 60000;
        const retry = response.headers.get('retry-after');
        if (retry) delay = /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
        else if (data && typeof data === 'object') {
          const d = data as Record<string, unknown>;
          const parameters = d['parameters'];
          const seconds = d['retry_after'] ?? (parameters && typeof parameters === 'object' ? (parameters as Record<string, unknown>)['retry_after'] : undefined);
          if (typeof seconds === 'number' && seconds >= 0) delay = seconds * 1000;
        }
        if (response.headers.get('x-ratelimit-remaining') === '0') {
          const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000 - Date.now() + 1000;
          delay = Math.max(delay, reset);
        }
      }
      log('http_retry', {service, status: response.status, attempt: attempt + 1});
      await this.pause(Number.isFinite(delay) ? Math.max(1, delay) : 60000);
    }
  }
}
