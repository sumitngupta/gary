import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkMediaStatuses } from './check-media-statuses-tool';

test('three playable episodes do not turn a partially available series into a complete availability receipt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gary-partial-tv-'));
  const previousEnv = { ...process.env };
  const previousFetch = globalThis.fetch;
  const settings = join(dir, 'settings.json');
  await writeFile(settings, JSON.stringify({ main: { apiKey: 'fixture-key' } }));
  process.env.GARY_SEERR_SETTINGS_PATH = settings;
  process.env.GARY_SEERR_URL = 'http://fixture-seerr';
  process.env.GARY_PLEX_URL = 'http://fixture-plex';
  process.env.GARY_PLEX_TOKEN = 'fixture-token';
  let catalogStatus = 4;
  globalThis.fetch = (async (input, init) => {
    assert.equal(init?.method || 'GET', 'GET');
    const path = new URL(String(input)).pathname;
    if (path === '/api/v1/search') return Response.json({ results: [{ id: 295170, mediaType: 'tv', name: 'A Woman of Substance', firstAirDate: '2026-03-11' }] });
    if (path === '/api/v1/media') return Response.json({ results: [{ mediaType: 'tv', tmdbId: 295170, status: catalogStatus }] });
    if (path === '/api/v1/request') return Response.json({ results: [] });
    if (path === '/library/sections') return Response.json({ MediaContainer: { Directory: [{ key: '2', type: 'show', title: 'TV' }] } });
    if (path === '/library/sections/2/all') return Response.json({ MediaContainer: { Metadata: [{ title: 'A Woman of Substance', year: 2026, type: 'show', ratingKey: '10066', leafCount: 3 }] } });
    if (path === '/library/metadata/10066/children') return Response.json({ MediaContainer: { Metadata: [{ type: 'season', index: 1 }] } });
    throw new Error(`Unexpected fixture path: ${path}`);
  }) as typeof fetch;
  try {
    const input = { titles: [{ title: 'A Woman of Substance', mediaType: 'tv' as const, year: 2026 }] };
    const partial = await checkMediaStatuses(input);
    assert.equal(partial.results[0]?.status, 'partially-available');
    assert.match(partial.results[0]?.summary || '', /3 episodes/);
    assert.equal(partial.totals.available, 0);
    assert.equal(partial.totals.partiallyAvailable, 1);
    catalogStatus = 5;
    assert.equal((await checkMediaStatuses(input)).results[0]?.status, 'available');
  } finally {
    process.env = previousEnv;
    globalThis.fetch = previousFetch;
    await rm(dir, { recursive: true, force: true });
  }
});
