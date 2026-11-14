import { resolve } from 'node:path';
import type { Config } from './types.ts';
export function endpoint(value: string, name: string): string {
  const u = new URL(value);
  if (u.username || u.password || u.hash) throw new Error(`${name} cannot contain userinfo or a fragment`);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(u.hostname)))
    throw new Error(`${name} requires HTTPS (HTTP is allowed only on loopback)`);
  return u.toString();
}
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const get = (key: string, fallback = '') => env[key]?.trim() || fallback;
  const required = (key: string) => { const v = get(key); if (!v) throw new Error(`Missing ${key}`); return v; };
  const num = (key: string, fallback: number, min: number, max: number) => {
    const v = Number(get(key, String(fallback)));
    if (!Number.isSafeInteger(v) || v < min || v > max) throw new Error(`Invalid ${key}`);
    return v;
  };
  const llmMode = get('LLM_MODE', 'openai');
  if (llmMode !== 'openai' && llmMode !== 'webhook') throw new Error('Invalid LLM_MODE');
  const discordUrl = get('DISCORD_WEBHOOK_URL');
  if (discordUrl) endpoint(discordUrl, 'DISCORD_WEBHOOK_URL');
  const telegramToken = get('TELEGRAM_BOT_TOKEN'), telegramChatId = get('TELEGRAM_CHAT_ID');
  if (Boolean(telegramToken) !== Boolean(telegramChatId)) throw new Error('Set both Telegram settings');
  if (telegramToken && !/^\d+:[A-Za-z0-9_-]+$/.test(telegramToken)) throw new Error('Invalid TELEGRAM_BOT_TOKEN');
  if (telegramChatId && !/^(?:-?\d+|@[A-Za-z0-9_]+)$/.test(telegramChatId)) throw new Error('Invalid TELEGRAM_CHAT_ID');
  if (!discordUrl && !telegramToken) throw new Error('Configure Discord or Telegram');
  const repomixVersion = get('REPOMIX_VERSION', '1.19.0');
  if (!/^\d+\.\d+\.\d+$/.test(repomixVersion)) throw new Error('Pin REPOMIX_VERSION to an exact release');
  return {
    githubToken: required('GITHUB_TOKEN'),
    githubApi: endpoint(get('GITHUB_API_URL', 'https://api.github.com'), 'GITHUB_API_URL').replace(/\/$/, ''),
    githubVersion: get('GITHUB_API_VERSION', '2022-11-28'),
    llmMode,
    llmUrl: endpoint(llmMode === 'openai' ? get('OPENAI_URL', 'https://api.openai.com/v1/responses') : required('LLM_WEBHOOK_URL'), 'LLM_URL'),
    llmKey: llmMode === 'openai' ? required('OPENAI_API_KEY') : get('LLM_WEBHOOK_TOKEN'),
    model: get('OPENAI_MODEL', 'gpt-6.1-terra'),
    discordUrl, telegramToken, telegramChatId, repomixVersion,
    stateDir: resolve(get('STATE_DIR', './data')),
    trustedBots: new Set(get('TRUSTED_BOUNTY_BOTS', 'algora[bot],opire[bot],expensifybot').toLowerCase().split(',').map(s => s.trim()).filter(Boolean)),
    minBountyCents: num('MIN_BOUNTY_USD', 100, 100, 100000000) * 100,
    minScore: num('MIN_SCORE', 1, 1, 10),
    requestTimeoutMs: num('REQUEST_TIMEOUT_MS', 60000, 1000, 180000),
    runBudgetMs: num('RUN_BUDGET_MS', 240000, 10000, 3600000),
    searchIntervalMs: num('SEARCH_INTERVAL_MS', 2200, 2100, 60000),
    maxPayloadBytes: num('MAX_PAYLOAD_BYTES', 800000, 10000, 20000000),
    maxResponseBytes: num('MAX_RESPONSE_BYTES', 64000000, 1000000, 256000000),
    retentionDays: num('RETENTION_DAYS', 90, 1, 3650),
    pollIntervalMs: num('POLL_INTERVAL_MS', 300000, 300000, 86400000),
  };
}
