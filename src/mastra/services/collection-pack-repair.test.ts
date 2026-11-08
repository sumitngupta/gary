import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeCollectionPackPlan, isConfidentCollectionFileMatch, recoverApprovedTargetFromCollectionPack, reviewCollectionPackPlan } from './collection-pack-repair';
import { resetCollectionPackRepairStoreForTests } from './collection-pack-repair-store';
import { resetGaryOperationsStoreForTests } from './gary-operations-store';

test('collection filename matching requires title evidence and tolerates a one-year metadata shift', () => {
  assert.equal(isConfidentCollectionFileMatch('A.Grand.Day.Out.With.Wallace.And.Gromit.1989.1080p.mkv', { title: 'A Grand Day Out', year: 1990 }), true);
  assert.equal(isConfidentCollectionFileMatch('The.Wrong.Trousers.1993.1080p.mkv', { title: 'A Grand Day Out', year: 1990 }), false);
  assert.equal(isConfidentCollectionFileMatch('A.Grand.Day.Out.2005.1080p.mkv', { title: 'A Grand Day Out', year: 1990 }), false);
});

test('pack recovery imports only the approved target and freezes siblings for owner approval', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'collection-pack-'));
  const prior = { ...process.env };
  const originalFetch = global.fetch;
  const calls: Array<{ url: string; body?: unknown }> = [];
  process.env.GARY_DATA_DIR = directory;
  process.env.RADARR_API_KEY = 'test-key';
  process.env.RADARR_URL = 'http://radarr.test';
  process.env.GARY_ADMIN_WHATSAPP = '15550001';
  resetCollectionPackRepairStoreForTests(); resetGaryOperationsStoreForTests();
  const target = { id: 10, title: 'Wallace & Gromit: Vengeance Most Fowl', year: 2024, tmdbId: 929204, qualityProfileId: 6, path: '/data/media/movies/Wallace & Gromit - Vengeance Most Fowl (2024)' };
  const siblingLookup = { title: 'The Wrong Trousers', year: 1993, tmdbId: 531 };
  global.fetch = async (input, init) => {
    const url = String(input); const body = init?.body ? JSON.parse(String(init.body)) : undefined; calls.push({ url, body });
    if (url.endsWith('/api/v3/movie') && !init?.method) return Response.json([target]);
    if (url.includes('/api/v3/manualimport?')) return Response.json([
      { path: '/downloads/Wallace.and.Gromit.Vengeance.Most.Fowl.2024.mkv', size: 100, quality: { quality: { name: 'WEBDL-1080p' } }, languages: [], downloadId: 'pack-1' },
      { path: '/downloads/The.Wrong.Trousers.1993.mkv', size: 90, quality: { quality: { name: 'Bluray-1080p' } }, languages: [], downloadId: 'pack-1' },
    ]);
    if (url.includes('/movie/lookup?term=Wallace')) return Response.json([target]);
    if (url.includes('/movie/lookup?term=The%20Wrong')) return Response.json([siblingLookup]);
    if (url.endsWith('/api/v3/command')) return Response.json({ id: 77, status: 'queued' });
    if (url.endsWith('/api/v3/movie') && init?.method === 'POST') return Response.json({ ...siblingLookup, id: 11, qualityProfileId: 6, path: '/data/media/movies/The Wrong Trousers (1993)' });
    throw new Error(`Unexpected fetch ${url}`);
  };
  try {
    const recovery = await recoverApprovedTargetFromCollectionPack({
      title: target.title, year: target.year, tmdbId: target.tmdbId, correlationId: 'watch-1',
      queueItem: { downloadId: 'pack-1', trackedDownloadState: 'importBlocked' },
    });
    assert.equal(recovery?.status, 'started'); assert.equal(recovery?.extras.length, 1);
    const firstCommand = calls.find((call) => call.url.endsWith('/api/v3/command'))?.body as { importMode: string; files: Array<{ movieId: number }> };
    assert.equal(firstCommand.importMode, 'copy'); assert.deepEqual(firstCommand.files.map((file) => file.movieId), [10]);
    const plan = await reviewCollectionPackPlan('whatsapp:15550001', recovery?.planId);
    assert.deepEqual(plan?.items.map((item) => item.title), ['The Wrong Trousers']);
    const executed = await executeCollectionPackPlan('whatsapp:15550001', recovery!.planId!);
    assert.equal(executed?.imported.length, 1); assert.equal(executed?.failed.length, 0);
    assert.equal(await executeCollectionPackPlan('whatsapp:15550001', recovery!.planId!), undefined);
    const commands = calls.filter((call) => call.url.endsWith('/api/v3/command')).map((call) => call.body as { files: Array<{ movieId: number }> });
    assert.deepEqual(commands.map((command) => command.files.map((file) => file.movieId)), [[10], [11]]);
  } finally {
    global.fetch = originalFetch; process.env = prior;
    resetCollectionPackRepairStoreForTests(); resetGaryOperationsStoreForTests();
    await rm(directory, { recursive: true, force: true });
  }
});
