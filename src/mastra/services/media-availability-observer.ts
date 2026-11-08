import { checkPlexTitleAvailability } from './plex-readonly-client';
import { getRadarrMovieStatus, getSonarrSeriesStatus } from './arr-readonly-client';
import {
  listDueMediaAvailabilityWatches,
  updateMediaAvailabilityWatch,
} from './media-availability-watch-store';
import { sendMediaAvailableNotification, sendMediaIssueNotification } from './media-notification-service';
import type { Delivery } from '../channels/gary-channels';
import type {
  MediaAvailabilityWatch,
  MediaAvailabilityWatchSnapshot,
  MediaAvailabilityWatchSweepOutput,
} from '../schemas/media-availability-watch';
import { appendOperationEvent } from './gary-operations-store';
import { listSeerrMedia, listSeerrRequests } from './seerr-readonly-client';
import { recoverApprovedTargetFromCollectionPack } from './collection-pack-repair';
import { partialTvDetail, tvCompleteness } from './sonarr-season-summary';
import { serverName } from '../config/branding';
import { garyConfig } from '../config/gary-config';

type SonarrSeriesStatus = Awaited<ReturnType<typeof getSonarrSeriesStatus>>;

type QueueSnapshot = {
  status?: MediaAvailabilityWatchSnapshot['status'];
  progress?: number;
  timeLeft?: string;
  issue?: string;
  imported?: boolean;
};

export function classifyMediaLifecycle(input: { availableInLibrary: boolean; imported?: boolean; queueStatus?: QueueSnapshot['status']; mediaStatus?: number; requestStatus?: number; hasRequest: boolean }): MediaAvailabilityWatchSnapshot['status'] {
  if (input.availableInLibrary) return 'available';
  if (input.imported) return 'imported';
  if (input.queueStatus) return input.queueStatus;
  if (input.mediaStatus === 3 || (input.hasRequest && input.requestStatus !== 1)) return 'approved';
  if (input.hasRequest) return 'requested';
  return 'not-available';
}

function queueSnapshotFromItems(queueItems: Array<{
  status?: string;
  trackedDownloadStatus?: string;
  trackedDownloadState?: string;
  progress?: number;
  timeleft?: string;
  errorMessage?: string;
  statusMessages?: Array<{ title?: string; messages?: string[] }>;
}>) {
  const first = queueItems[0];
  if (!first) {
    return {};
  }

  const statusMessage = first.statusMessages
    ?.flatMap((entry) => entry.messages || [])
    .find(Boolean);
  const stateText = `${first.status || ''} ${first.trackedDownloadStatus || ''} ${first.trackedDownloadState || ''} ${first.errorMessage || ''} ${statusMessage || ''}`;
  const importBlocked = /importblocked|manual import required/i.test(stateText);
  const status = /fail|failed/i.test(stateText)
    ? 'failed'
    : importBlocked || /stall|warning|error/i.test(stateText)
      ? 'stalled'
      : 'downloading';

  return {
    status,
    progress: first.progress,
    timeLeft: first.timeleft,
    issue: first.errorMessage
      || statusMessage
      || (importBlocked
        ? 'download completed but requires a manual import'
        : status === 'stalled'
          ? 'download appears stalled'
          : status === 'failed'
            ? 'download failed'
            : undefined),
  } satisfies QueueSnapshot;
}

export const queueSnapshotForTest = queueSnapshotFromItems;

