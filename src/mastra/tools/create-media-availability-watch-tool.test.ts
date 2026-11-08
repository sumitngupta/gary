import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMediaAvailabilityWatchTool } from './create-media-availability-watch-tool';
import { mediaAvailabilityWatchInputSchema, type MediaAvailabilityWatchOutput } from '../schemas/media-availability-watch';
import { createMediaAvailabilityWatch, listDueMediaAvailabilityWatches, listMediaAvailabilityWatches, updateMediaAvailabilityWatch } from '../services/media-availability-watch-store';
import { resetGaryOperationsStoreForTests } from '../services/gary-operations-store';
import { checkMediaAvailabilityWatch } from '../services/media-availability-observer';

const title = { title: 'The Karate Kid', year: 2010, tmdbId: 38575, mediaType: 'movie' as const, requester: 'Test requester' };
const identity = { resourceId: 'whatsapp:15555550101', threadId: 'notification-regression' };

async function fixture(t: TestContext, available = false) {
  const dir = await mkdtemp(join(tmpdir(), 'gary-notification-opt-in-'));
  const names = ['GARY_DATA_DIR', 'PLEX_URL', 'PLEX_TOKEN'] as const;
  const previous = names.map((name) => process.env[name]);
  process.env.GARY_DATA_DIR = dir;
  process.env.PLEX_URL = 'http://plex.test';
  process.env.PLEX_TOKEN = 'test-only';
  resetGaryOperationsStoreForTests();
  t.after(async () => {
    resetGaryOperationsStoreForTests();
    names.forEach((name, i) => {
      if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i];
    });
    await rm(dir, { recursive: true, force: true });
  });
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    const path = new URL(url).pathname;
    assert.ok(path.startsWith('/library/'), `Unexpected external call: ${path}`);
    return Response.json({ MediaContainer: path === '/library/sections'
      ? { Directory: [{ key: '1', type: 'movie' }] }
      : { Metadata: available ? [{ title: title.title, year: title.year, type: 'movie', ratingKey: 'test-movie' }] : [] } });
  });
}

async function invoke(channel: 'none' | 'telegram' | 'whatsapp', bound = identity) {
  return await createMediaAvailabilityWatchTool.execute!(
    mediaAvailabilityWatchInputSchema.parse({ ...title, channel, resourceId: 'whatsapp:15555550999', threadId: 'untrusted-input' }),
    { agent: bound } as never,
  ) as MediaAvailabilityWatchOutput;
}

test('notification follow-up upgrades the same internal watch despite model channel none', async (t) => {
  await fixture(t);
  const internal = await createMediaAvailabilityWatch({ ...title, ...identity, channel: 'none' });
  const result = await invoke('none');
  assert.equal(result.status, 'already-active');
  assert.equal(result.watchId, internal.watch.id);
  assert.equal(result.channel, 'whatsapp');
  assert.equal(result.resourceId, identity.resourceId);
  const watches = await listMediaAvailabilityWatches();
  assert.equal(watches.length, 1);
  assert.equal(watches[0].channel, 'whatsapp');
  assert.equal(watches[0].dirty, true);
  assert.match(result.summary, /will message you here/);
  // Repeated opt-in must neither duplicate nor reroute the subscription.
  assert.equal((await invoke('telegram')).watchId, internal.watch.id);
  assert.equal((await listMediaAvailabilityWatches()).length, 1);
});

test('new notification watches bind to the current Telegram chat over model routing', async (t) => {
  await fixture(t);
  const result = await invoke('whatsapp', { resourceId: 'telegram:12345', threadId: 'telegram-test' });
  assert.equal(result.status, 'created');
  assert.equal(result.channel, 'telegram');
  assert.equal((await listMediaAvailabilityWatches())[0].resourceId, 'telegram:12345');
});

test('unsupported destinations fail without creating a watch or promising a message', async (t) => {
  await fixture(t);
  const result = await invoke('whatsapp', { resourceId: 'slack:test', threadId: 'slack-test' });
  assert.equal(result.status, 'service-unavailable');
  assert.doesNotMatch(result.summary, /will message/);
  assert.equal((await listMediaAvailabilityWatches()).length, 0);
});

test('already available title is reported immediately without scheduling another notification', async (t) => {
  await fixture(t, true);
  const result = await invoke('none');
  assert.equal(result.status, 'already-available');
  assert.doesNotMatch(result.summary, /will message/);
  assert.equal((await listMediaAvailabilityWatches()).length, 0);
});

test('internal lifecycle completion records availability without claiming notification delivery', async (t) => {
  await fixture(t, true);
  const { watch } = await createMediaAvailabilityWatch({ ...title, ...identity, channel: 'none' });
  const result = await checkMediaAvailabilityWatch(watch);
  assert.equal(result.notified, false);
  const stored = (await listMediaAvailabilityWatches())[0];
  assert.equal(stored.status, 'available');
  assert.equal(stored.notifiedAt, undefined);
  assert.equal(stored.lastNotificationSentAt, undefined);
  assert.equal((await listDueMediaAvailabilityWatches()).length, 0);
});

test('notification follow-ups reuse pending delivery instead of creating a second notification', async (t) => {
  await fixture(t);
  const { watch } = await createMediaAvailabilityWatch({ ...title, ...identity, channel: 'whatsapp' });
  await updateMediaAvailabilityWatch(watch.id, { status: 'delivery-pending', lastWhatsAppMessageId: 'wamid.test' });
  const result = await invoke('none');
  assert.equal(result.watchId, watch.id);
  assert.equal((await listMediaAvailabilityWatches()).length, 1);
});
