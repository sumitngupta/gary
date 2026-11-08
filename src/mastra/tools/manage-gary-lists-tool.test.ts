import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { getPendingIntent, resetGaryOperationsStoreForTests } from '../services/gary-operations-store';
import { syncGaryListShelves } from '../services/gary-list-shelf-sync';
import { resetGaryListStoreForTests } from '../services/gary-list-store';
import { resetGaryUserProfileStoreForTests, updateGaryUserProfile } from '../services/gary-user-profile-store';
import { manageGaryListsInputSchema, manageGaryListsTool } from './manage-gary-lists-tool';
import { serverName } from '../config/branding';

const execute = manageGaryListsTool.execute!;
const as = (resourceId?: string) => ({ agent: resourceId ? { resourceId, threadId: `thread-${resourceId}` } : {} }) as any;

function resetStores() {
  resetGaryListStoreForTests();
  resetGaryUserProfileStoreForTests();
  resetGaryOperationsStoreForTests();
}

async function isolated(run: () => Promise<void>) {
  const prior = process.env.GARY_DATA_DIR;
  const dir = await mkdtemp(join(tmpdir(), 'gary-lists-tool-'));
  process.env.GARY_DATA_DIR = dir;
  resetStores();
  try {
    await run();
  } finally {
    resetStores();
    if (prior === undefined) delete process.env.GARY_DATA_DIR; else process.env.GARY_DATA_DIR = prior;
    await rm(dir, { recursive: true, force: true });
  }
}

type FakeCollection = { title: string; sectionKey: string; itemKeys: string[] };

