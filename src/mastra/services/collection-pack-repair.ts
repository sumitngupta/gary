import { basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { CollectionPackItem } from '../schemas/collection-pack-repair';
import {
  claimCollectionPackTargetRepair,
  consumeCollectionPackPlan,
  createCollectionPackPlan,
  getCollectionPackPlan,
  getLatestCollectionPackPlan,
  recordCollectionPackTargetRepair,
  type StoredCollectionPackFile,
} from './collection-pack-repair-store';
import { createPendingIntent } from './gary-operations-store';
import { assertMutationAllowed, garyConfig, requireService } from '../config/gary-config';

type RadarrMovie = { id: number; title: string; year?: number; tmdbId?: number; qualityProfileId?: number; path?: string };
type ManualImportCandidate = {
  path: string; folderName?: string; name?: string; size?: number; releaseGroup?: string;
  quality?: unknown; languages?: unknown[]; downloadId?: string; indexerFlags?: number;
};
type QueueItem = {
  title?: string; trackedDownloadState?: string; trackedDownloadStatus?: string;
  outputPath?: string; downloadId?: string; statusMessages?: Array<{ messages?: string[] }>;
};

async function radarrFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const { url, apiKey } = requireService('radarr');
  if (init?.method && init.method !== 'GET') assertMutationAllowed(path === '/api/v3/movie' ? 'request' : 'change');
  const response = await fetch(`${url}${path}`, {
    ...init,
    headers: { 'X-Api-Key': apiKey, ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  });
  if (!response.ok) throw new Error(`Radarr returned HTTP ${response.status}`);
  return await response.json() as T;
}

function normalized(value: string) {
  return value.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function significantWords(value: string) {
  return normalized(value).split(' ').filter((word) => word.length > 1 && !['the', 'and', 'of', 'in', 'a'].includes(word));
}

export function isConfidentCollectionFileMatch(fileName: string, movie: Pick<RadarrMovie, 'title' | 'year'>) {
  const haystack = ` ${normalized(fileName)} `;
  const words = significantWords(movie.title);
  if (!words.length || !words.every((word) => haystack.includes(` ${word} `))) return false;
  const fileYears = [...fileName.matchAll(/(?:^|\D)((?:19|20)\d{2})(?:\D|$)/g)].map((match) => Number(match[1]));
  return !movie.year || !fileYears.length || fileYears.some((year) => Math.abs(year - Number(movie.year)) <= 1);
}

async function lookupFile(path: string) {
  const query = basename(path).replace(/\.[^.]+$/, '').replace(/[._]+/g, ' ');
  const results = await radarrFetch<Array<Record<string, unknown> & RadarrMovie>>(`/api/v3/movie/lookup?term=${encodeURIComponent(query)}`);
  const matches = results.filter((movie) => movie.tmdbId && isConfidentCollectionFileMatch(basename(path), movie));
  return matches.length === 1 ? matches[0] : undefined;
}

function publicItem(file: StoredCollectionPackFile): CollectionPackItem {
  const quality = file.quality && typeof file.quality === 'object'
    ? ((file.quality as { quality?: { name?: string } }).quality?.name)
    : undefined;
  return { title: file.title, year: file.year, tmdbId: file.tmdbId, size: file.size, quality };
}

function commandFile(file: StoredCollectionPackFile, movieId: number) {
  return {
    path: file.path, folderName: file.folderName, quality: file.quality,
    languages: file.languages, releaseGroup: file.releaseGroup || '', indexerFlags: file.indexerFlags,
    downloadId: file.downloadId || '', movieId,
  };
}

async function startManualImport(files: Array<{ file: StoredCollectionPackFile; movieId: number }>) {
  return radarrFetch<{ id?: number; status?: string }>('/api/v3/command', {
    method: 'POST', body: JSON.stringify({ name: 'ManualImport', importMode: 'copy', files: files.map(({ file, movieId }) => commandFile(file, movieId)) }),
  });
}

function supervisorActor() {
  const digits = garyConfig().owners.adminWhatsApp;
  return digits ? `whatsapp:${digits}` : 'admin-household';
}

export async function recoverApprovedTargetFromCollectionPack(input: {
  title: string; year?: number; tmdbId?: number; queueItem: QueueItem; correlationId: string;
}) {
  const state = `${input.queueItem.trackedDownloadState || ''} ${input.queueItem.trackedDownloadStatus || ''} ${input.queueItem.statusMessages?.flatMap((entry) => entry.messages || []).join(' ') || ''}`;
  if (!/importblocked|manual import required/i.test(state) || !input.queueItem.downloadId) return undefined;
  const movies = await radarrFetch<RadarrMovie[]>('/api/v3/movie');
  const target = movies.find((movie) => (input.tmdbId && movie.tmdbId === input.tmdbId)
    || (normalized(movie.title) === normalized(input.title) && (!input.year || !movie.year || Math.abs(movie.year - input.year) <= 1)));
  if (!target) return undefined;
  const repairKey = createHash('sha256').update(`${input.queueItem.downloadId}:${target.id}`).digest('hex');
  if (!await claimCollectionPackTargetRepair(repairKey, { targetId: target.id, correlationId: input.correlationId })) return { status: 'already-claimed' as const };
  try {
    const candidates = await radarrFetch<ManualImportCandidate[]>(`/api/v3/manualimport?downloadId=${encodeURIComponent(input.queueItem.downloadId)}&filterExistingFiles=false`);
    const mapped: StoredCollectionPackFile[] = [];
    for (const candidate of candidates) {
      const lookup = await lookupFile(candidate.path);
      if (!lookup?.tmdbId) continue;
      mapped.push({
        path: candidate.path, folderName: candidate.folderName, releaseGroup: candidate.releaseGroup,
        quality: candidate.quality || { quality: { id: 0, name: 'Unknown' }, revision: { version: 1, real: 0, isRepack: false } },
        languages: candidate.languages || [], indexerFlags: candidate.indexerFlags || 0,
        downloadId: candidate.downloadId || input.queueItem.downloadId, size: candidate.size || 0,
        title: lookup.title, year: lookup.year, tmdbId: lookup.tmdbId, lookup,
      });
    }
    const targetFiles = mapped.filter((file) => file.tmdbId === target.tmdbId);
    if (targetFiles.length !== 1) throw new Error(`Expected one exact target file, found ${targetFiles.length}.`);
    const extras = mapped.filter((file) => file.tmdbId !== target.tmdbId);
    const command = await startManualImport([{ file: targetFiles[0], movieId: target.id }]);
    await recordCollectionPackTargetRepair(repairKey, 'started', command.id, { target: target.title, extras: extras.length });
    let planId: string | undefined;
    if (extras.length) {
      const actorId = supervisorActor();
      const plan = await createCollectionPackPlan({ actorId, targetTitle: target.title, targetTmdbId: target.tmdbId, files: extras });
      planId = plan.id;
      await createPendingIntent({
        resourceId: actorId, threadId: actorId, kind: 'collection-pack-import-approval',
        question: `${target.title} came in a collection pack with ${extras.length} additional title${extras.length === 1 ? '' : 's'}. Import all of them too? Reply yes or no.`,
        options: [{ key: 'yes', label: 'Import all collection titles', aliases: ['import all'], value: { collectionPackPlanId: plan.id } }],
        payload: { collectionPackPlanId: plan.id }, ttlMs: 6 * 60 * 60_000, correlationId: input.correlationId,
      });
    }
    return { status: 'started' as const, target: target.title, extras: extras.map(publicItem), planId };
  } catch (error) {
    await recordCollectionPackTargetRepair(repairKey, 'failed', undefined, { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

export async function reviewCollectionPackPlan(actorId: string, planId?: string) {
  const plan = planId ? await getCollectionPackPlan(planId, actorId) : await getLatestCollectionPackPlan(actorId);
  return plan ? { ...plan, items: plan.files.map(publicItem) } : undefined;
}

export async function executeCollectionPackPlan(actorId: string, planId: string) {
  const plan = await consumeCollectionPackPlan(planId, actorId);
  if (!plan) return undefined;
  const existing = await radarrFetch<RadarrMovie[]>('/api/v3/movie');
  const imported: CollectionPackItem[] = [];
  const failed: Array<CollectionPackItem & { error: string }> = [];
  const commandItems: Array<{ file: StoredCollectionPackFile; movieId: number }> = [];
  for (const file of plan.files) {
    const item = publicItem(file);
    try {
      let movie = existing.find((candidate) => candidate.tmdbId === file.tmdbId);
      if (!movie) {
        const target = existing.find((candidate) => candidate.tmdbId === plan.targetTmdbId);
        const rootFolderPath = target?.path ? dirname(target.path) : '/data/media/movies';
        const payload = { ...file.lookup, qualityProfileId: target?.qualityProfileId || 6, rootFolderPath, monitored: true, minimumAvailability: 'released', addOptions: { searchForMovie: false } };
        movie = await radarrFetch<RadarrMovie>('/api/v3/movie', { method: 'POST', body: JSON.stringify(payload) });
        existing.push(movie);
      }
      commandItems.push({ file, movieId: movie.id });
      imported.push(item);
    } catch (error) {
      failed.push({ ...item, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (commandItems.length) {
    try { await startManualImport(commandItems); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push(...imported.splice(0).map((item) => ({ ...item, error: message })));
    }
  }
  return { plan, imported, failed };
}
