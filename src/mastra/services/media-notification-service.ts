import { createHash } from 'node:crypto';
import type { MediaAvailabilityWatch } from '../schemas/media-availability-watch';
import { claimGaryNotificationDelivery, completeGaryNotificationDelivery, failGaryNotificationDelivery } from './gary-notification-delivery-store';
import { isGaryWhatsAppActorAuthorized } from './gary-access-policy';
import { serverName } from '../config/branding';

type MediaNotificationDelivery = {
  sent: boolean;
  reason: string | null;
  telegramMessageId?: number;
  whatsappMessageId?: string;
};

function telegramChatIdFromResource(resourceId: string) {
  const match = resourceId.match(/^telegram:(.+)$/);
  return match?.[1];
}

function whatsappUserIdFromResource(resourceId: string) {
  return resourceId.match(/^whatsapp:(\d+)$/)?.[1];
}

function supervisorWhatsAppUserId() {
  return (process.env.GARY_ADMIN_WHATSAPP || '').replace(/\D/g, '');
}

type AvailableWatch = Pick<MediaAvailabilityWatch, 'title' | 'year' | 'seasonNumber'> & Partial<Pick<MediaAvailabilityWatch, 'lastSnapshot'>>;

function completedSeasonCount(watch: AvailableWatch) {
  return watch.seasonNumber === undefined ? watch.lastSnapshot?.tvCompleteness?.seasons.length || 0 : 0;
}

export function mediaAvailableMessage(watch: AvailableWatch) {
  const seasonText = watch.seasonNumber !== undefined ? ` season ${watch.seasonNumber}` : '';
  const yearText = watch.year ? ` (${watch.year})` : '';
  const seasons = completedSeasonCount(watch);
  if (seasons > 1) return `All ${seasons} seasons of ${watch.title}${yearText} are now available in ${serverName()}.`;
  return `${watch.title}${yearText}${seasonText} is now available in ${serverName()}.`;
}

export function mediaAvailableTitle(watch: AvailableWatch) {
  const seasonText = watch.seasonNumber !== undefined ? ` season ${watch.seasonNumber}` : '';
  const yearText = watch.year ? ` (${watch.year})` : '';
  const seasons = completedSeasonCount(watch);
  return `${watch.title}${yearText}${seasons > 1 ? ` (all ${seasons} seasons)` : seasonText}`;
}

export function mediaAvailableBatchMessage(watches: AvailableWatch[]) {
  return `These titles are now available in ${serverName()}:\n${watches.map((watch) => `• ${mediaAvailableTitle(watch)}`).join('\n')}`;
}

export function whatsappAvailabilityTemplatePayload(to: string, watches: MediaAvailabilityWatch[]) {
  const name = watches.length > 1
    ? process.env.GARY_WHATSAPP_MEDIA_BATCH_TEMPLATE || 'gary_tracked_titles_available'
    : process.env.GARY_WHATSAPP_MEDIA_AVAILABLE_TEMPLATE || 'gary_media_available';
  return {
    messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template',
    template: {
      name,
      language: { code: 'en_US' },
      components: [{ type: 'body', parameters: [{ type: 'text', text: watches.map(mediaAvailableTitle).join('\n') }] }],
    },
  };
}

export function mediaIssueMessage(
  watch: Pick<MediaAvailabilityWatch, 'title' | 'year' | 'seasonNumber'>,
  issue: string,
) {
  const seasonText = watch.seasonNumber !== undefined ? ` season ${watch.seasonNumber}` : '';
  const yearText = watch.year ? ` (${watch.year})` : '';
  return `${watch.title}${yearText}${seasonText} needs attention in ${serverName()}: ${issue}.`;
}

export function supervisorMediaIssueMessage(
  watch: Pick<MediaAvailabilityWatch, 'title' | 'year' | 'seasonNumber' | 'requester'>,
  issue: string,
) {
  const requester = watch.requester ? ` for ${watch.requester}` : '';
  return `Gary watch${requester}: ${mediaIssueMessage(watch, issue)}`;
}

