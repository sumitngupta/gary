import assert from 'node:assert/strict';
import test from 'node:test';
import { isMediaRadarQuietTime, sendWhatsAppMediaRadar } from './media-radar-notification-service';

test('media radar quiet hours handle same-day and overnight windows', () => {
  const noonUtc = new Date('2026-07-15T12:00:00.000Z');
  assert.equal(isMediaRadarQuietTime({ timezone: 'Etc/UTC', quietHours: { start: '09:00', end: '17:00' } }, noonUtc), true);
  assert.equal(isMediaRadarQuietTime({ timezone: 'Etc/UTC', quietHours: { start: '22:00', end: '07:00' } }, noonUtc), false);
  const lateUtc = new Date('2026-07-15T23:00:00.000Z');
  assert.equal(isMediaRadarQuietTime({ timezone: 'Etc/UTC', quietHours: { start: '22:00', end: '07:00' } }, lateUtc), true);
});

test('sends a WhatsApp radar to its allowlisted owner', async () => {
  const originalFetch = globalThis.fetch;
  const originalUsers = process.env.GARY_WHATSAPP_ALLOWED_USERS;
  const originalToken = process.env.GARY_WHATSAPP_ACCESS_TOKEN;
  const originalPhoneId = process.env.GARY_WHATSAPP_PHONE_NUMBER_ID;
  process.env.GARY_WHATSAPP_ALLOWED_USERS = '15550001111';
  process.env.GARY_WHATSAPP_ACCESS_TOKEN = 'test-token';
  process.env.GARY_WHATSAPP_PHONE_NUMBER_ID = 'phone-id';
  let requestBody: unknown;
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.radar' }] }), { status: 200 });
  }) as typeof fetch;
  try {
    assert.equal(await sendWhatsAppMediaRadar('whatsapp:15550001111', 'Fresh picks'), 'wamid.radar');
    assert.deepEqual(requestBody, {
      messaging_product: 'whatsapp', recipient_type: 'individual', to: '15550001111',
      type: 'text', text: { preview_url: false, body: 'Fresh picks' },
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
