import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  mediaAvailabilityWatchSchema,
  type MediaAvailabilityWatch,
  type MediaAvailabilityWatchInput,
  type MediaAvailabilityWatchSnapshot,
} from '../schemas/media-availability-watch';
import { garyConfig } from '../config/gary-config';

type WatchStoreFile = {
  watches: MediaAvailabilityWatch[];
};

function storePath() {
  return join(garyConfig().dataDir, 'media-availability-watches.json');
}

function normalizedTitle(title: string) {
  return title
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function watchDedupeKey(input: Pick<MediaAvailabilityWatchInput, 'title' | 'mediaType' | 'year' | 'seasonNumber' | 'resourceId' | 'threadId'>) {
  const raw = [
    normalizedTitle(input.title),
    input.mediaType || 'unknown',
    input.year || '',
    input.seasonNumber ?? '',
    input.resourceId || '',
    input.threadId || '',
  ].join('|');

  return createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

async function readStore(): Promise<WatchStoreFile> {
  try {
    const text = await readFile(storePath(), 'utf8');
    const parsed = JSON.parse(text) as Partial<WatchStoreFile>;
    return {
      watches: (parsed.watches || []).map((watch) => mediaAvailabilityWatchSchema.parse(watch)),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { watches: [] };
    }

    throw error;
  }
}

async function writeStore(store: WatchStoreFile) {
  const path = storePath();
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(store, null, 2)}\n`);
  await rename(tmpPath, path);
}

export async function listMediaAvailabilityWatches(status?: MediaAvailabilityWatch['status']) {
  const store = await readStore();
  return status ? store.watches.filter((watch) => watch.status === status) : store.watches;
}

export async function listDueMediaAvailabilityWatches(now = new Date()) {
  const watches = await listMediaAvailabilityWatches('active');
  const nowMs = now.getTime();

  return watches.filter((watch) => {
    if (watch.dirty) {
      return true;
    }

    if (!watch.nextCheckAt) {
      return true;
    }

    return Date.parse(watch.nextCheckAt) <= nowMs;
  });
}

export async function createMediaAvailabilityWatch(input: MediaAvailabilityWatchInput) {
  const now = new Date().toISOString();
  const store = await readStore();
  const dedupeKey = watchDedupeKey(input);
  const existing = store.watches.find((watch) => watch.dedupeKey === dedupeKey
    && (watch.status === 'active' || watch.status === 'delivery-pending'));

  if (existing) {
    if (existing.channel === 'none' && input.channel !== 'none') {
      const upgraded = mediaAvailabilityWatchSchema.parse({
        ...existing,
        channel: input.channel,
        dirty: true,
        nextCheckAt: now,
        updatedAt: now,
        correlationId: input.correlationId || existing.correlationId,
      });
      store.watches[store.watches.indexOf(existing)] = upgraded;
      await writeStore(store);
      return { watch: upgraded, created: false };
    }
    return {
      watch: existing,
      created: false,
    };
  }

  const watch = mediaAvailabilityWatchSchema.parse({
    id: `watch_${randomUUID()}`,
    title: input.title,
    mediaType: input.mediaType,
    year: input.year,
    seasonNumber: input.seasonNumber,
    tmdbId: input.tmdbId,
    requester: input.requester,
    resourceId: input.resourceId,
    threadId: input.threadId,
    channel: input.channel,
    status: 'active',
    dirty: true,
    createdAt: now,
    updatedAt: now,
    nextCheckAt: now,
    dedupeKey,
    correlationId: input.correlationId,
  });

  store.watches.push(watch);
  await writeStore(store);

  return {
    watch,
    created: true,
  };
}

export async function updateMediaAvailabilityWatch(
  watchId: string,
  update: Partial<Pick<
    MediaAvailabilityWatch,
    | 'status'
    | 'dirty'
    | 'nextCheckAt'
    | 'lastCheckedAt'
    | 'notifiedAt'
    | 'lastNotificationError'
    | 'lastNotificationAttemptAt'
    | 'lastNotificationSentAt'
    | 'lastWhatsAppMessageId'
    | 'lastIssueNotificationAt'
    | 'lastIssueFingerprint'
  >> & { lastSnapshot?: MediaAvailabilityWatchSnapshot },
) {
  const store = await readStore();
  const index = store.watches.findIndex((watch) => watch.id === watchId);

  if (index === -1) {
    return undefined;
  }

  const updated = mediaAvailabilityWatchSchema.parse({
    ...store.watches[index],
    ...update,
    updatedAt: new Date().toISOString(),
  });
  store.watches[index] = updated;
  await writeStore(store);
  return updated;
}

export async function reconcileMediaAvailabilityDeliveryReceipt(
  watchIds: string[],
  status: 'sent' | 'delivered' | 'read' | 'failed',
  providerMessageId: string,
  error?: string,
) {
  if (!watchIds.length || status === 'sent') return 0;
  const store = await readStore();
  const now = new Date().toISOString();
  let updated = 0;
  store.watches = store.watches.map((watch) => {
    if (!watchIds.includes(watch.id) || watch.lastWhatsAppMessageId !== providerMessageId) return watch;
    updated += 1;
    if (status === 'failed') {
      return mediaAvailabilityWatchSchema.parse({
        ...watch,
        status: 'active',
        dirty: true,
        nextCheckAt: now,
        updatedAt: now,
        lastNotificationError: error || 'WhatsApp reported delivery failure',
      });
    }
    return mediaAvailabilityWatchSchema.parse({
      ...watch,
      status: 'notified',
      dirty: false,
      notifiedAt: now,
      updatedAt: now,
      lastNotificationError: undefined,
    });
  });
  if (updated) await writeStore(store);
  return updated;
}

export async function markMatchingMediaAvailabilityWatchesDirty(criteria: {
  title?: string;
  mediaType?: 'movie' | 'tv' | 'unknown';
  year?: number;
  seasonNumber?: number;
  tmdbId?: number;
}) {
  const store = await readStore();
  let updatedCount = 0;
  const normalizedCriteriaTitle = criteria.title ? normalizedTitle(criteria.title) : undefined;

  const watches = store.watches.map((watch) => {
    if (watch.status !== 'active') {
      return watch;
    }

    const titleMatches = !normalizedCriteriaTitle
      || normalizedTitle(watch.title) === normalizedCriteriaTitle
      || normalizedTitle(watch.title).includes(normalizedCriteriaTitle)
      || normalizedCriteriaTitle.includes(normalizedTitle(watch.title));
    const typeMatches = !criteria.mediaType || criteria.mediaType === 'unknown' || watch.mediaType === 'unknown' || watch.mediaType === criteria.mediaType;
    const yearMatches = !criteria.year || !watch.year || watch.year === criteria.year;
    const tmdbMatches = !criteria.tmdbId || !watch.tmdbId || watch.tmdbId === criteria.tmdbId;
    const seasonMatches = criteria.seasonNumber === undefined
      || watch.seasonNumber === undefined
      || watch.seasonNumber === criteria.seasonNumber;

    if (!titleMatches || !typeMatches || !yearMatches || !tmdbMatches || !seasonMatches) {
      return watch;
    }

    updatedCount += 1;
    return mediaAvailabilityWatchSchema.parse({
      ...watch,
      dirty: true,
      nextCheckAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  if (updatedCount > 0) {
    await writeStore({ watches });
  }

  return updatedCount;
}

export async function cancelMediaAvailabilityWatches(criteria: {
  watchId?: string;
  title?: string;
  resourceId?: string;
  threadId?: string;
}) {
  const store = await readStore();
  const normalizedCriteriaTitle = criteria.title ? normalizedTitle(criteria.title) : undefined;
  const cancelled: MediaAvailabilityWatch[] = [];
  const watches = store.watches.map((watch) => {
    if (watch.status !== 'active') {
      return watch;
    }

    const idMatches = !criteria.watchId || watch.id === criteria.watchId;
    const titleMatches = !normalizedCriteriaTitle || normalizedTitle(watch.title).includes(normalizedCriteriaTitle);
    const resourceMatches = !criteria.resourceId || watch.resourceId === criteria.resourceId;
    const threadMatches = !criteria.threadId || watch.threadId === criteria.threadId;

    if (!idMatches || !titleMatches || !resourceMatches || !threadMatches) {
      return watch;
    }

    const updated = mediaAvailabilityWatchSchema.parse({
      ...watch,
      status: 'cancelled',
      updatedAt: new Date().toISOString(),
    });
    cancelled.push(updated);
    return updated;
  });

  if (cancelled.length > 0) {
    await writeStore({ watches });
  }

  return cancelled;
}

export async function deleteMediaAvailabilityWatchesForResource(resourceId: string) {
  const store = await readStore();
  const retained = store.watches.filter((watch) => watch.resourceId !== resourceId);
  const deleted = store.watches.length - retained.length;
  if (deleted > 0) await writeStore({ watches: retained });
  return deleted;
}
