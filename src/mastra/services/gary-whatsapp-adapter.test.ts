import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GaryWhatsAppAdapter, QUOTED_REPLY_BINDING_GUIDANCE, garyWhatsAppQuotedReplyPrompt, garyWhatsAppRawReaction, garyWhatsAppReactionPrompt, garyWhatsAppReferenceText, whatsappAvailabilityTemplatePayload } from './gary-whatsapp-adapter';

class TestAdapter extends GaryWhatsAppAdapter {
  receive(inbound: Record<string, unknown>) {
    const processed: Array<{ threadId: string; text: string }> = [];
    (this as unknown as { chat: unknown }).chat = { processMessage: (_adapter: unknown, threadId: string, message: { text: string }) => { processed.push({ threadId, text: message.text }); } };
    this.handleInboundMessage(inbound, { wa_id: inbound.from, profile: { name: 'Alice' } }, 'phone-1');
    return processed;
  }
}

function adapter() {
  return new TestAdapter({
    accessToken: 'test', appSecret: 'test', phoneNumberId: 'phone-1',
    verifyToken: 'test', userName: 'gary',
  });
}

test('a WhatsApp group message is dropped while the same sender\'s direct message goes through', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gary-whatsapp-'));
  const prior = process.env.GARY_DATA_DIR;
  process.env.GARY_DATA_DIR = dir;
  t.after(async () => {
    process.env.GARY_DATA_DIR = prior;
    await rm(dir, { recursive: true, force: true });
  });
  const text = (id: string, extra = {}) => ({ id, from: '15550001111', timestamp: '1', type: 'text', text: { body: 'Is Arrival available?' }, ...extra });
  assert.deepEqual(adapter().receive(text('wamid.group', { group_id: 'group-123' })), []);
  assert.deepEqual(adapter().receive(text('wamid.direct')), [{ threadId: 'whatsapp:phone-1:15550001111', text: 'Is Arrival available?' }]);
});

test('selects single and batch WhatsApp availability templates deterministically', () => {
  const templates = { mediaAvailable: 'gary_media_available', mediaBatch: 'gary_tracked_titles_available' };
  assert.equal(whatsappAvailabilityTemplatePayload('15550001111', ['Labyrinth (1986)'], templates).template.name, 'gary_media_available');
  const batch = whatsappAvailabilityTemplatePayload('15550001111', ['Labyrinth (1986)', 'The Karate Kid (1984)'], templates);
  assert.equal(batch.template.name, 'gary_tracked_titles_available');
  assert.equal(batch.template.components[0]?.parameters[0]?.text, 'Labyrinth (1986); The Karate Kid (1984)');
});

test('reaction context is target-bound and conservative about approval', () => {
  const prompt = garyWhatsAppReactionPrompt({
    emoji: '👍', added: true, targetMessageId: 'wamid.question',
    targetText: 'Should I request The Karate Kid (1984)?',
  });
  assert.match(prompt, /Karate Kid/);
  assert.match(prompt, /one clear, still-pending binary question/);
  assert.match(prompt, /Never use a reaction alone/);
});

test('raw Meta reaction add and remove payloads preserve the target', () => {
  assert.deepEqual(garyWhatsAppRawReaction({ reaction: { message_id: 'wamid.question', emoji: '👍' } }), { targetMessageId: 'wamid.question', emoji: '👍', added: true });
  assert.deepEqual(garyWhatsAppRawReaction({ reaction: { message_id: 'wamid.question', emoji: '' } }), { targetMessageId: 'wamid.question', emoji: '', added: false });
  assert.equal(garyWhatsAppRawReaction({ type: 'text' }), undefined);
});

test('quoted replies carry both the target and the new answer', () => {
  const prompt = garyWhatsAppQuotedReplyPrompt({
    replyText: 'B', targetMessageId: 'wamid.options',
    targetText: 'A: check first. B: request all missing titles.',
  });
  assert.match(prompt, /request all missing titles/);
  assert.match(prompt, /Reply: B/);
  assert.match(QUOTED_REPLY_BINDING_GUIDANCE, /without asking the user to repeat/);
  assert.match(QUOTED_REPLY_BINDING_GUIDANCE, /authorization and read-before-write gates/);
});

test('quoted media is retained as bounded context without retaining the media payload', () => {
  assert.equal(garyWhatsAppReferenceText({ type: 'image', image: { id: 'private-media-id', caption: 'Which movie is this?' } }), '[WhatsApp image] Which movie is this?');
  assert.equal(garyWhatsAppReferenceText({ type: 'document', document: { id: 'private-id', filename: 'watchlist.pdf' } }), '[WhatsApp document watchlist.pdf]');
  assert.equal(garyWhatsAppReferenceText({ type: 'audio', audio: { id: 'private-audio' } }), '[WhatsApp audio]');
});

test('availability template text never contains newlines, tabs or long space runs', () => {
  const templates = { mediaAvailable: 'one', mediaBatch: 'many' };
  const payload = whatsappAvailabilityTemplatePayload('15550001111', ['Love,\tActually  (2003)', 'Up\n(2009)', 'Heat      (1995)'], templates);
  assert.equal(payload.template.components[0]?.parameters[0]?.text, 'Love, Actually (2003); Up (2009); Heat (1995)');
});
