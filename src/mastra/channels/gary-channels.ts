import type { ChannelConfig, ChannelHandler } from '@mastra/core/channels';
import { createWebAdapter, type WebAdapter } from '@chat-adapter/web';
import type { Message, Thread } from 'chat';
import { adminName, serverName } from '../config/branding';
import { assertMutationAllowed, garyConfig, type GaryConfig } from '../config/gary-config';
import { claimGaryInboundEvent, type Caller } from '../services/gary-access-policy';
import { claimGaryNotificationDelivery, completeGaryNotificationDelivery, failGaryNotificationDelivery, type GaryDeliveryKind } from '../services/gary-notification-delivery-store';
import { createGaryWhatsAppAdapter, type GaryWhatsAppAdapter } from '../services/gary-whatsapp-adapter';
import { KeyedTaskQueue } from '../services/keyed-task-queue';
import {
  admins, CHANNEL_NAMES, enroll, identify, linkedIdentities, personForResource, resourceIdFor,
  type ChannelName, type GaryUser, type ResourceId,
} from './people';
import { GaryTelegramAdapter } from './telegram-adapter';
import { webUserFromRequest } from './web-session';

export type Notice =
  | { kind: 'media.available'; text: string; titles: string[] }
  | { kind: Exclude<GaryDeliveryKind, 'media.available'>; text: string };

export type Delivery =
  | { sent: true; reason: null; channel: ChannelName; messageId: string }
  | { sent: false; reason: string };

/** One admitted chat turn, handed to Gary's conversation logic after identity, replay and rate checks. */
export type GaryTurn = {
  thread: Thread;
  message: Message;
  person: GaryUser;
  channel: ChannelName;
  resourceId: ResourceId;
  firstTurn: boolean;
  runAgent: () => Promise<void>;
};

export type GaryConversation = {
  /** Runs once when a chat identity is linked by an enrollment code. */
  welcome(input: { thread: Thread; person: GaryUser; newUser: boolean; resourceId: ResourceId }): Promise<void>;
  converse(turn: GaryTurn): Promise<void>;
};

type Adapters = { web?: WebAdapter; telegram?: GaryTelegramAdapter; whatsapp?: GaryWhatsAppAdapter };

type ChannelRow<K extends ChannelName> = {
  create(config: GaryConfig): Adapters[K] | undefined;
  mastra: { streaming?: false; toolDisplay?: 'hidden' } | { streaming: true; toolDisplay?: 'hidden' };
  /** Platform sender id to the stable identity key; undefined rejects the sender. */
  externalId(authorUserId: string): string | undefined;
  /** Undefined when the channel cannot start a conversation (web replies only inside the user's own request). */
  proactive?: (adapter: NonNullable<Adapters[K]>, externalId: string, notice: Notice) => Promise<string>;
};

const CHANNELS: { [K in ChannelName]: ChannelRow<K> } = {
  web: {
    create: () => createWebAdapter({ userName: 'gary', getUser: webUserFromRequest }),
    mastra: { streaming: true, toolDisplay: 'hidden' },
    externalId: (id) => id || undefined,
  },
  telegram: {
    // Long polling consumes real updates, so a read-only preview never starts it.
    create: (config) => config.telegram && !config.readOnly
      ? new GaryTelegramAdapter({ botToken: config.telegram.botToken, mode: 'polling', userName: 'gary' })
      : undefined,
    mastra: { streaming: false, toolDisplay: 'hidden' },
    externalId: (id) => (/^\d+$/.test(id) ? id : undefined),
    proactive: async (adapter, externalId, notice) => (await adapter.postMessage(await adapter.openDM(externalId), notice.text)).id,
  },
  whatsapp: {
    create: (config) => config.whatsapp && !config.readOnly ? createGaryWhatsAppAdapter(config.whatsapp) : undefined,
    mastra: { streaming: false, toolDisplay: 'hidden' },
    externalId: (id) => id.replace(/\D/g, '') || undefined,
    proactive: (adapter, externalId, notice) => notice.kind === 'media.available'
      ? adapter.sendAvailabilityTemplate(externalId, notice.titles)
      : adapter.sendDirectText(externalId, notice.text),
  },
};

