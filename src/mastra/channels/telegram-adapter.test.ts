import assert from 'node:assert/strict';
import test from 'node:test';
import { GaryTelegramAdapter } from './telegram-adapter';

function withReadOnly(t: test.TestContext, value: string) {
  const prior = process.env.GARY_READ_ONLY;
  process.env.GARY_READ_ONLY = value;
  t.after(() => { if (prior === undefined) delete process.env.GARY_READ_ONLY; else process.env.GARY_READ_ONLY = prior; });
}

function fakeTelegram(t: test.TestContext) {
  const calls: Array<{ method: string; body: unknown }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const method = String(url).split('/').pop()!;
    calls.push({ method, body: JSON.parse(String(init.body)) });
    return Response.json({ ok: true, result: { message_id: 7, date: 0, chat: { id: 42, type: 'private' }, text: 'hi' } });
  });
  return calls;
}

test('a Telegram send is refused in read-only mode before anything reaches Telegram', async (t) => {
  withReadOnly(t, 'true');
  const calls = fakeTelegram(t);
  const adapter = new GaryTelegramAdapter({ botToken: 'test-token', apiUrl: 'http://telegram.test', mode: 'webhook' });
  await assert.rejects(adapter.postMessage('telegram:42', 'Arrival is now available.'), {
    message: 'Gary is running in read-only mode (GARY_READ_ONLY=true), so I did not send that message.',
  });
  assert.deepEqual(calls, []);
});

test('the same Telegram send goes out when Gary is not read-only', async (t) => {
  withReadOnly(t, 'false');
  const calls = fakeTelegram(t);
  const adapter = new GaryTelegramAdapter({ botToken: 'test-token', apiUrl: 'http://telegram.test', mode: 'webhook' });
  await adapter.postMessage('telegram:42', 'Arrival is now available.');
  assert.deepEqual(calls.map((call) => call.method), ['sendMessage']);
  assert.equal((calls[0].body as { chat_id: string }).chat_id, '42');
});
