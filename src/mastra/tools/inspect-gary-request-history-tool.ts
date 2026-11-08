import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { listMediaAvailabilityWatches } from '../services/media-availability-watch-store';
import { listGaryNotificationDeliveriesForTarget } from '../services/gary-notification-delivery-store';

const normalized = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export const inspectGaryRequestHistoryTool = createTool({
  id: 'inspect-gary-request-history',
  description: 'Privately inspect the current user’s tracked request and notification history. Explain missed notifications using recorded receipts. Observed availability times are not exact import times. Never retries or changes a request.',
  inputSchema: z.object({ title: z.string().min(1).optional(), year: z.number().int().optional(), limit: z.number().int().min(1).max(20).default(10) }),
  execute: async (input, context) => {
    const resourceId = context.agent?.resourceId;
    if (!resourceId) return { status: 'unavailable', summary: 'A verified user context is required.', history: [] };
    const watches = (await listMediaAvailabilityWatches()).filter((watch) => watch.resourceId === resourceId
      && (!input.title || normalized(watch.title) === normalized(input.title))
      && (input.year === undefined || watch.year === input.year))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, input.limit);
    const history = await Promise.all(watches.map(async (watch) => {
      const rows = await listGaryNotificationDeliveriesForTarget(resourceId, watch.id);
      const notifications = rows.map((row) => ({
        kind: String(row.kind), status: String(row.status), attempts: Number(row.attempt_count),
        firstAttemptAt: String(row.created_at), sentAt: row.sent_at || undefined,
        deliveredAt: row.delivered_at || undefined, readAt: row.read_at || undefined, failedAt: row.failed_at || undefined,
      }));
      const availabilityAttempt = notifications.find((row) => row.kind === 'media.available');
      const observedAvailableAt = availabilityAttempt?.firstAttemptAt
        || (watch.lastSnapshot?.availableInLibrary ? watch.lastSnapshot.checkedAt : undefined);
      const elapsed = observedAvailableAt ? Date.parse(observedAvailableAt) - Date.parse(watch.createdAt) : NaN;
      return {
        title: watch.title, year: watch.year, seasonNumber: watch.seasonNumber,
        trackingStartedAt: watch.createdAt, trackingStatus: watch.status,
        notificationRequested: watch.channel !== 'none',
        currentlyAvailable: watch.lastSnapshot?.availableInLibrary,
        lastCheckedAt: watch.lastCheckedAt, observedAvailableAt,
        observedWaitSeconds: Number.isFinite(elapsed) && elapsed >= 0 ? Math.round(elapsed / 1000) : undefined,
        timingNote: 'Tracking start and recorded availability observations bound the wait; these are not exact request or import timestamps.',
        notificationProblem: notifications.some((row) => row.status === 'failed') || watch.lastNotificationError
          ? 'A notification attempt failed. No successful delivery should be claimed without a receipt.' : undefined,
        notifications,
      };
    }));
    return { status: 'completed', summary: history.length ? 'Found your recorded tracking history.' : 'No matching tracking history was recorded for your account.', history };
  },
});