let built: { config: GaryConfig; adapters: Adapters } | undefined;

function adapters(): Adapters {
  const config = garyConfig();
  if (built?.config !== config) {
    built = {
      config,
      adapters: Object.fromEntries(CHANNEL_NAMES.flatMap((name) => {
        const adapter = CHANNELS[name].create(config);
        return adapter ? [[name, adapter]] : [];
      })),
    };
  }
  return built.adapters;
}

export function garyAdapter<K extends ChannelName>(name: K): Adapters[K] {
  return adapters()[name];
}

function isChannelName(value: unknown): value is ChannelName {
  return typeof value === 'string' && (CHANNEL_NAMES as readonly string[]).includes(value);
}

function senderKey(platform: string, authorUserId: string) {
  if (!isChannelName(platform)) return undefined;
  const externalId = CHANNELS[platform].externalId(authorUserId);
  return externalId ? { channel: platform, externalId } : undefined;
}

export function enrollmentPrompt() {
  return `I don't recognize this account yet. Send me the GARY- invite code you got from ${adminName()} to connect it to ${serverName()}.`;
}

function log(event: string, detail: Record<string, unknown>) {
  console.info(JSON.stringify({ event: `gary.channel.${event}`, ...detail }));
}

/**
 * The single handler for direct messages on every platform. An unidentified
 * sender only ever gets the enrollment prompt or a welcome; the agent runs for
 * identified people, one turn at a time per person across all of their
 * channels. Group threads are refused: Mastra fixes a thread's memory owner
 * when it creates the thread, so every later member would act as the first.
 */
export function garyInboundHandler(conversation: GaryConversation): ChannelHandler {
  const queue = new KeyedTaskQueue();
  return async (thread, message, defaultHandler) => {
    if (!thread.isDM) {
      log('denied', { platform: thread.adapter.name, messageId: message.id, reason: 'group_thread' });
      return;
    }
    const key = senderKey(thread.adapter.name, message.author.userId);
    if (!key) {
      log('denied', { platform: thread.adapter.name, messageId: message.id, reason: 'invalid_sender' });
      return;
    }
    const known = await identify(key);
    if (!known) {
      const attempt = await claimGaryInboundEvent({ channel: key.channel, eventId: message.id, actorKey: `${key.channel}:${key.externalId}` });
      if (!attempt.accepted) return;
      const outcome = await enroll(key, { kind: 'code', text: message.text });
      if (outcome.status === 'refused') {
        log('denied', { channel: key.channel, messageId: message.id, reason: outcome.reason });
        await thread.post(enrollmentPrompt());
        return;
      }
      log('enrolled', { channel: key.channel, userId: outcome.person.id, newUser: outcome.newUser });
      await conversation.welcome({ thread, person: outcome.person, newUser: outcome.newUser, resourceId: resourceIdFor(outcome.person.id) });
      return;
    }
    await queue.run(known.id, async () => {
      const claim = await claimGaryInboundEvent({ channel: key.channel, eventId: message.id, actorKey: known.id });
      if (!claim.accepted) {
        if (claim.reasonCode === 'hourly_inbound_quota_reached') await thread.post('I’m handling an unusual burst of messages from you. Give me a few minutes, then try again.');
        return;
      }
      await conversation.converse({
        thread, message, person: known, channel: key.channel,
        resourceId: resourceIdFor(known.id),
        firstTurn: claim.firstForActor,
        runAgent: () => defaultHandler(thread, message),
      });
    });
  };
}

