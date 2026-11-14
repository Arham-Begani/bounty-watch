import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Http, HttpError } from '../src/http.ts';

test('retries throttling, rejects other 4xx and prevents redirect credential leaks', async () => {
  let calls = 0;
  const http = new Http({timeoutMs: 1000, maxBytes: 1000, signal: new AbortController().signal,
    fetch: async (_url, init) => {
      assert.equal(init?.redirect, 'error');
      if (++calls === 1) return new Response('{"retry_after":0.001}', {status: 429});
      return new Response('{"ok":true}');
    }});
  assert.deepEqual(await http.json('http://127.0.0.1/test', {}, 'test'), {ok: true});
  assert.equal(calls, 2);
  const denied = new Http({timeoutMs: 1000, maxBytes: 1000, signal: new AbortController().signal,
    fetch: async () => new Response('secret-body', {status: 401})});
  await assert.rejects(denied.json('https://api.github.com/x', {}, 'github'),
    (e: unknown) => e instanceof HttpError && e.status === 401 && !e.message.includes('secret'));
});
test('enforces streaming response limits and aborts pending retries', async () => {
  const controller = new AbortController();
  const http = new Http({timeoutMs: 1000, maxBytes: 3, signal: controller.signal,
    fetch: async () => new Response('12345')});
  await assert.rejects(http.json('http://127.0.0.1/test', {}, 'test'), /size limit/);
  controller.abort();
  await assert.rejects(http.json('http://127.0.0.1/test', {}, 'test'));
});
