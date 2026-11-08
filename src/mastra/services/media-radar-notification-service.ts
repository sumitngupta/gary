import { getMediaRadarSubscription, updateMediaRadarSubscription } from './media-radar-subscription-store';
import { deliverToUser } from '../channels/gary-channels';
import { userIdFromResource } from '../channels/people';

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
  const userId = userIdFromResource(subscription.resourceId);
  if (!userId) throw new Error('This radar does not belong to an enrolled Gary user.');
  const delivery = await deliverToUser(userId, { kind: 'media.radar', text }, { prefer: subscription.channel });
  if (!delivery.sent) throw new Error(delivery.reason);

  await updateMediaRadarSubscription(subscription.id, { lastDeliveredAt: new Date().toISOString(), lastError: undefined });
  return { sent: true };
}
