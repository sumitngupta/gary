import { getMediaRadarSubscription, updateMediaRadarSubscription } from './media-radar-subscription-store';
import { sendWhatsAppMediaRadar } from './whatsapp-media-radar-delivery';
import { assertMutationAllowed, garyConfig } from '../config/gary-config';

export { sendWhatsAppMediaRadar } from './whatsapp-media-radar-delivery';

function minutesInTimezone(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value || 0);
  return hour * 60 + minute;
}

function clockMinutes(value: string) {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

export function isMediaRadarQuietTime(subscription: { timezone: string; quietHours?: { start: string; end: string } }, date = new Date()) {
  if (!subscription.quietHours) return false;
  const current = minutesInTimezone(date, subscription.timezone);
  const start = clockMinutes(subscription.quietHours.start);
  const end = clockMinutes(subscription.quietHours.end);
  return start <= end ? current >= start && current < end : current >= start || current < end;
}

export async function deliverMediaRadar(scheduleId: string, text: string) {
  const subscription = await getMediaRadarSubscription(scheduleId);
  if (!subscription || !text.trim()) return { sent: false, reason: 'subscription or digest missing' };
  if (isMediaRadarQuietTime(subscription)) {
    await updateMediaRadarSubscription(subscription.id, { lastError: 'Delivery suppressed during quiet hours.' });
    return { sent: false, reason: 'quiet-hours' };
  }

  if (subscription.status !== 'active' || subscription.channel === 'none') return { sent: false, reason: 'inactive or no delivery channel' };
  assertMutationAllowed('message');

  if (subscription.channel === 'telegram') {
    const token = garyConfig().telegramBotToken;
    const chatId = subscription.resourceId.match(/^telegram:(.+)$/)?.[1];
    if (!token || !chatId) throw new Error('Telegram delivery is not configured for this radar.');
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text }),
    });
    const body = await response.json() as { ok?: boolean; result?: { message_id?: number } };
    if (!response.ok || !body.ok || !body.result?.message_id) throw new Error(`Telegram delivery was not accepted (HTTP ${response.status}).`);
  }

  if (subscription.channel === 'whatsapp') {
    await sendWhatsAppMediaRadar(subscription.resourceId, text);
  }

  await updateMediaRadarSubscription(subscription.id, { lastDeliveredAt: new Date().toISOString(), lastError: undefined });
  return { sent: true };
}
