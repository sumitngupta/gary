import assert from 'node:assert/strict';
import test from 'node:test';
import { GaryWhatsAppAdapter, QUOTED_REPLY_BINDING_GUIDANCE, garyWhatsAppQuotedReplyPrompt, garyWhatsAppRawReaction, garyWhatsAppReactionPrompt, garyWhatsAppReferenceText, garyWhatsAppResourceId } from './gary-whatsapp-adapter';

class TestAdapter extends GaryWhatsAppAdapter {
  calls: Array<{ path: string; body: unknown }> = [];
  protected override async graphApiRequest<T>(path: string, body: unknown): Promise<T> {
    this.calls.push({ path, body });
    return { messages: [{ id: 'wamid.group.reply' }] } as T;
  }
  sendText(threadId: string, to: string, text: string) {
    return this.sendSingleTextMessage(threadId, to, text);
  }
}

function adapter() {
  return new TestAdapter({
    accessToken: 'test', appSecret: 'test', phoneNumberId: 'phone-1',
    verifyToken: 'test', userName: 'gary',
  });
}

test('represents a WhatsApp group as a non-DM thread', async () => {
  const value = adapter();
  const thread = await value.fetchThread('whatsapp:phone-1:group_group-123');
  assert.equal(thread.isDM, false);
  assert.equal(thread.metadata.groupId, 'group-123');
});

test('uses the Chat SDK sender id for the WhatsApp memory resource', () => {
  assert.equal(garyWhatsAppResourceId('15550100002'), 'whatsapp:15550100002');
});

test('sends group replies with the group recipient type', async () => {
  const value = adapter();
  const result = await value.sendText('whatsapp:phone-1:group_group-123', 'group_group-123', 'Hello group');
  assert.equal(result.id, 'wamid.group.reply');
  assert.deepEqual(value.calls[0], {
    path: '/phone-1/messages',
    body: {
      messaging_product: 'whatsapp', recipient_type: 'group', to: 'group-123',
      type: 'text', text: { preview_url: false, body: 'Hello group' },
    },
  });
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
