import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimGaryWhatsAppEnrollment, createGaryWhatsAppEnrollment, resetGaryPolicyClientForTests } from './gary-access-policy';
import { resetGaryNotificationDeliveryStoreForTests } from './gary-notification-delivery-store';
import { sendWhatsAppMediaRadar } from './whatsapp-media-radar-delivery';
import { mediaAvailabilityWatchSchema } from '../schemas/media-availability-watch';
import { sendAvailabilityMessage, supervisorMediaIssueMessage, whatsappAvailabilityTemplatePayload } from './media-notification-service';
import { serverName } from '../config/branding';

test('sends an individual WhatsApp availability notification to an allowlisted watch owner', async () => {
  const originalFetch = globalThis.fetch;
  const originalUsers = process.env.GARY_WHATSAPP_ALLOWED_USERS;
  const originalToken = process.env.GARY_WHATSAPP_ACCESS_TOKEN;
  const originalPhoneId = process.env.GARY_WHATSAPP_PHONE_NUMBER_ID;
  process.env.GARY_WHATSAPP_ALLOWED_USERS = '15550001111';
  process.env.GARY_WHATSAPP_ACCESS_TOKEN = 'test-token';
  process.env.GARY_WHATSAPP_PHONE_NUMBER_ID = 'phone-id';
  let requestBody: any;
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.notification' }] }), { status: 200 });
  }) as typeof fetch;

  try {
    const watch = mediaAvailabilityWatchSchema.parse({
      id: 'watch-one', title: 'Anastasia', mediaType: 'movie', year: 1997,
      requester: 'Alice', resourceId: 'whatsapp:15550001111', threadId: 'thread-one',
      channel: 'whatsapp', status: 'active', dirty: false,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), dedupeKey: 'dedupe-one',
    });
    const result = await sendAvailabilityMessage(watch, `Anastasia is now available in ${serverName()}.`);
    assert.equal(result.sent, true);
    assert.equal(result.whatsappMessageId, 'wamid.notification');
    assert.deepEqual(requestBody, {
      messaging_product: 'whatsapp', recipient_type: 'individual', to: '15550001111',
      type: 'text', text: { preview_url: false, body: `Anastasia is now available in ${serverName()}.` },
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUsers === undefined) delete process.env.GARY_WHATSAPP_ALLOWED_USERS;
    else process.env.GARY_WHATSAPP_ALLOWED_USERS = originalUsers;
    if (originalToken === undefined) delete process.env.GARY_WHATSAPP_ACCESS_TOKEN;
    else process.env.GARY_WHATSAPP_ACCESS_TOKEN = originalToken;
    if (originalPhoneId === undefined) delete process.env.GARY_WHATSAPP_PHONE_NUMBER_ID;
    else process.env.GARY_WHATSAPP_PHONE_NUMBER_ID = originalPhoneId;
  }
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

test('enrolled recipients can retry failed availability delivery while unknown recipients stay blocked', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gary-enrolled-notification-'));
  const previousEnv = { ...process.env };
  const previousFetch = globalThis.fetch;
  process.env.GARY_DATA_DIR = dir;
  process.env.GARY_WHATSAPP_ALLOWED_USERS = '';
  process.env.GARY_WHATSAPP_ACCESS_TOKEN = 'test-token';
  process.env.GARY_WHATSAPP_PHONE_NUMBER_ID = 'test-phone';
  resetGaryPolicyClientForTests();
  resetGaryNotificationDeliveryStoreForTests();
  const recipients: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    recipients.push(JSON.parse(String(init?.body)).to);
    return Response.json({ messages: [{ id: 'wamid.enrolled' }] });
  }) as typeof fetch;
  const watch = mediaAvailabilityWatchSchema.parse({
    id: 'enrolled-watch', title: 'What We Do in the Shadows', mediaType: 'movie', year: 2014,
    resourceId: 'whatsapp:15550002222', threadId: 'enrolled-thread', channel: 'whatsapp',
    status: 'active', dirty: false, dedupeKey: 'enrolled-watch',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  const options = { idempotencyKey: 'enrolled-availability', kind: 'media.available' as const };
  try {
    assert.equal((await sendAvailabilityMessage(watch, 'Available', options)).sent, false);
    assert.deepEqual(recipients, []);
    const enrollment = await createGaryWhatsAppEnrollment({ name: 'Friend', email: 'friend@example.com' });
    assert.equal((await claimGaryWhatsAppEnrollment('15550002222', enrollment.code)).accepted, true);
    const delivered = await sendAvailabilityMessage(watch, 'Available', options);
    assert.equal(delivered.sent, true);
    assert.equal(delivered.whatsappMessageId, 'wamid.enrolled');
    assert.deepEqual(recipients, ['15550002222']);
    assert.equal((await sendAvailabilityMessage(watch, 'Available', options)).sent, false);
    assert.equal((await sendAvailabilityMessage({ ...watch, resourceId: 'whatsapp:15550003333' }, 'Available')).sent, false);
    assert.equal((await sendAvailabilityMessage({ ...watch, resourceId: 'whatsapp:group:15550002222' }, 'Available')).sent, false);
    assert.deepEqual(recipients, ['15550002222']);
    assert.equal(await sendWhatsAppMediaRadar(watch.resourceId, 'Your picks'), 'wamid.enrolled');
    await assert.rejects(sendWhatsAppMediaRadar('whatsapp:15550003333', 'Your picks'), /not allowlisted/);
    assert.deepEqual(recipients, ['15550002222', '15550002222']);
  } finally {
    globalThis.fetch = previousFetch;
    process.env = previousEnv;
    resetGaryPolicyClientForTests();
    resetGaryNotificationDeliveryStoreForTests();
    await rm(dir, { recursive: true, force: true });
  }
});

test('selects single and batch WhatsApp availability templates deterministically', () => {
  const base = {
    requester: 'Alice', resourceId: 'whatsapp:15550001111', threadId: 'thread-one', channel: 'whatsapp' as const,
    status: 'active' as const, dirty: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const first = mediaAvailabilityWatchSchema.parse({ ...base, id: 'watch-one', title: 'Labyrinth', mediaType: 'movie', year: 1986, dedupeKey: 'one' });
  const second = mediaAvailabilityWatchSchema.parse({ ...base, id: 'watch-two', title: 'The Karate Kid', mediaType: 'movie', year: 1984, dedupeKey: 'two' });
  assert.equal(whatsappAvailabilityTemplatePayload('15550001111', [first]).template.name, 'gary_media_available');
  const batch = whatsappAvailabilityTemplatePayload('15550001111', [first, second]);
  assert.equal(batch.template.name, 'gary_tracked_titles_available');
  assert.equal(batch.template.components[0]?.parameters[0]?.text, 'Labyrinth (1986)\nThe Karate Kid (1984)');
});
