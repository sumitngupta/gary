import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureMediaRequestLifecycleWatch, resolveMediaRequester, resolveMediaRequestQualityProfile, storageAllowsMediaAcquisition, tvCatalogSeasonScope } from './create-media-request-tool';
import { listMediaAvailabilityWatches } from '../services/media-availability-watch-store';
import { getOperationTimeline, resetGaryOperationsStoreForTests } from '../services/gary-operations-store';
import { mediaRequestCreateInputSchema } from '../schemas/media-request';

test('every created media request gets a correlated lifecycle watch without inventing a notification', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gary-request-lifecycle-'));
  const previousData = process.env.GARY_DATA_DIR;
  const previousWatch = process.env.GARY_MEDIA_WATCH_STORE_PATH;
  process.env.GARY_DATA_DIR = dir;
  process.env.GARY_MEDIA_WATCH_STORE_PATH = join(dir, 'watches.json');
  resetGaryOperationsStoreForTests();
  try {
    const watch = await ensureMediaRequestLifecycleWatch(
      { title: 'Movie Alpha', mediaType: 'movie', year: 2025, tmdbId: 123, requester: 'erin', notifyWhenAvailable: false, notificationChannel: 'none', qualityObjective: 'household-default' },
      { status: 'created', requester: 'erin', title: 'Movie Alpha', mediaType: 'movie', year: 2025, tmdbId: 123, requestId: 42, notifyWhenAvailable: false, notificationChannel: 'none', qualityObjective: 'household-default', summary: 'Requested.' },
      { resourceId: 'whatsapp:erin', threadId: 'thread-erin', correlationId: 'wamid.inbound' },
    );
    assert.equal(watch?.channel, 'none');
    assert.equal((await listMediaAvailabilityWatches())[0]?.correlationId, 'wamid.inbound');
    assert.deepEqual((await getOperationTimeline('wamid.inbound')).map((event) => event.phase), ['lifecycle-watch-created']);
  } finally {
    resetGaryOperationsStoreForTests();
    if (previousData === undefined) delete process.env.GARY_DATA_DIR; else process.env.GARY_DATA_DIR = previousData;
    if (previousWatch === undefined) delete process.env.GARY_MEDIA_WATCH_STORE_PATH; else process.env.GARY_MEDIA_WATCH_STORE_PATH = previousWatch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('WhatsApp media requests use the canonical saved requester name', () => {
  assert.equal(resolveMediaRequester('Notin', 'whatsapp:123', 'Bob'), 'Bob');
  assert.equal(resolveMediaRequester('Delegated requester', 'admin-household', 'Bob'), 'Delegated requester');
  assert.equal(resolveMediaRequester('Unprofiled', 'whatsapp:456'), 'Unprofiled');
});

test('hard quality objective selects the reusable Arr profile without changing household defaults', () => {
  const base = { title: 'Movie Alpha', requester: 'Bob', year: 2025, tmdbId: 123, notifyWhenAvailable: false, notificationChannel: 'none' as const };
  assert.equal(resolveMediaRequestQualityProfile({ ...base, mediaType: 'movie', qualityObjective: '4k-dv-atmos-hard' }), 8);
  assert.equal(resolveMediaRequestQualityProfile({ ...base, mediaType: 'tv', seasons: 'all', qualityObjective: '4k-dv-atmos-hard' }), 9);
  assert.equal(resolveMediaRequestQualityProfile({ ...base, mediaType: 'movie', qualityObjective: 'household-default' }), undefined);
});

test('large TV catalogs require explicit season scope before requesting everything', () => {
  const details = {
    numberOfSeasons: 26,
    seasons: [{ seasonNumber: 0 }, ...Array.from({ length: 26 }, (_, index) => ({ seasonNumber: index + 1 }))],
  };
  assert.deepEqual(tvCatalogSeasonScope(details), {
    requiresScope: true,
    seasonCount: 26,
    suggestedSeasons: [1, 2],
  });
  assert.equal(tvCatalogSeasonScope(details, 'all').requiresScope, false);
  assert.equal(tvCatalogSeasonScope(details, [1, 2]).requiresScope, false);
  assert.equal(tvCatalogSeasonScope(details, []).requiresScope, true);
});

test('media request input normalizes empty season scope and canonicalizes explicit seasons', () => {
  const base = { title: 'Game of Thrones', requester: 'admin', mediaType: 'tv' as const };
  assert.equal(mediaRequestCreateInputSchema.parse({ ...base, seasons: [] }).seasons, undefined);
  assert.deepEqual(mediaRequestCreateInputSchema.parse({ ...base, seasons: [2, 1, 2] }).seasons, [1, 2]);
  assert.throws(() => mediaRequestCreateInputSchema.parse({ ...base, seasons: [0] }));
});

test('ordinary TV catalogs retain the existing whole-show request behavior', () => {
  assert.deepEqual(tvCatalogSeasonScope({ numberOfSeasons: 5 }), {
    requiresScope: false,
    seasonCount: 5,
    suggestedSeasons: [],
  });
});

test('six-season TV catalogs cross the explicit scope boundary', () => {
  assert.equal(tvCatalogSeasonScope({ numberOfSeasons: 6 }).requiresScope, true);
});

test('media acquisition fails closed at critical or unknown storage pressure', () => {
  const base = { usedPercent: 50, available: '8 TB', warningAtPercent: 85, criticalAtPercent: 92 };
  assert.equal(storageAllowsMediaAcquisition({ ...base, status: 'ok' }), true);
  assert.equal(storageAllowsMediaAcquisition({ ...base, status: 'warning' }), true);
  assert.equal(storageAllowsMediaAcquisition({ ...base, status: 'critical' }), false);
  assert.equal(storageAllowsMediaAcquisition({ ...base, status: 'unavailable', usedPercent: null, available: null }), false);
});

test('episode-only requests cannot silently become season backlog requests', async () => {
  const { createMediaRequest } = await import('./create-media-request-tool');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('No network allowed for a scope rejection'); };
  try {
    const result = await createMediaRequest({ title: 'Real Time with Bill Maher', mediaType: 'tv', episodeScope: 'Only new episodes, including last Friday', seasons: 'all' });
    assert.equal(result.status, 'blocked');
    assert.equal(result.requestId, undefined);
    assert.match(result.summary, /No request was created/);
  } finally { globalThis.fetch = originalFetch; }
});