export function garyChannelConfig(conversation: GaryConversation): ChannelConfig {
  const handler = garyInboundHandler(conversation);
  const configured = adapters();
  return {
    adapters: Object.fromEntries(CHANNEL_NAMES.flatMap((name) => {
      const adapter = configured[name];
      return adapter ? [[name, {
        adapter,
        ...CHANNELS[name].mastra,
        formatError: () => 'I hit a temporary problem while handling that. Please try again in a moment.',
      }]] : [];
    })),
    handlers: { onDirectMessage: handler, onMention: false, onSubscribedMessage: false },
    // Called only when Mastra creates a thread, which happens inside an admitted turn.
    resolveResourceId: async ({ platform, message }) => {
      const key = senderKey(platform, message.author.userId);
      const person = key && await identify(key);
      if (!person) throw new Error(`Refusing to create memory for an unidentified ${platform} sender`);
      return resourceIdFor(person.id);
    },
    chatOptions: { dedupeTtlMs: 10 * 60 * 1000 },
    inlineMedia: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'],
  };
}

type ToolContextLike = {
  agent?: { resourceId?: string; threadId?: string };
  requestContext?: { get: (key: string) => unknown };
};

export async function toolCaller(context: unknown): Promise<Caller | undefined> {
  const { agent, requestContext } = (context ?? {}) as ToolContextLike;
  const channel = requestContext?.get('channel') as { platform?: string; userId?: string; messageId?: string } | undefined;
  if (channel?.platform && channel.userId) {
    const key = senderKey(channel.platform, channel.userId);
    const person = key && await identify(key);
    return person && key ? { kind: 'person', person, channel: key.channel, eventId: channel.messageId } : undefined;
  }
  if (agent?.threadId?.startsWith('gary-radar:')) {
    const person = await personForResource(agent.resourceId);
    return person ? { kind: 'radar', person } : undefined;
  }
  return undefined;
}

/**
 * Sends one notice to one person: the preferred channel first, then any other
 * linked channel that can start a conversation. Every proactive message Gary
 * sends goes through here, behind the read-only guard.
 */
export async function deliverToUser(userId: GaryUser['id'], notice: Notice, options: { prefer?: ChannelName; idempotencyKey?: string; targetIds?: string[] } = {}): Promise<Delivery> {
  try {
    assertMutationAllowed('message');
  } catch (error) {
    return { sent: false, reason: (error as Error).message };
  }
  const configured = adapters();
  const reachable = (await linkedIdentities(userId))
    .filter((identity) => CHANNELS[identity.channel].proactive && configured[identity.channel])
    .sort((a, b) => Number(b.channel === options.prefer) - Number(a.channel === options.prefer));
  if (!reachable.length) return { sent: false, reason: 'No linked chat that Gary can message first (web chat only answers while you have it open)' };
  const { idempotencyKey } = options;
  if (idempotencyKey) {
    const claimed = await claimGaryNotificationDelivery({ idempotencyKey, resourceId: resourceIdFor(userId), channel: reachable[0].channel, kind: notice.kind, targetIds: options.targetIds });
    if (!claimed.claimed) return { sent: false, reason: `Notification already ${claimed.status}` };
  }
  const failures: string[] = [];
  for (const identity of reachable) {
    const send = CHANNELS[identity.channel].proactive as (adapter: unknown, externalId: string, notice: Notice) => Promise<string>;
    try {
      const messageId = await send(configured[identity.channel], identity.externalId, notice);
      if (idempotencyKey) await completeGaryNotificationDelivery(idempotencyKey, messageId);
      return { sent: true, reason: null, channel: identity.channel, messageId };
    } catch (error) {
      failures.push(`${identity.channel}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const reason = `Delivery failed (${failures.join('; ')})`;
  if (idempotencyKey) await failGaryNotificationDelivery(idempotencyKey, reason.slice(0, 500));
  return { sent: false, reason };
}

export async function deliverToAdmins(notice: Notice, options: { idempotencyKey?: string } = {}) {
  return Promise.all((await admins()).map((admin) => deliverToUser(admin.id, notice, {
    idempotencyKey: options.idempotencyKey && `${options.idempotencyKey}:${admin.id}`,
  })));
}

export async function callerActor(context: unknown) {
  const caller = await toolCaller(context);
  return { actorId: caller ? resourceIdFor(caller.person.id) : '', isAdmin: caller?.person.role === 'admin' };
}
