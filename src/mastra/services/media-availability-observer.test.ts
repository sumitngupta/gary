import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMediaAvailabilityWatchTool } from '../tools/create-media-availability-watch-tool';
import { mediaAvailabilityWatchInputSchema, type MediaAvailabilityWatchOutput } from '../schemas/media-availability-watch';
import { createMediaAvailabilityWatch, listMediaAvailabilityWatches, updateMediaAvailabilityWatch } from './media-availability-watch-store';
import { resetGaryOperationsStoreForTests } from './gary-operations-store';
import { resetGaryNotificationDeliveryStoreForTests } from './gary-notification-delivery-store';
import { sweepMediaAvailabilityWatches } from './media-availability-observer';
import { serverName } from '../config/branding';

const show = { title: 'Silicon Valley', year: 2014, tmdbId: 60573, mediaType: 'tv' as const, requester: 'Grace' };
const seasonLengths: Record<number, number> = { 1: 8, 2: 10, 3: 10, 4: 10, 5: 8, 6: 7 };
const past = '2019-01-01T00:00:00Z';
const future = '2099-01-01T00:00:00Z';

type Library = {
  sonarr: 'managed' | 'unmanaged' | 'error';
  hasFile: (season: number, episode: number) => boolean;
  airDate: (season: number, episode: number) => string;
  seasons?: Record<number, number>;
  monitoredSeasons?: number[];
};

async function fixture(t: TestContext, library: Library) {
  const dir = await mkdtemp(join(tmpdir(), 'gary-tv-completeness-'));
  const previousEnv = { ...process.env };
  const seerrSettings = join(dir, 'seerr-settings.json');
  await writeFile(seerrSettings, JSON.stringify({ main: { apiKey: 'test-only' } }));
  Object.assign(process.env, {
    GARY_DATA_DIR: dir,
    GARY_MEDIA_WATCH_STORE_PATH: join(dir, 'watches.json'),
    GARY_PLEX_TOKEN: 'test-only',
    GARY_PLEX_URL: 'http://plex.test',
    GARY_SONARR_URL: 'http://sonarr.test',
    GARY_SONARR_API_KEY: 'test-only',
    GARY_SEERR_URL: 'http://seerr.test',
    GARY_SEERR_SETTINGS_PATH: seerrSettings,
    GARY_TELEGRAM_BOT_TOKEN: 'test-only',
  });
  resetGaryOperationsStoreForTests();
  resetGaryNotificationDeliveryStoreForTests();
  t.after(async () => {
    process.env = previousEnv;
    resetGaryOperationsStoreForTests();
    resetGaryNotificationDeliveryStoreForTests();
    await rm(dir, { recursive: true, force: true });
  });

  const seasons = library.seasons || seasonLengths;
  const episodes = Object.entries(seasons).flatMap(([season, count]) =>
    Array.from({ length: count }, (_, index) => ({ season: Number(season), episode: index + 1 })));
  const telegram: string[] = [];

  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    const { host, pathname } = new URL(url);
    if (host === 'api.telegram.org') {
      telegram.push(JSON.parse(String(init?.body)).text);
      return Response.json({ result: { message_id: telegram.length } });
    }
    if (host === 'seerr.test') return Response.json({ results: [] });
    if (host === 'sonarr.test') {
      if (library.sonarr === 'error') return new Response('unavailable', { status: 503 });
      if (pathname === '/api/v3/series') {
        return Response.json(library.sonarr === 'unmanaged' ? [] : [{
          id: 1, ...show, monitored: true,
          seasons: [0, ...Object.keys(seasons).map(Number)].map((seasonNumber) => ({
            seasonNumber, monitored: (library.monitoredSeasons || Object.keys(seasons).map(Number)).includes(seasonNumber),
          })),
        }]);
      }
      if (pathname === '/api/v3/episode') {
        return Response.json(episodes.map(({ season, episode }, id) => ({
          id, seasonNumber: season, episodeNumber: episode, monitored: true,
          hasFile: library.hasFile(season, episode), airDateUtc: library.airDate(season, episode),
        })));
      }
      if (pathname === '/api/v3/queue') return Response.json({ records: [] });
    }
    if (host === 'plex.test') {
      const playable = episodes.filter(({ season, episode }) => library.hasFile(season, episode));
      if (pathname === '/library/sections') return Response.json({ MediaContainer: { Directory: [{ key: '2', type: 'show' }] } });
      if (pathname === '/library/sections/2/all') {
        return Response.json({ MediaContainer: { Metadata: playable.length
          ? [{ title: show.title, year: show.year, type: 'show', ratingKey: 'sv', leafCount: playable.length }]
          : [] } });
      }
      if (pathname === '/library/metadata/sv/children') {
        return Response.json({ MediaContainer: { Metadata: Object.keys(seasons).map(Number)
          .map((season) => ({ type: 'season', index: season, ratingKey: `sv-${season}`, leafCount: playable.filter((item) => item.season === season).length }))
          .filter((season) => season.leafCount > 0) } });
      }
    }
    throw new Error(`Unexpected external call: ${url}`);
  });

  return { telegram };
}

async function requestWatch(input: Partial<typeof show> & { seasonNumber?: number } = {}) {
  return await createMediaAvailabilityWatchTool.execute!(
    mediaAvailabilityWatchInputSchema.parse({ ...show, ...input }),
    { agent: { resourceId: 'telegram:4242', threadId: 'grace' } } as never,
  ) as MediaAvailabilityWatchOutput;
}

