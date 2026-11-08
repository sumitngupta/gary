import { KeyedTaskQueue } from './keyed-task-queue';
const writes = new KeyedTaskQueue();
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mediaRadarSubscriptionSchema, type MediaRadarSubscription } from '../schemas/media-radar-subscription';
import { garyConfig } from '../config/gary-config';

const path = () => join(garyConfig().dataDir, 'media-radar-subscriptions.json');

async function readStore(): Promise<MediaRadarSubscription[]> {
  try {
    const parsed = JSON.parse(await readFile(path(), 'utf8')) as { subscriptions?: unknown[] };
    return (parsed.subscriptions || []).map((item) => mediaRadarSubscriptionSchema.parse(item));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function writeStore(subscriptions: MediaRadarSubscription[]) {
  await mkdir(dirname(path()), { recursive: true });
  const tmp = `${path()}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ subscriptions }, null, 2)}\n`);
  await rename(tmp, path());
}

export async function listMediaRadarSubscriptions(criteria: { resourceId?: string; threadId?: string; includeCancelled?: boolean } = {}) {
  return (await readStore()).filter((item) =>
    (!criteria.resourceId || item.resourceId === criteria.resourceId)
    && (!criteria.threadId || item.threadId === criteria.threadId)
    && (criteria.includeCancelled || item.status !== 'cancelled'));
}

export async function getMediaRadarSubscription(id: string) {
  return (await readStore()).find((item) => item.id === id || item.scheduleId === id);
}

async function createMediaRadarSubscriptionUnlocked(input: Omit<MediaRadarSubscription, 'id' | 'surfaced' | 'status' | 'createdAt' | 'updatedAt' | 'consentedAt'> & { consentedAt?: string }) {
  const subscriptions = await readStore();
  const now = new Date().toISOString();
  const subscription = mediaRadarSubscriptionSchema.parse({
    ...input, id: `radar_${randomUUID()}`, surfaced: [], status: 'active', consentedAt: input.consentedAt || now, createdAt: now, updatedAt: now,
  });
  subscriptions.push(subscription);
  await writeStore(subscriptions);
  return subscription;
}

async function updateMediaRadarSubscriptionUnlocked(id: string, patch: Partial<MediaRadarSubscription>) {
  const subscriptions = await readStore();
  const index = subscriptions.findIndex((item) => item.id === id || item.scheduleId === id);
  if (index < 0) return undefined;
  subscriptions[index] = mediaRadarSubscriptionSchema.parse({ ...subscriptions[index], ...patch, id: subscriptions[index].id, updatedAt: new Date().toISOString() });
  await writeStore(subscriptions);
  return subscriptions[index];
}

async function recordMediaRadarCandidatesUnlocked(id: string, candidates: Array<{ title: string; year?: number }>) {
  const current = await getMediaRadarSubscription(id);
  if (!current) return undefined;
  const now = new Date().toISOString();
  const seen = new Set(current.surfaced.map((item) => `${item.title.toLowerCase()}|${item.year || ''}`));
  const additions: Array<{ title: string; year?: number; surfacedAt: string }> = [];
  for (const item of candidates) {
    const key = `${item.title.toLowerCase()}|${item.year || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    additions.push({ ...item, surfacedAt: now });
  }
  return updateMediaRadarSubscriptionUnlocked(current.id, { surfaced: [...current.surfaced, ...additions].slice(-500) });
}

async function deleteMediaRadarSubscriptionsForResourceUnlocked(resourceId: string) {
  const subscriptions = await readStore();
  const retained = subscriptions.filter((item) => item.resourceId !== resourceId);
  const deleted = subscriptions.length - retained.length;
  if (deleted > 0) await writeStore(retained);
  return deleted;
}

export function createMediaRadarSubscription(...args: Parameters<typeof createMediaRadarSubscriptionUnlocked>) {
  return writes.run(path(), () => createMediaRadarSubscriptionUnlocked(...args));
}

export function updateMediaRadarSubscription(...args: Parameters<typeof updateMediaRadarSubscriptionUnlocked>) {
  return writes.run(path(), () => updateMediaRadarSubscriptionUnlocked(...args));
}

export function recordMediaRadarCandidates(...args: Parameters<typeof recordMediaRadarCandidatesUnlocked>) {
  return writes.run(path(), () => recordMediaRadarCandidatesUnlocked(...args));
}

export function deleteMediaRadarSubscriptionsForResource(...args: Parameters<typeof deleteMediaRadarSubscriptionsForResourceUnlocked>) {
  return writes.run(path(), () => deleteMediaRadarSubscriptionsForResourceUnlocked(...args));
}
