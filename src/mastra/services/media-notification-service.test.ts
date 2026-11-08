import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetGaryNotificationDeliveryStoreForTests } from './gary-notification-delivery-store';
import { mediaAvailabilityWatchSchema } from '../schemas/media-availability-watch';
import { sendAvailabilityMessage, supervisorMediaIssueMessage } from './media-notification-service';
import { deliverToUser } from '../channels/gary-channels';
import { enroll, issueCode, resetPeopleStoreForTests, resourceIdFor } from '../channels/people';
import { serverName } from '../config/branding';

const whatsappEnv = {
  GARY_WHATSAPP_ACCESS_TOKEN: 'test-token', GARY_WHATSAPP_APP_SECRET: 'test-secret',
  GARY_WHATSAPP_PHONE_NUMBER_ID: 'phone-id', GARY_WHATSAPP_VERIFY_TOKEN: 'verify', GARY_READ_ONLY: 'false',
};

async function whatsappFixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'gary-notification-'));
  const prior = { ...process.env };
  Object.assign(process.env, { GARY_DATA_DIR: dir, ...whatsappEnv });
  resetPeopleStoreForTests(); resetGaryNotificationDeliveryStoreForTests();
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return Response.json({ messages: [{ id: `wamid.${requests.length}` }] });
  });
  t.after(async () => {
    process.env = prior;
    resetPeopleStoreForTests(); resetGaryNotificationDeliveryStoreForTests();
    await rm(dir, { recursive: true, force: true });
  });
  const linked = await enroll({ channel: 'whatsapp', externalId: '15550001111' }, { kind: 'code', text: (await issueCode({ kind: 'new-user', displayName: 'Alice', role: 'member' })).code });
  assert.ok(linked.status === 'linked');
  return { requests, userId: linked.person.id };
}

function watchFor(resourceId: string) {
  return mediaAvailabilityWatchSchema.parse({
    id: 'watch-one', title: 'Anastasia', mediaType: 'movie', year: 1997,
    requester: 'Alice', resourceId, threadId: 'thread-one', channel: 'whatsapp', status: 'active', dirty: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), dedupeKey: 'dedupe-one',
  });
}

test('an availability notice reaches an enrolled WhatsApp owner through the approved template, once', async (t) => {
  const { requests, userId } = await whatsappFixture(t);
  const watch = watchFor(resourceIdFor(userId));
  const options = { idempotencyKey: 'availability-one', kind: 'media.available' as const };
  const delivered = await sendAvailabilityMessage(watch, `Anastasia is now available in ${serverName()}.`, options);
  assert.deepEqual(delivered, { sent: true, reason: null, channel: 'whatsapp', messageId: 'wamid.1' });
  assert.deepEqual(requests.map((request) => [request.url, request.body]), [[
    'https://graph.facebook.com/v25.0/phone-id/messages',
    {
      messaging_product: 'whatsapp', recipient_type: 'individual', to: '15550001111', type: 'template',
      template: { name: 'gary_media_available', language: { code: 'en_US' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Anastasia (1997)' }] }] },
    },
  ]]);
  assert.deepEqual(await sendAvailabilityMessage(watch, 'again', options), { sent: false, reason: 'Notification already sent' });
  assert.equal(requests.length, 1);
});

test('a notice for a resource that is not an enrolled Gary user is never sent', async (t) => {
  const { requests } = await whatsappFixture(t);
  assert.deepEqual(await sendAvailabilityMessage(watchFor('whatsapp:15550003333'), 'Available'), { sent: false, reason: 'The watch does not belong to an enrolled Gary user' });
  assert.deepEqual(await sendAvailabilityMessage(watchFor(resourceIdFor('u_0000000000000000')), 'Available'), { sent: false, reason: 'No linked chat that Gary can message first (web chat only answers while you have it open)' });
  assert.deepEqual(requests, []);
});

test('a radar digest goes to an enrolled WhatsApp owner as a plain text message', async (t) => {
  const { requests, userId } = await whatsappFixture(t);
  const result = await deliverToUser(userId, { kind: 'media.radar', text: 'Fresh picks' }, { prefer: 'whatsapp' });
  assert.deepEqual([result.sent, result.sent && result.channel], [true, 'whatsapp']);
  assert.deepEqual(requests.map((request) => request.body), [{ messaging_product: 'whatsapp', recipient_type: 'individual', to: '15550001111', type: 'text', text: { body: 'Fresh picks', preview_url: false } }]);
});

test('formats download issues as supervisor alerts with requester context', () => {
  assert.equal(
    supervisorMediaIssueMessage({
      title: 'Only Murders in the Building',
      year: 2021,
      requester: 'Dana',
    }, 'the download is stalled with no connections'),
    `Gary watch for Dana: Only Murders in the Building (2021) needs attention in ${serverName()}: the download is stalled with no connections.`,
  );
});

