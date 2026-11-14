import { createHash } from 'node:crypto';
export function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Expected JSON object');
  return v as Record<string, unknown>;
}
export function array(v: unknown): unknown[] {
  if (!Array.isArray(v)) throw new Error('Expected JSON array');
  return v;
}
export function string(v: unknown): string {
  if (typeof v !== 'string') throw new Error('Expected string');
  return v;
}
export function integer(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new Error('Expected integer');
  return v;
}
export function bool(v: unknown): boolean {
  if (typeof v !== 'boolean') throw new Error('Expected boolean');
  return v;
}
export function iso(v: unknown): string {
  const s = string(v);
  if (!Number.isFinite(Date.parse(s))) throw new Error('Expected timestamp');
  return s;
}
export function repoName(v: unknown): string {
  const s = string(v);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(s) || /\/(\.|\.\.)$/.test(s))
    throw new Error('Invalid repository name');
  return s;
}
export function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function utc(ms: number): string { return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z'); }
export function log(event: string, fields: Record<string, string | number | boolean | null> = {}): void {
  process.stdout.write(JSON.stringify({time: new Date().toISOString(), event, ...fields}) + '\n');
}
// Never log arbitrary transport errors, response bodies, tokens or webhook URLs.
export function errorCode(e: unknown): string {
  if (!(e instanceof Error)) return 'UnknownError';
  const known: Record<string,string> = {
    'Full context exceeds MAX_PAYLOAD_BYTES; refusing silent truncation':'PayloadTooLarge',
    'HTTP response exceeds size limit':'ResponseTooLarge',
    'Unverified file prediction':'UnverifiedFilePrediction',
    'GitHub search incomplete at one-second resolution':'SearchIncomplete',
    'GitHub search pagination changed; retry required':'SearchChanged',
    'OpenAI response incomplete':'LLMIncomplete',
    'OpenAI refused triage':'LLMRefusal',
    'Issue changed during triage':'IssueChanged',
    'Issue changed while reading comments; retry required':'IssueChanged',
  };
  if (/^(github|triage|discord|telegram): HTTP [1-5]\d{2}$/.test(e.message))return e.message;
  return Object.hasOwn(known,e.message) ? known[e.message]! : e.name;
}
export function html(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
export function clip(s: string, limit: number): string {
  return s.length <= limit ? s : s.slice(0, limit - 1) + '…';
}