async function queueSnapshot(watch: MediaAvailabilityWatch, sonarr?: SonarrSeriesStatus): Promise<QueueSnapshot> {
  if (watch.mediaType === 'movie') {
    const result = await getRadarrMovieStatus({
      query: watch.title,
      year: watch.year,
      tmdbId: watch.tmdbId,
    });
    const first = result?.queueItems?.[0];
    if (first && /importblocked/i.test(first.trackedDownloadState || '')) {
      try {
        const recovery = await recoverApprovedTargetFromCollectionPack({
          title: watch.title,
          year: watch.year,
          tmdbId: watch.tmdbId,
          queueItem: first,
          correlationId: watch.correlationId || watch.id,
        });
        if (recovery?.status === 'started') {
          const extraText = recovery.extras.length
            ? ` The pack also contains ${recovery.extras.length} additional exact title${recovery.extras.length === 1 ? '' : 's'}; the owner can reply yes to the pending Gary approval to import all of them.`
            : '';
          return { status: 'stalled', issue: `The approved target was recovered with a guarded manual import.${extraText}` };
        }
      } catch (error) {
        console.warn(JSON.stringify({ event: 'gary.collection-pack-auto-repair-failed', watchId: watch.id, error: error instanceof Error ? error.message : String(error) }));
      }
    }
    return { ...queueSnapshotFromItems(result?.queueItems || []), imported: Boolean(result?.movie?.hasFile) };
  }

  if (watch.mediaType === 'tv') {
    const result = sonarr ?? await getSonarrSeriesStatus({
      query: watch.title,
      year: watch.year,
      tmdbId: watch.tmdbId,
    });
    const items = watch.seasonNumber === undefined
      ? result?.queueItems || []
      : (result?.queueItems || []).filter((item) => item.episode?.seasonNumber === watch.seasonNumber);
    const snapshot = queueSnapshotFromItems(items);
    return { ...snapshot, imported: !items.length && Boolean(result?.series?.statistics?.episodeFileCount) };
  }

  return {};
}

