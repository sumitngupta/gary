import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { resetGaryPolicyClientForTests } from '../services/gary-access-policy';
import { resetGaryNotificationDeliveryStoreForTests } from '../services/gary-notification-delivery-store';
import { deliverToUser, enrollmentPrompt, garyAdapter, garyChannelConfig, garyInboundHandler, type GaryConversation, type GaryTurn } from './gary-channels';
import { enroll, issueCode, resetPeopleStoreForTests } from './people';

async function isolated(t: TestContext, env: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'gary-channels-'));
  const prior = { ...process.env };
  Object.assign(process.env, { GARY_DATA_DIR: dir, ...env });
  const reset = () => { resetPeopleStoreForTests(); resetGaryPolicyClientForTests(); resetGaryNotificationDeliveryStoreForTests(); };
  reset();
  t.after(async () => {
    process.env = prior;
    reset();
    await rm(dir, { recursive: true, force: true });
  });
}

function recorder() {
  const turns: GaryTurn[] = [];
  const welcomes: string[] = [];
  const conversation: GaryConversation = {
    welcome: async ({ person, newUser }) => { welcomes.push(`${person.displayName}:${newUser}`); },
    converse: async (turn) => { turns.push(turn); },
  };
  return { turns, welcomes, conversation };
}

function chat(platform: string, userId: string, text: string, id = `${platform}-${userId}-${text}`) {
  const posts: string[] = [];
  const thread = { id: `${platform}:${userId}`, adapter: { name: platform }, post: async (value: string) => { posts.push(value); } };
  const message = { id, text, author: { userId }, attachments: [] };
  return { posts, thread: thread as never, message: message as never };
}

const neverRunAgent = async () => { throw new Error('the agent must not run'); };

async function invite(name: string) {
  return (await issueCode({ kind: 'new-user', displayName: name, role: 'member' })).code;
}

test('an unknown Telegram or web sender gets the enrollment prompt and never reaches the agent', async (t) => {
  await isolated(t);
  const { turns, conversation } = recorder();
  const handler = garyInboundHandler(conversation);
  for (const platform of ['telegram', 'web']) {
    const { posts, thread, message } = chat(platform, platform === 'telegram' ? '4242' : 'browser-1', 'Is Arrival available?');
    await handler(thread, message, neverRunAgent);
    assert.deepEqual(posts, [enrollmentPrompt()], platform);
  }
  assert.equal(turns.length, 0);
  assert.equal(enrollmentPrompt(), 'I don\'t recognize this account yet. Send me the GARY- invite code you got from the admin to connect it to the media server.');
});

test('the web chat endpoint answers 401 without a session cookie', async (t) => {
  await isolated(t);
  const web = garyAdapter('web')!;
  await web.initialize({} as never);
  const response = await web.handleWebhook(new Request('http://gary.test/api/agents/gary/channels/web/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'c1', messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }),
  }));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Unauthorized' });
});

test('an enrollment code sent in chat links that sender once, and the next message reaches the agent', async (t) => {
  await isolated(t);
  const { turns, welcomes, conversation } = recorder();
  const handler = garyInboundHandler(conversation);
  const code = await invite('Alice');
  const enrolling = chat('telegram', '1001', `here is my code ${code}`);
  await handler(enrolling.thread, enrolling.message, neverRunAgent);
  const stranger = chat('telegram', '2002', code);
  await handler(stranger.thread, stranger.message, neverRunAgent);
  assert.deepEqual([welcomes, stranger.posts], [['Alice:true'], [enrollmentPrompt()]]);

  let agentRuns = 0;
  const asking = chat('telegram', '1001', 'Is Arrival available?');
  await handler(asking.thread, asking.message, async () => { agentRuns += 1; });
  await turns[0].runAgent();
  assert.deepEqual([turns.length, turns[0].person.displayName, turns[0].channel, turns[0].firstTurn, agentRuns], [1, 'Alice', 'telegram', true, 1]);
  assert.match(turns[0].resourceId, /^gary-user:u_[0-9a-f]{16}$/);
});

test('two people on two channels get different memory resources and an unknown sender gets none', async (t) => {
  await isolated(t);
  await enroll({ channel: 'telegram', externalId: '1001' }, { kind: 'code', text: await invite('Alice') });
  await enroll({ channel: 'web', externalId: 'bob-browser' }, { kind: 'code', text: await invite('Bob') });
  const { resolveResourceId } = garyChannelConfig(recorder().conversation);
  const resolve = (platform: string, userId: string) => resolveResourceId!({ platform, message: { author: { userId } }, thread: {}, defaultResourceId: `${platform}:${userId}` } as never);
  const alice = await resolve('telegram', '1001');
  const bob = await resolve('web', 'bob-browser');
  assert.notEqual(alice, bob);
  assert.deepEqual([alice.startsWith('gary-user:'), bob.startsWith('gary-user:')], [true, true]);
  await assert.rejects(Promise.resolve(resolve('telegram', '3003')), { message: 'Refusing to create memory for an unidentified telegram sender' });
});

function fakeTelegram(t: TestContext) {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push({ method: String(url).split('/').pop()!, body: JSON.parse(String(init.body)) });
    return Response.json({ ok: true, result: { message_id: 9, date: 0, chat: { id: 1001, type: 'private' }, text: 'x' } });
  });
  return calls;
}

test('a proactive Telegram send is refused in read-only mode and nothing reaches Telegram', async (t) => {
  await isolated(t, { TELEGRAM_BOT_TOKEN: 'test-bot-token', GARY_READ_ONLY: 'true' });
  const calls = fakeTelegram(t);
  const alice = await enroll({ channel: 'telegram', externalId: '1001' }, { kind: 'code', text: await invite('Alice') });
  assert.ok(alice.status === 'linked');
  const result = await deliverToUser(alice.person.id, { kind: 'media.radar', text: 'Fresh picks' }, { prefer: 'telegram' });
  assert.deepEqual(result, { sent: false, reason: 'Gary is running in read-only mode (GARY_READ_ONLY=true), so I did not send that message.' });
  assert.deepEqual(calls, []);
});

test('outside read-only mode a web-origin notice falls back to the person\'s Telegram chat', async (t) => {
  await isolated(t, { TELEGRAM_BOT_TOKEN: 'test-bot-token', GARY_READ_ONLY: 'false' });
  const calls = fakeTelegram(t);
  const alice = await enroll({ channel: 'web', externalId: 'alice-browser' }, { kind: 'code', text: await invite('Alice') });
  assert.ok(alice.status === 'linked');
  const webOnly = await deliverToUser(alice.person.id, { kind: 'media.radar', text: 'Fresh picks' }, { prefer: 'web' });
  assert.deepEqual(webOnly, { sent: false, reason: 'No linked chat that Gary can message first (web chat only answers while you have it open)' });
  await enroll({ channel: 'telegram', externalId: '1001' }, { kind: 'code', text: (await issueCode({ kind: 'existing-user', userId: alice.person.id })).code });
  const result = await deliverToUser(alice.person.id, { kind: 'media.radar', text: 'Fresh picks' }, { prefer: 'web' });
  assert.deepEqual([result.sent, result.sent && result.channel], [true, 'telegram']);
  assert.deepEqual(calls.map((call) => [call.method, call.body.chat_id, call.body.text]), [['sendMessage', '1001', 'Fresh picks']]);
});
