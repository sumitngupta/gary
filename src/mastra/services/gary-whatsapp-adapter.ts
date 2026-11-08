import { WhatsAppAdapter, type WhatsAppAdapterConfig } from '@chat-adapter/whatsapp';
import { ConsoleLogger } from 'chat';
import { deleteGaryMessageReference, getGaryMessageReference, rememberGaryMessageReference } from './gary-conversation-state-store';
import { attachPendingIntentProposalMessage, invalidatePendingIntentForMessage, recordWhatsAppEvent, resolvePendingIntent } from './gary-operations-store';

const GROUP_MARKER = 'group_';

function groupRecipient(value: string) {
  return value.startsWith(GROUP_MARKER) ? value.slice(GROUP_MARKER.length) : undefined;
}

export function garyWhatsAppResourceId(userId: string) {
  return `whatsapp:${userId}`;
}

export function garyWhatsAppRawReaction(inbound: any) {
  const targetMessageId = typeof inbound?.reaction?.message_id === 'string' ? inbound.reaction.message_id : undefined;
  if (!targetMessageId) return undefined;
  const emoji = typeof inbound?.reaction?.emoji === 'string' ? inbound.reaction.emoji : '';
  return { targetMessageId, emoji, added: emoji.length > 0 };
}

export function garyWhatsAppReferenceText(inbound: any, extracted?: string | null) {
  if (extracted?.trim()) return extracted.trim();
  const type = typeof inbound?.type === 'string' ? inbound.type : undefined;
  if (!type || !['image', 'video', 'audio', 'document', 'sticker'].includes(type)) return undefined;
  const caption = typeof inbound?.[type]?.caption === 'string' ? inbound[type].caption.trim().slice(0, 1_000) : '';
  const filename = type === 'document' && typeof inbound?.document?.filename === 'string' ? ` ${inbound.document.filename.slice(0, 240)}` : '';
  return `[WhatsApp ${type}${filename}]${caption ? ` ${caption}` : ''}`;
}

export function garyWhatsAppReactionPrompt(input: {
  emoji: string;
  added: boolean;
  targetText?: string;
  targetMessageId: string;
}) {
  const target = input.targetText?.trim()
    ? `Quoted message: ${JSON.stringify(input.targetText.trim().slice(0, 1200))}`
    : `Quoted message unavailable; target id: ${input.targetMessageId}`;
  return [
    `WhatsApp reaction ${input.added ? 'added' : 'removed'}: ${input.emoji || '(none)'}`,
    target,
    'Treat this as an acknowledgement by default. Interpret a positive or negative reaction as yes/no only if the quoted message contains one clear, still-pending binary question. Never use a reaction alone to approve a destructive, privacy-sensitive, purchase, or external-message action.',
  ].join('\n');
}

export function garyWhatsAppQuotedReplyPrompt(input: {
  replyText: string;
  targetText?: string;
  targetMessageId: string;
}) {
  const target = input.targetText?.trim()
    ? JSON.stringify(input.targetText.trim().slice(0, 1200))
    : `[unavailable message ${input.targetMessageId}]`;
  return `WhatsApp quoted reply to ${target}\nReply: ${input.replyText}`;
}

export const QUOTED_REPLY_BINDING_GUIDANCE = 'A target mismatch or ambiguity must only produce clarification, never an action. Status none means no structured proposal was stored; when the quoted target text is available, use that exact target to interpret the reply conversationally and follow the normal authorization and read-before-write gates without asking the user to repeat the same confirmation.';

export class GaryWhatsAppAdapter extends WhatsAppAdapter {
  private reactionHandlerRegistered = false;
  private readonly messageTextById = new Map<string, string>();

  private rememberMessage(id: string | undefined, text: string | undefined, threadId?: string, actorId?: string, direction: 'inbound' | 'outbound' = 'inbound') {
    if (!id || !text) return;
    this.messageTextById.set(id, text);
    if (this.messageTextById.size > 500) this.messageTextById.delete(this.messageTextById.keys().next().value!);
    if (threadId) void rememberGaryMessageReference({ threadId, messageId: id, actorId, direction, text }).catch((error) =>
      this.logger.warn('Could not persist WhatsApp message reference', { messageId: id, error: error instanceof Error ? error.message : String(error) }));
  }
  constructor(config: WhatsAppAdapterConfig & {
    accessToken: string;
    appSecret: string;
    phoneNumberId: string;
    verifyToken: string;
    userName: string;
  }) {
    super({
      ...config,
      logger: config.logger || new ConsoleLogger('info').child('whatsapp'),
    });
  }

  isReady() {
    return Boolean(this.chat);
  }