export async function sendAvailabilityMessage(
  watch: MediaAvailabilityWatch,
  text: string,
  options?: { idempotencyKey?: string; kind?: 'media.available' | 'media.issue'; watches?: MediaAvailabilityWatch[] },
): Promise<MediaNotificationDelivery> {
  const idempotencyKey = options?.idempotencyKey;
  if (idempotencyKey) {
    const claimed = await claimGaryNotificationDelivery({ idempotencyKey, resourceId: watch.resourceId, channel: watch.channel, kind: options?.kind || 'media.available', targetIds: options?.watches?.map((item) => item.id) || [watch.id] });
    if (!claimed.claimed) return { sent: false, reason: `Notification already ${claimed.status}` };
  }
  const fail = async (reason: string): Promise<MediaNotificationDelivery> => {
    if (idempotencyKey) await failGaryNotificationDelivery(idempotencyKey, reason);
    return { sent: false, reason };
  };
  if (watch.channel === 'whatsapp') {
    const to = whatsappUserIdFromResource(watch.resourceId);
    const accessToken = process.env.GARY_WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.GARY_WHATSAPP_PHONE_NUMBER_ID;
    const graphVersion = process.env.GARY_WHATSAPP_GRAPH_VERSION || 'v25.0';
    if (!to || !await isGaryWhatsAppActorAuthorized(to)) {
      return fail('WhatsApp notification target is not allowlisted');
    }
    if (!accessToken || !phoneNumberId) {
      return fail('WhatsApp notification delivery is not configured');
    }
    const availabilityWatches = options?.kind === 'media.available' ? options.watches || [watch] : undefined;
    const response = await fetch(`https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(availabilityWatches ? whatsappAvailabilityTemplatePayload(to, availabilityWatches) : {
        messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text',
        text: { preview_url: false, body: text },
      }),
    });
    const body = await response.json().catch(() => undefined) as {
      messages?: Array<{ id?: string }>;
      error?: { message?: string; code?: number };
    } | undefined;
    const messageId = body?.messages?.[0]?.id;
    if (!response.ok || !messageId) {
      return fail(`WhatsApp delivery failed: ${body?.error?.message || `HTTP ${response.status}`}`);
    }
    if (idempotencyKey) await completeGaryNotificationDelivery(idempotencyKey, messageId);
    return { sent: true, reason: null, whatsappMessageId: messageId };
  }

  if (watch.channel !== 'telegram') {
    return fail(`Unsupported notification channel: ${watch.channel}`);
  }

  const botToken = process.env.GARY_TELEGRAM_BOT_TOKEN;
  const chatId = telegramChatIdFromResource(watch.resourceId);

  if (!botToken || !chatId) {
    return fail('Telegram bot token or Telegram chat id was not available');
  }

  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
    }),
  });

  if (!response.ok) {
    return fail(`Telegram returned HTTP ${response.status}`);
  }
  const body = await response.json().catch(() => undefined) as { result?: { message_id?: number } } | undefined;

  const telegramMessageId = body?.result?.message_id;
  if (idempotencyKey && telegramMessageId !== undefined) await completeGaryNotificationDelivery(idempotencyKey, String(telegramMessageId));
  return {
    sent: true,
    reason: null,
    telegramMessageId,
  };
}

export async function sendMediaAvailableNotification(input: MediaAvailabilityWatch | MediaAvailabilityWatch[]) {
  const watches = Array.isArray(input) ? input : [input];
  const watch = watches[0];
  if (!watch) return { sent: false, reason: 'No availability watches to notify' };
  const summary = watches.length > 1 ? mediaAvailableBatchMessage(watches) : mediaAvailableMessage(watch);
  const batchKey = createHash('sha256').update(watches.map((item) => item.id).sort().join('|')).digest('hex').slice(0, 24);
  return await sendAvailabilityMessage(watch, summary, { idempotencyKey: `media.available:${batchKey}`, kind: 'media.available', watches });
}

export async function sendMediaIssueNotification(watch: MediaAvailabilityWatch, issue: string) {
  const supervisor = supervisorWhatsAppUserId();
  if (!supervisor) {
    return { sent: false, reason: 'Gary supervisor WhatsApp is not configured' };
  }

  const summary = supervisorMediaIssueMessage(watch, issue);
  const supervisorWatch: MediaAvailabilityWatch = {
    ...watch,
    resourceId: `whatsapp:${supervisor}`,
    threadId: `whatsapp:${supervisor}`,
    channel: 'whatsapp',
  };
  const hours = Number(process.env.GARY_STALLED_ALERT_COOLDOWN_HOURS || '6');
  const cooldownMs = (Number.isFinite(hours) && hours > 0 ? hours : 6) * 3_600_000;
  const bucket = Math.floor(Date.now() / cooldownMs);
  return await sendAvailabilityMessage(supervisorWatch, summary, {
    idempotencyKey: `media.issue:${watch.id}:${issue}:${bucket}`,
    kind: 'media.issue',
  });
}