async function storedWatch(resourceId: string) {
  return (await listMediaAvailabilityWatches()).find((watch) => watch.resourceId === resourceId)!;
}

test('a show with only season 1 imported is partial until every requested season lands, then notifies once', async (t) => {
  let importedThrough = 1;
  const { telegram } = await fixture(t, { sonarr: 'managed', hasFile: (season) => season <= importedThrough, airDate: () => past });
  await createMediaAvailabilityWatch({ ...show, resourceId: 'whatsapp:15555550101', threadId: 'request-lifecycle', channel: 'none' });

  const partial = await requestWatch();
  assert.equal(partial.status, 'partially-available');
  assert.equal(partial.summary, `Season 1 of Silicon Valley (2014) is on ${serverName()} now. I'll message you here when seasons 2–6 finish.`);

  assert.deepEqual(await sweepMediaAvailabilityWatches(), { checked: 2, notified: 0, failed: 0, skipped: 0 });
  assert.deepEqual(telegram, []);
  const grace = await storedWatch('telegram:4242');
  assert.equal(grace.status, 'active');
  assert.equal(grace.lastSnapshot?.availableInLibrary, false);
  assert.equal(grace.lastSnapshot?.tvCompleteness?.state, 'partial');
  assert.equal(grace.lastSnapshot?.detail, `Season 1 of 6 is on ${serverName()}; 45 aired episodes still downloading.`);
  assert.equal((await storedWatch('whatsapp:15555550101')).status, 'active');

  importedThrough = 6;
  for (const watch of await listMediaAvailabilityWatches()) await updateMediaAvailabilityWatch(watch.id, { dirty: true });

  assert.deepEqual(await sweepMediaAvailabilityWatches(), { checked: 2, notified: 1, failed: 0, skipped: 0 });
  assert.deepEqual(telegram, [`All 6 seasons of Silicon Valley (2014) are now available in ${serverName()}.`]);
  assert.equal((await storedWatch('telegram:4242')).status, 'notified');
  assert.equal((await storedWatch('whatsapp:15555550101')).status, 'available');

  assert.deepEqual(await sweepMediaAvailabilityWatches(), { checked: 0, notified: 0, failed: 0, skipped: 0 });
  assert.equal(telegram.length, 1);
});

test('a currently airing show is complete when every aired episode is present', async (t) => {
  const { telegram } = await fixture(t, {
    sonarr: 'managed',
    seasons: { 1: 8, 2: 10 },
    hasFile: (season, episode) => season === 1 || episode <= 6,
    airDate: (season, episode) => season === 2 && episode > 6 ? future : past,
  });
  assert.equal((await requestWatch()).status, 'already-available');

  await createMediaAvailabilityWatch({ ...show, resourceId: 'telegram:4242', threadId: 'grace', channel: 'telegram' });
  assert.equal((await sweepMediaAvailabilityWatches()).notified, 1);
  assert.deepEqual(telegram, [`All 2 seasons of Silicon Valley (2014) are now available in ${serverName()}.`]);
});

test('a season-scoped watch completes when its season is in even if a later season is missing', async (t) => {
  const { telegram } = await fixture(t, { sonarr: 'managed', hasFile: (season) => season <= 2, airDate: () => past });
  assert.equal((await requestWatch({ seasonNumber: 2 })).status, 'already-available');

  await createMediaAvailabilityWatch({ ...show, seasonNumber: 2, resourceId: 'telegram:4242', threadId: 'grace', channel: 'telegram' });
  assert.equal((await sweepMediaAvailabilityWatches()).notified, 1);
  assert.deepEqual(telegram, [`Silicon Valley (2014) season 2 is now available in ${serverName()}.`]);
});

test('a season-scoped watch stays partial while its own season is still downloading', async (t) => {
  await fixture(t, { sonarr: 'managed', hasFile: (season, episode) => season < 3 || (season === 3 && episode <= 4), airDate: () => past });
  const result = await requestWatch({ seasonNumber: 3 });
  assert.equal(result.status, 'partially-available');
  assert.equal(result.summary, `Some episodes of Silicon Valley (2014) are on ${serverName()} now. I'll message you here when season 3 finishes.`);
});

test('a show Sonarr does not manage keeps the Plex-only availability behavior', async (t) => {
  const { telegram } = await fixture(t, { sonarr: 'unmanaged', hasFile: (season) => season === 1, airDate: () => past });
  assert.equal((await requestWatch()).status, 'already-available');

  await createMediaAvailabilityWatch({ ...show, resourceId: 'telegram:4242', threadId: 'grace', channel: 'telegram' });
  assert.equal((await sweepMediaAvailabilityWatches()).notified, 1);
  assert.deepEqual(telegram, [`Silicon Valley (2014) is now available in ${serverName()}.`]);
});

test('a Sonarr outage never reports a playable show as complete', async (t) => {
  const { telegram } = await fixture(t, { sonarr: 'error', hasFile: () => true, airDate: () => past });
  const result = await requestWatch();
  assert.equal(result.status, 'created');
  assert.match(result.summary, /will message you here/);

  const totals = await sweepMediaAvailabilityWatches();
  assert.equal(totals.notified, 0);
  assert.deepEqual(telegram, []);
  const watch = await storedWatch('telegram:4242');
  assert.equal(watch.status, 'active');
  assert.equal(watch.lastSnapshot?.status, 'service-unavailable');
});