function fakePlexServer(t: TestContext, existing: Record<string, FakeCollection> = {}) {
  const collections = new Map(Object.entries(existing));
  const mutations: string[] = [];
  const server = { mutations, down: false };
  const sections: Record<string, Array<{ ratingKey: string; title: string; year: number; Guid: Array<{ id: string }> }>> = {
    '1': [
      { ratingKey: '101', title: 'Heat', year: 1995, Guid: [{ id: 'imdb://tt0113277' }, { id: 'tmdb://949' }] },
      { ratingKey: '102', title: 'Arrival', year: 2016, Guid: [{ id: 'tmdb://329865' }] },
    ],
    '2': [],
  };
  let nextKey = 900;
  const originalFetch = globalThis.fetch;
  const priorToken = process.env.PLEX_TOKEN;
  process.env.PLEX_TOKEN = 'test-token'; process.env.PLEX_URL = 'http://plex.test';
  globalThis.fetch = async (input, init) => {
    if (server.down) throw new Error('connect ECONNREFUSED');
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const path = url.pathname;
    let match: RegExpMatchArray | null;
    if (path === '/identity') return json({ MediaContainer: { machineIdentifier: 'machine-1' } });
    if (path === '/library/sections') return json({ MediaContainer: { Directory: [{ key: '1', type: 'movie', title: 'Movies' }, { key: '2', type: 'show', title: 'TV Shows' }] } });
    if ((match = path.match(/^\/library\/sections\/(\d+)\/all$/))) {
      assert.equal(url.searchParams.get('includeGuids'), '1');
      return json({ MediaContainer: { Metadata: sections[match[1]] } });
    }
    if ((match = path.match(/^\/library\/sections\/(\d+)\/collections$/))) {
      const inSection = [...collections].filter(([, collection]) => collection.sectionKey === match![1]);
      return json({ MediaContainer: { Metadata: inSection.map(([ratingKey, { title }]) => ({ ratingKey, title })) } });
    }
    if ((match = path.match(/^\/library\/metadata\/(\d+)\/children$/))) {
      return json({ MediaContainer: { Metadata: collections.get(match[1])!.itemKeys.map((ratingKey) => ({ ratingKey, title: `item ${ratingKey}` })) } });
    }
    const uriKeys = () => url.searchParams.get('uri')!.replace('server://machine-1/com.plexapp.plugins.library/library/metadata/', '').split(',');
    if (method === 'POST' && path === '/library/collections') {
      const ratingKey = String(nextKey++);
      collections.set(ratingKey, { title: url.searchParams.get('title')!, sectionKey: url.searchParams.get('sectionId')!, itemKeys: uriKeys() });
      mutations.push(`create ${ratingKey} "${url.searchParams.get('title')}" section ${url.searchParams.get('sectionId')} [${uriKeys().join(',')}]`);
      return json({ MediaContainer: { Metadata: [{ ratingKey }] } });
    }
    if (method === 'PUT' && (match = path.match(/^\/library\/metadata\/(\d+)$/))) {
      mutations.push(`metadata ${match[1]} summary "${url.searchParams.get('summary.value')}"`);
      return json({});
    }
    if (method === 'DELETE' && (match = path.match(/^\/library\/collections\/(\d+)$/))) {
      collections.delete(match[1]);
      mutations.push(`delete ${match[1]}`);
      return json({});
    }
    return new Response('', { status: 404 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    delete process.env.PLEX_URL; if (priorToken === undefined) delete process.env.PLEX_TOKEN; else process.env.PLEX_TOKEN = priorToken;
  });
  return server;
}

test('add defaults to the Watchlist and show returns the item', () => isolated(async () => {
  const added = await execute({ action: 'add', items: [{ title: 'Heat', year: 1995, mediaType: 'movie' }] } as any, as('whatsapp:1')) as any;
  assert.equal(added.status, 'ok');
  assert.equal(added.summary, 'Added Heat (1995) to Watchlist.');

  const again = await execute({ action: 'add', list: 'watchlist', items: [{ title: 'heat', year: 1995, mediaType: 'movie' }] } as any, as('whatsapp:1')) as any;
  assert.equal(again.summary, 'Already on Watchlist: Heat (1995).');

  const shown = await execute({ action: 'show', list: 'Watchlist' } as any, as('whatsapp:1')) as any;
  assert.equal(shown.summary, 'Watchlist has 1 title(s): Heat (1995).');
  assert.deepEqual(shown.data.items.map(({ title, year, mediaType }: any) => ({ title, year, mediaType })), [{ title: 'Heat', year: 1995, mediaType: 'movie' }]);

  const overview = await execute({ action: 'overview' } as any, as('whatsapp:1')) as any;
  assert.equal(overview.summary, 'You have 1 list(s): Watchlist (1).');
}));

test('remove, rename, and delete-list report outcomes in plain words', () => isolated(async () => {
  await execute({ action: 'add', list: 'Maybe later', items: [{ title: 'Up', mediaType: 'movie' }, { title: 'Severance', mediaType: 'tv' }] } as any, as('whatsapp:1'));
  await execute({ action: 'add', items: [{ title: 'Heat', mediaType: 'movie' }] } as any, as('whatsapp:1'));

  const removed = await execute({ action: 'remove', list: 'maybe later', items: [{ title: 'up' }, { title: 'Heat' }] } as any, as('whatsapp:1')) as any;
  assert.equal(removed.summary, 'Removed Up from Maybe later. Not on Maybe later: Heat.');

  const taken = await execute({ action: 'rename', list: 'Maybe later', newName: 'WATCHLIST' } as any, as('whatsapp:1')) as any;
  assert.deepEqual(taken, { status: 'name-taken', summary: 'You already have a list called "Watchlist".' });

  const renamed = await execute({ action: 'rename', list: 'Maybe later', newName: 'Someday' } as any, as('whatsapp:1')) as any;
  assert.equal(renamed.summary, 'Renamed Maybe later to Someday.');

  const deleted = await execute({ action: 'delete-list', list: 'someday' } as any, as('whatsapp:1')) as any;
  assert.equal(deleted.summary, 'Deleted Someday and its 1 title(s).');
  const missing = await execute({ action: 'show', list: 'Someday' } as any, as('whatsapp:1')) as any;
  assert.equal(missing.status, 'list-not-found');
}));

test('without a current user the tool is unavailable', () => isolated(async () => {
  const result = await execute({ action: 'overview' } as any, as()) as any;
  assert.deepEqual(result, { status: 'service-unavailable', summary: 'The current user context is unavailable.' });
}));

test('an owner field in the input cannot target another user', () => isolated(async () => {
  await execute({ action: 'add', items: [{ title: 'Arrival', mediaType: 'movie' }] } as any, as('whatsapp:victim'));

  const attempt = await execute({
    action: 'add',
    list: 'Watchlist',
    resourceId: 'whatsapp:victim',
    owner: 'whatsapp:victim',
    items: [{ title: 'Planted', mediaType: 'movie' }],
  } as any, as('whatsapp:attacker')) as any;
  assert.equal(attempt.status, 'ok');

  const victim = await execute({ action: 'show', list: 'Watchlist' } as any, as('whatsapp:victim')) as any;
  assert.deepEqual(victim.data.items.map((item: any) => item.title), ['Arrival']);
  const attacker = await execute({ action: 'show', list: 'Watchlist' } as any, as('whatsapp:attacker')) as any;
  assert.deepEqual(attacker.data.items.map((item: any) => item.title), ['Planted']);

  const parsed = manageGaryListsInputSchema.parse({ action: 'overview', resourceId: 'whatsapp:victim' } as any);
  assert.deepEqual(parsed, { action: 'overview' });
}));

test('the model-facing input schema is a JSON Schema object that OpenAI accepts', async () => {
  const { z } = await import('zod');
  const json = z.toJSONSchema(manageGaryListsTool.inputSchema as any, { io: 'input' }) as any;
  assert.equal(json.type, 'object');
  assert.equal(json.oneOf, undefined);
  assert.equal(json.anyOf, undefined);
});

test('execute validates each action, ignores null fields, and reports incomplete requests', () => isolated(async () => {
  const incomplete = await execute({ action: 'rename', list: 'Watchlist' } as any, as('whatsapp:1')) as any;
  assert.equal(incomplete.status, 'invalid');
  const added = await execute({ action: 'add', list: null, items: [{ title: 'Heat', year: null, mediaType: 'movie', id: null }] } as any, as('whatsapp:1')) as any;
  assert.equal(added.status, 'ok');
  const shown = await execute({ action: 'show', list: 'Watchlist', previewId: null } as any, as('whatsapp:1')) as any;
  assert.deepEqual(shown.data.items.map((item: any) => item.title), ['Heat']);
}));

test('the input schema enforces item bounds and the action union', () => {
  const schema = manageGaryListsInputSchema;
  assert.equal(schema.safeParse({ action: 'add', items: [] }).success, false);
  assert.equal(schema.safeParse({ action: 'add', items: Array.from({ length: 26 }, () => ({ title: 'Up', mediaType: 'movie' })) }).success, false);
  assert.equal(schema.safeParse({ action: 'add', items: [{ title: 'Up', mediaType: 'podcast' }] }).success, false);
  assert.equal(schema.safeParse({ action: 'rename', list: 'Watchlist' }).success, false);
  assert.equal(schema.safeParse({ action: 'share', list: 'Watchlist' }).success, false);
  assert.deepEqual(schema.parse({ action: 'add', items: [{ title: ' Up ', mediaType: 'movie' }] }), {
    action: 'add',
    list: 'Watchlist',
    items: [{ title: 'Up', mediaType: 'movie' }],
  });
});

test(`publishing needs approval, puts only ${serverName()} titles on a named shelf, and unpublish takes it down`, (t) => isolated(async () => {
  const plex = fakePlexServer(t);
  const rita = 'whatsapp:15550000001';
  await execute({ action: 'add', items: [{ title: 'Heat', year: 1995, mediaType: 'movie', tmdbId: 949 }, { title: 'Paddington 3', mediaType: 'movie' }] } as any, as(rita));

  const nameless = await execute({ action: 'publish', list: 'Watchlist' } as any, as(rita)) as any;
  assert.deepEqual(nameless, { status: 'name-needed', summary: 'A published shelf shows your name. Ask what name to show, then publish again with displayName.' });

  await updateGaryUserProfile(rita, { preferredName: 'Rita' });
  const preview = await execute({ action: 'publish', list: 'watchlist' } as any, as(rita)) as any;
  assert.equal(preview.status, 'ready');
  assert.equal(preview.summary, `Ready to publish Watchlist as "Rita's Watchlist". Everyone on ${serverName()} will see this shelf, with your name on it, in the Plex Collections tab. On the shelf now: Heat (1995). Not on ${serverName()} yet, so only on the list: Paddington 3. Nothing gets requested. Publish it?`);
  assert.deepEqual(plex.mutations, []);
  const intent = await getPendingIntent(`thread-${rita}`);
  assert.equal(intent?.kind, 'gary-list-publish-approval');
  assert.deepEqual(intent?.options[0].value, { garyListPublishPreviewId: preview.data.previewId });

  const stolen = await execute({ action: 'confirm-publish', previewId: preview.data.previewId } as any, as('whatsapp:15550000002')) as any;
  assert.equal(stolen.status, 'expired');
  assert.deepEqual(plex.mutations, []);

  const published = await execute({ action: 'confirm-publish', previewId: preview.data.previewId } as any, as(rita)) as any;
  assert.equal(published.status, 'published');
  assert.equal(published.summary, `Published Watchlist as "Rita's Watchlist". Everyone on ${serverName()} can see it in Plex Collections. Created the movie shelf with 1 title(s). Not on ${serverName()} yet, so only on the list: Paddington 3.`);
  assert.deepEqual(plex.mutations, ['create 900 "Rita\'s Watchlist" section 1 [101]', 'metadata 900 summary "Rita\'s Watchlist, kept with Gary."']);

  const overview = await execute({ action: 'overview' } as any, as(rita)) as any;
  assert.equal(overview.summary, 'You have 1 list(s): Watchlist (2, published as "Rita\'s Watchlist").');
  const again = await execute({ action: 'publish', list: 'Watchlist' } as any, as(rita)) as any;
  assert.deepEqual(again, { status: 'already-published', summary: 'Watchlist is already published as "Rita\'s Watchlist".', data: { shelfTitle: "Rita's Watchlist" } });

  const unpublished = await execute({ action: 'unpublish', list: 'Watchlist' } as any, as(rita)) as any;
  assert.equal(unpublished.summary, 'Watchlist is private again. "Rita\'s Watchlist" is gone from Plex.');
  assert.deepEqual(plex.mutations.slice(2), ['delete 900']);
  const shown = await execute({ action: 'show', list: 'Watchlist' } as any, as(rita)) as any;
  assert.equal(shown.summary, 'Watchlist has 2 title(s): Heat (1995), Paddington 3.');
}));

test('publish rejects a shelf title that an existing Plex collection already uses', (t) => isolated(async () => {
  const plex = fakePlexServer(t, { '500': { title: "Bobby's Watchlist", sectionKey: '1', itemKeys: ['102'] } });
  await execute({ action: 'add', items: [{ title: 'Heat', mediaType: 'movie' }] } as any, as('whatsapp:2'));

  const custom = await execute({ action: 'publish', list: 'Watchlist', displayName: 'Bobby', shelfTitle: 'Movie club' } as any, as('whatsapp:2')) as any;
  assert.deepEqual(custom, { status: 'invalid', summary: 'A shelf title must include your name, Bobby.' });
  const taken = await execute({ action: 'publish', list: 'Watchlist', displayName: 'Bobby' } as any, as('whatsapp:2')) as any;
  assert.deepEqual(taken, { status: 'title-taken', summary: 'There is already a Plex collection called "Bobby\'s Watchlist". Choose a different shelf title.' });
  assert.equal(await getPendingIntent('thread-whatsapp:2'), undefined);
  assert.deepEqual(plex.mutations, []);
}));

test('deleting a published list succeeds even when Plex is down', (t) => isolated(async () => {
  const plex = fakePlexServer(t);
  await execute({ action: 'add', items: [{ title: 'Arrival', year: 2016, mediaType: 'movie' }] } as any, as('whatsapp:3'));
  const preview = await execute({ action: 'publish', list: 'Watchlist', displayName: 'Cam' } as any, as('whatsapp:3')) as any;
  await execute({ action: 'confirm-publish', previewId: preview.data.previewId } as any, as('whatsapp:3'));
  assert.deepEqual(plex.mutations[0], 'create 900 "Cam\'s Watchlist" section 1 [102]');

  plex.down = true;
  const deleted = await execute({ action: 'delete-list', list: 'Watchlist' } as any, as('whatsapp:3')) as any;
  assert.equal(deleted.status, 'ok');
  assert.equal(deleted.summary, 'Deleted Watchlist and its 1 title(s). Plex did not take the shelf down yet; Gary tries again every night.');

  plex.down = false;
  const retry = await syncGaryListShelves();
  assert.deepEqual(retry.changes.map((change) => change.outcome), ['orphan-removed']);
  assert.deepEqual(plex.mutations.slice(2), ['delete 900']);
}));