async function snapshotAvailability(watch: MediaAvailabilityWatch): Promise<MediaAvailabilityWatchSnapshot> {
  const checkedAt = new Date().toISOString();

  try {
    const availability = await checkPlexTitleAvailability({
      query: watch.title,
      mediaType: watch.mediaType,
      year: watch.year,
      seasonNumber: watch.seasonNumber,
    });
    const sonarr = watch.mediaType === 'tv' && availability.streamable
      ? await getSonarrSeriesStatus({ query: watch.title, year: watch.year, tmdbId: watch.tmdbId })
      : undefined;
    const completeness = sonarr && tvCompleteness({
      plexStreamable: availability.streamable,
      seasonNumber: watch.seasonNumber,
      seriesSeasons: sonarr.series.seasons,
      episodes: sonarr.episodes,
    });
    const availableInLibrary = completeness ? completeness.state === 'complete' : availability.streamable;
    const queue = availableInLibrary ? {} : await queueSnapshot(watch, sonarr);
    const [mediaRows, requestRows] = availableInLibrary ? [[], []] : await Promise.all([listSeerrMedia(), listSeerrRequests()]);
    const media = mediaRows.find((row) => row.mediaType === watch.mediaType && (!watch.tmdbId || row.tmdbId === watch.tmdbId));
    const request = requestRows.find((row) => row.media?.mediaType === watch.mediaType && (!watch.tmdbId || row.media.tmdbId === watch.tmdbId));
    const lifecycleStatus = classifyMediaLifecycle({ availableInLibrary, imported: queue.imported, queueStatus: queue.status, mediaStatus: media?.status, requestStatus: request?.status, hasRequest: Boolean(request) });

    return {
      availableInLibrary,
      libraryEpisodeCount: availability.episodeCount,
      librarySeasonEpisodeCount: availability.seasonEpisodeCount,
      seasonSatisfied: availability.seasonSatisfied,
      checkedAt,
      status: lifecycleStatus,
      progress: queue.progress,
      timeLeft: queue.timeLeft,
      tvCompleteness: completeness,
      detail: availableInLibrary
        ? (watch.seasonNumber !== undefined ? `Season ${watch.seasonNumber} found in ${serverName()} library.` : `Found in ${serverName()} library.`)
        : queue.issue || (completeness?.state === 'partial' ? partialTvDetail(completeness) : undefined) || (lifecycleStatus === 'imported' ? `Files are imported but not yet verified in ${serverName()}.` : lifecycleStatus === 'approved' ? 'The request is approved and awaiting acquisition.' : lifecycleStatus === 'requested' ? 'The request is awaiting approval.' : watch.seasonNumber !== undefined ? `Season ${watch.seasonNumber} not found in ${serverName()} library.` : `Not found in ${serverName()} library.`),
    };
  } catch (error) {
    return {
      availableInLibrary: false,
      checkedAt,
      status: 'service-unavailable',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function shouldNotifyAvailable(previous: MediaAvailabilityWatchSnapshot | undefined, current: MediaAvailabilityWatchSnapshot) {
  return current.availableInLibrary && previous?.availableInLibrary !== true;
}

export function mediaLifecycleChanged(previous: MediaAvailabilityWatchSnapshot | undefined, current: MediaAvailabilityWatchSnapshot) {
  if (!previous) return true;
  return previous.status !== current.status
    || previous.availableInLibrary !== current.availableInLibrary
    || previous.progress !== current.progress
    || previous.timeLeft !== current.timeLeft
    || previous.detail !== current.detail;
}

function shouldNotifyIssue(previous: MediaAvailabilityWatchSnapshot | undefined, current: MediaAvailabilityWatchSnapshot) {
  return ['stalled', 'failed'].includes(current.status) && previous?.status !== current.status;
}

function issueFingerprint(snapshot: MediaAvailabilityWatchSnapshot) {
  return `${snapshot.status}:${snapshot.detail || ''}`;
}

function issueCooldownElapsed(watch: MediaAvailabilityWatch, now = Date.now()) {
  if (!watch.lastIssueNotificationAt) return true;
  const cooldown = garyConfig().stalledAlertCooldownHours * 3_600_000;
  return now - Date.parse(watch.lastIssueNotificationAt) >= cooldown;
}

function nextCheckAt(snapshot: MediaAvailabilityWatchSnapshot, previous?: MediaAvailabilityWatchSnapshot) {
  const now = Date.now();
  if (snapshot.status === 'service-unavailable') {
    return new Date(now + 10 * 60 * 1000).toISOString();
  }

  if (snapshot.status === 'downloading' || snapshot.status === 'stalled' || previous?.status === 'downloading') {
    return new Date(now + 60 * 1000).toISOString();
  }

  return new Date(now + 10 * 60 * 1000).toISOString();
}

export async function checkMediaAvailabilityWatch(watch: MediaAvailabilityWatch, options: { deferAvailabilityDelivery?: boolean } = {}) {
  const snapshot = await snapshotAvailability(watch);
  const correlationId = watch.correlationId || watch.id;
  if (mediaLifecycleChanged(watch.lastSnapshot, snapshot)) {
    await appendOperationEvent({ correlationId, resourceId: watch.resourceId, threadId: watch.threadId, phase: snapshot.status, detail: { watchId: watch.id, availableInLibrary: snapshot.availableInLibrary, progress: snapshot.progress } });
  }
  const notify = snapshot.availableInLibrary;

  const fingerprint = issueFingerprint(snapshot);
  if (!notify && shouldNotifyIssue(watch.lastSnapshot, snapshot) && (
    watch.lastIssueFingerprint !== fingerprint || issueCooldownElapsed(watch)
  )) {
    const notification = await sendMediaIssueNotification(watch, snapshot.detail || snapshot.status).catch((error) => ({
      sent: false,
      reason: error instanceof Error ? error.message : String(error),
    } as const));

    await updateMediaAvailabilityWatch(watch.id, {
      dirty: false,
      nextCheckAt: nextCheckAt(snapshot, watch.lastSnapshot),
      lastCheckedAt: snapshot.checkedAt,
      lastSnapshot: snapshot,
      lastNotificationAttemptAt: new Date().toISOString(),
      lastNotificationSentAt: notification.sent ? new Date().toISOString() : undefined,
      lastWhatsAppMessageId: notification.sent && notification.channel === 'whatsapp' ? notification.messageId : undefined,
      lastIssueNotificationAt: notification.sent ? new Date().toISOString() : watch.lastIssueNotificationAt,
      lastIssueFingerprint: notification.sent ? fingerprint : watch.lastIssueFingerprint,
      lastNotificationError: notification.sent ? undefined : notification.reason || 'Issue notification was not sent',
    });

    return {
      checked: true,
      notified: notification.sent,
      failed: !notification.sent,
    };
  }

  if (!notify) {
    await updateMediaAvailabilityWatch(watch.id, {
      dirty: false,
      nextCheckAt: nextCheckAt(snapshot, watch.lastSnapshot),
      lastCheckedAt: snapshot.checkedAt,
      lastSnapshot: snapshot,
    });
    return {
      checked: true,
      notified: false,
      failed: snapshot.status === 'service-unavailable',
    };
  }

  if (watch.channel === 'none') {
    await updateMediaAvailabilityWatch(watch.id, {
      status: 'available',
      dirty: false,
      lastCheckedAt: snapshot.checkedAt,
      notifiedAt: undefined,
      lastSnapshot: snapshot,
      lastNotificationError: undefined,
    });
    await appendOperationEvent({ correlationId, resourceId: watch.resourceId, threadId: watch.threadId, phase: 'plex-available-recorded', detail: { watchId: watch.id } });
    return { checked: true, notified: false, failed: false };
  }

  if (options.deferAvailabilityDelivery) {
    return { checked: true, notified: false, failed: false, deliveryPending: { watch, snapshot } };
  }

  const notification = await sendMediaAvailableNotification({ ...watch, lastSnapshot: snapshot }).catch((error) => ({
    sent: false,
    reason: error instanceof Error ? error.message : String(error),
  } as const));
  await recordAvailabilityDelivery([{ watch, snapshot }], notification);
  return { checked: true, notified: notification.sent && notification.channel !== 'whatsapp', failed: !notification.sent };
}

export function groupMediaAvailabilityDeliveries(items: Array<{ watch: MediaAvailabilityWatch; snapshot: MediaAvailabilityWatchSnapshot }>) {
  const groups = new Map<string, typeof items>();
  for (const item of items) {
    const key = item.watch.resourceId;
    groups.set(key, [...(groups.get(key) || []), item]);
  }
  return [...groups.values()].flatMap((group) => {
    const chunks: typeof items[] = [];
    for (let index = 0; index < group.length; index += 10) chunks.push(group.slice(index, index + 10));
    return chunks;
  });
}

async function recordAvailabilityDelivery(
  items: Array<{ watch: MediaAvailabilityWatch; snapshot: MediaAvailabilityWatchSnapshot }>,
  notification: Delivery,
) {
  const now = new Date().toISOString();
  for (const { watch, snapshot } of items) {
    const correlationId = watch.correlationId || watch.id;
    if (!notification.sent) {
      await appendOperationEvent({ correlationId, resourceId: watch.resourceId, threadId: watch.threadId, phase: 'delivery-failed', detail: { watchId: watch.id, reason: notification.reason } });
      await updateMediaAvailabilityWatch(watch.id, {
        dirty: false,
        nextCheckAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        lastCheckedAt: snapshot.checkedAt,
        lastSnapshot: snapshot,
        lastNotificationAttemptAt: now,
        lastNotificationError: notification.reason || 'Notification was not sent',
      });
      continue;
    }
    const awaitsWhatsAppReceipt = notification.channel === 'whatsapp';
    await updateMediaAvailabilityWatch(watch.id, {
      status: awaitsWhatsAppReceipt ? 'delivery-pending' : 'notified',
      dirty: false,
      lastCheckedAt: snapshot.checkedAt,
      notifiedAt: awaitsWhatsAppReceipt ? undefined : now,
      lastNotificationAttemptAt: now,
      lastNotificationSentAt: now,
      lastWhatsAppMessageId: awaitsWhatsAppReceipt ? notification.messageId : undefined,
      lastSnapshot: snapshot,
      lastNotificationError: undefined,
    });
    await appendOperationEvent({ correlationId, resourceId: watch.resourceId, threadId: watch.threadId, phase: awaitsWhatsAppReceipt ? 'availability-delivery-accepted' : 'plex-available-delivered', detail: { watchId: watch.id, channel: notification.channel } });
  }
}

export async function sweepMediaAvailabilityWatches(): Promise<MediaAvailabilityWatchSweepOutput> {
  const watches = await listDueMediaAvailabilityWatches();
  const totals: MediaAvailabilityWatchSweepOutput = {
    checked: 0,
    notified: 0,
    failed: 0,
    skipped: 0,
  };

  const pending: Array<{ watch: MediaAvailabilityWatch; snapshot: MediaAvailabilityWatchSnapshot }> = [];
  for (const watch of watches) {
    const result = await checkMediaAvailabilityWatch(watch, { deferAvailabilityDelivery: true });
    totals.checked += result.checked ? 1 : 0;
    totals.notified += result.notified ? 1 : 0;
    totals.failed += result.failed ? 1 : 0;
    if (result.deliveryPending) pending.push(result.deliveryPending);
  }

  for (const group of groupMediaAvailabilityDeliveries(pending)) {
    const notification = await sendMediaAvailableNotification(group.map((item) => ({ ...item.watch, lastSnapshot: item.snapshot }))).catch((error) => ({
      sent: false,
      reason: error instanceof Error ? error.message : String(error),
    } as const));
    await recordAvailabilityDelivery(group, notification);
    if (notification.sent && notification.channel !== 'whatsapp') totals.notified += group.length;
    if (!notification.sent) totals.failed += group.length;
  }

  return totals;
}