  override async initialize(chat: any) {
    await super.initialize(chat);
    if (this.reactionHandlerRegistered) return;
    this.reactionHandlerRegistered = true;
    chat.onReaction(async (event: any) => {
      let targetText: string | undefined = this.messageTextById.get(event.messageId);
      if (event.message?.text) {
        targetText = event.message.text;
      } else {
        for await (const candidate of event.thread.allMessages) {
          if (candidate.id === event.messageId) targetText = candidate.text;
        }
      }
      targetText ||= (await getGaryMessageReference(event.threadId, event.messageId))?.text;
      const rawMessage = event.raw?.message || {};
      const eventId = event.raw?.id || `reaction:${event.messageId}:${event.rawEmoji}:${event.added ? 'add' : 'remove'}`;
      const accepted = await recordWhatsAppEvent({ eventId, threadId: event.threadId, targetMessageId: event.messageId, eventType: event.added ? 'reaction-add' : 'reaction-remove', timestamp: Number(event.raw?.timestamp || Math.floor(Date.now() / 1000)), payload: { emoji: event.rawEmoji } });
      if (!accepted.accepted) return;
      const binding = event.added ? await resolvePendingIntent(event.threadId, event.rawEmoji, event.messageId, 'reaction') : { status: 'not-applicable' };
      const inbound = {
        ...rawMessage,
        id: rawMessage.id || eventId,
        from: rawMessage.from || event.user.userId,
        timestamp: rawMessage.timestamp || String(Math.floor(Date.now() / 1000)),
        type: 'text',
        text: { body: `${garyWhatsAppReactionPrompt({
          emoji: event.rawEmoji,
          added: event.added,
          targetText,
          targetMessageId: event.messageId,
        })}\nDeterministic reaction binding: ${JSON.stringify(binding)}.` },
      };
      const message = this.buildMessage(inbound, undefined, event.threadId, inbound.text.body, this.phoneNumberId);
      await this.chat?.processMessage(this, event.threadId, message);
    });
  }

  protected override handleInboundMessage(inbound: any, contact: any, phoneNumberId: string, options?: any) {
    const decodedThreadId = this.encodeThreadId({ phoneNumberId, userWaId: inbound.from });
    if (inbound?.type === 'edited' || inbound?.type === 'deleted') {
      void this.handleMessageMutation(inbound, decodedThreadId);
      return;
    }
    if (inbound?.type === 'reaction') {
      void this.handleRawReaction(inbound, contact, phoneNumberId, decodedThreadId, options);
      return;
    }
    void recordWhatsAppEvent({ eventId: inbound.id, threadId: decodedThreadId, eventType: 'message', timestamp: Number(inbound.timestamp || Math.floor(Date.now() / 1000)), payload: { type: inbound.type } });
    this.rememberMessage(inbound?.id, garyWhatsAppReferenceText(inbound, this.extractTextContent(inbound)), decodedThreadId, inbound.from, 'inbound');
    const groupId = typeof inbound?.group_id === 'string' ? inbound.group_id : undefined;
    if (!groupId) {
      const quotedMessageId = typeof inbound?.context?.id === 'string' ? inbound.context.id : undefined;
      if (!quotedMessageId || inbound.type === 'reaction') return super.handleInboundMessage(inbound, contact, phoneNumberId, options);
      void this.handleQuotedInboundMessage(inbound, contact, phoneNumberId, quotedMessageId, options);
      return;
    }
    if (process.env.GARY_WHATSAPP_GROUPS_ENABLED !== 'true') {
      this.logger.info('WhatsApp group message ignored while group support is disabled', {
        groupId,
        messageId: inbound.id,
      });
      return;
    }
    if (!this.chat) throw new Error('WhatsApp adapter is not initialized');
    const text = this.extractTextContent(inbound);
    if (text === null) return;
    const threadId = this.encodeThreadId({ phoneNumberId, userWaId: `${GROUP_MARKER}${groupId}` });
    const message = this.buildMessage(inbound, contact, threadId, text, phoneNumberId);
    this.chat.processMessage(this, threadId, message, options);
  }

  private async handleRawReaction(inbound: any, contact: any, phoneNumberId: string, threadId: string, options?: any) {
    if (!this.chat) return;
    const reaction = garyWhatsAppRawReaction(inbound);
    if (!reaction) return;
    const { targetMessageId, emoji, added } = reaction;
    const accepted = await recordWhatsAppEvent({ eventId: inbound.id, threadId, targetMessageId, eventType: added ? 'reaction-add' : 'reaction-remove', timestamp: Number(inbound.timestamp || Math.floor(Date.now() / 1000)), payload: { emoji } });
    if (!accepted.accepted) return;
    const targetText = this.messageTextById.get(targetMessageId) || (await getGaryMessageReference(threadId, targetMessageId))?.text;
    const binding = added ? await resolvePendingIntent(threadId, emoji, targetMessageId, 'reaction') : { status: 'not-applicable' };
    const body = `${garyWhatsAppReactionPrompt({ emoji, added, targetText, targetMessageId })}\nDeterministic reaction binding: ${JSON.stringify(binding)}.`;
    const synthetic = { ...inbound, type: 'text', text: { body } };
    const message = this.buildMessage(synthetic, contact, threadId, body, phoneNumberId);
    await this.chat.processMessage(this, threadId, message, options);
  }

  private async handleMessageMutation(inbound: any, threadId: string) {
    const targetMessageId = inbound.edited?.message_id || inbound.deleted?.message_id || inbound.context?.id;
    if (!targetMessageId) return;
    const eventType = inbound.type === 'deleted' ? 'delete' as const : 'edit' as const;
    const result = await recordWhatsAppEvent({ eventId: inbound.id, threadId, targetMessageId, eventType, timestamp: Number(inbound.timestamp || Math.floor(Date.now() / 1000)), payload: eventType === 'edit' ? { text: inbound.edited?.text?.body || inbound.text?.body || '' } : {} });
    if (!result.accepted) return;
    if (eventType === 'delete') {
      this.messageTextById.delete(targetMessageId);
      await Promise.all([
        deleteGaryMessageReference(threadId, targetMessageId),
        invalidatePendingIntentForMessage(threadId, targetMessageId, 'deleted'),
      ]);
      return;
    }
    const replacement = inbound.edited?.text?.body || inbound.text?.body;
    if (replacement) this.rememberMessage(targetMessageId, replacement, threadId, inbound.from, 'inbound');
  }

  private async handleQuotedInboundMessage(inbound: any, contact: any, phoneNumberId: string, quotedMessageId: string, options?: any) {
    if (!this.chat) return;
    const text = this.extractTextContent(inbound);
    if (text === null) return;
    const threadId = this.encodeThreadId({ phoneNumberId, userWaId: inbound.from });
    const targetText = this.messageTextById.get(quotedMessageId)
      || (await getGaryMessageReference(threadId, quotedMessageId))?.text;
    const binding = await resolvePendingIntent(threadId, text, quotedMessageId, 'quoted-reply');
    const contextualText = `${garyWhatsAppQuotedReplyPrompt({ replyText: text, targetText, targetMessageId: quotedMessageId })}\nDeterministic quoted-reply binding: ${JSON.stringify(binding)}. ${QUOTED_REPLY_BINDING_GUIDANCE}`;
    const message = this.buildMessage(inbound, contact, threadId, contextualText, phoneNumberId);
    await this.chat.processMessage(this, threadId, message, options);
  }

  override async fetchThread(threadId: string) {
    const decoded = this.decodeThreadId(threadId);
    const groupId = groupRecipient(decoded.userWaId);
    if (!groupId) return super.fetchThread(threadId);
    return {
      id: threadId,
      channelId: `whatsapp:${decoded.phoneNumberId}`,
      channelName: `WhatsApp group: ${groupId}`,
      isDM: false,
      metadata: { phoneNumberId: decoded.phoneNumberId, groupId },
    };
  }

  protected override async sendSingleTextMessage(threadId: string, to: string, text: string) {
    const groupId = groupRecipient(to);
    if (!groupId) {
      const result = await super.sendSingleTextMessage(threadId, to, text);
      this.rememberMessage(result.id, text, threadId, to, 'outbound');
      await attachPendingIntentProposalMessage(threadId, result.id, text);
      return result;
    }
    const response = await this.graphApiRequest<{ messages?: Array<{ id?: string }> }>(
      `/${this.phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'group',
        to: groupId,
        type: 'text',
        text: { preview_url: false, body: text },
      },
    );
    const messageId = response.messages?.[0]?.id;
    if (!messageId) throw new Error('WhatsApp API did not return a group message ID');
    const result = {
      id: messageId,
      threadId,
      raw: {
        message: {
          id: messageId,
          from: this.phoneNumberId,
          group_id: groupId,
          timestamp: String(Math.floor(Date.now() / 1_000)),
          type: 'text',
          text: { body: text },
        } as any,
        phoneNumberId: this.phoneNumberId,
      },
    };
    this.rememberMessage(result.id, text, threadId, groupId, 'outbound');
    await attachPendingIntentProposalMessage(threadId, result.id, text);
    return result;
  }
}

export function createGaryWhatsAppAdapter(config: ConstructorParameters<typeof GaryWhatsAppAdapter>[0]) {
  return new GaryWhatsAppAdapter(config);
}
