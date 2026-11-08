import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveGaryShelfItems, syncGaryListShelves, type GaryShelfPlex } from './gary-list-shelf-sync';
import {
  addGaryListItems,
  confirmGaryListPublish,
  createGaryListPublishPreview,
  deleteGaryList,
  getGaryList,
  listGaryShelfCollectionLinks,
  removeGaryListItems,
  renameGaryList,
  resetGaryListStoreForTests,
  type GaryListItem,
} from './gary-list-store';
import type { PlexShelfInventory } from './plex-readonly-client';

const alice = 'whatsapp:15550000001';
const bob = 'whatsapp:15550000002';

const SECTIONS: PlexShelfInventory['sections'] = [
  {
    key: '1',
    mediaType: 'movie',
    items: [
      { ratingKey: '101', title: 'Heat', year: 1995, tmdbIds: [949] },
      { ratingKey: '102', title: 'Arrival', year: 2016, tmdbIds: [329865] },
      { ratingKey: '103', title: 'Dune', year: 2021, tmdbIds: [438631] },
      { ratingKey: '104', title: 'Dune', year: 1984, tmdbIds: [841] },
    ],
  },
  {
    key: '2',
    mediaType: 'tv',
    items: [
      { ratingKey: '201', title: 'Severance', year: 2022, tmdbIds: [95396] },
      { ratingKey: '202', title: 'Heat', year: 2025, tmdbIds: [] },
    ],
  },
];

function fakePlex(collections: PlexShelfInventory['collections'] = []) {
  const state = { collections, mutations: [] as string[], nextKey: 900 };
  const find = (ratingKey: string) => state.collections.find((collection) => collection.ratingKey === ratingKey)!;
  const plex: GaryShelfPlex = {
    loadInventory: async () => ({ sections: SECTIONS, collections: state.collections.map((collection) => ({ ...collection, itemKeys: [...collection.itemKeys] })) }),
    createCollection: async ({ title, sectionKey, ratingKeys }) => {
      const ratingKey = String(state.nextKey++);
      state.collections.push({ ratingKey, title, sectionKey, itemKeys: [...ratingKeys] });
      state.mutations.push(`create ${ratingKey} "${title}" [${ratingKeys.join(',')}]`);
      return ratingKey;
    },
    retitleCollection: async (ratingKey, title, summary) => {
      find(ratingKey).title = title;
      state.mutations.push(`retitle ${ratingKey} "${title}" "${summary}"`);
    },
    addItems: async (ratingKey, itemKeys) => {
      find(ratingKey).itemKeys.push(...itemKeys);
      state.mutations.push(`add ${ratingKey} [${itemKeys.join(',')}]`);
    },
    removeItem: async (ratingKey, itemKey) => {
      const collection = find(ratingKey);
      collection.itemKeys = collection.itemKeys.filter((key) => key !== itemKey);
      state.mutations.push(`remove ${ratingKey} ${itemKey}`);
    },
    deleteCollection: async (ratingKey) => {
      state.collections = state.collections.filter((collection) => collection.ratingKey !== ratingKey);
      state.mutations.push(`delete ${ratingKey}`);
    },
  };
  return { plex, state };
}

async function isolated(run: () => Promise<void>) {
  const prior = process.env.GARY_DATA_DIR;
  const dir = await mkdtemp(join(tmpdir(), 'gary-shelves-'));
  process.env.GARY_DATA_DIR = dir;
  resetGaryListStoreForTests();
  try {
    await run();
  } finally {
    resetGaryListStoreForTests();
    if (prior === undefined) delete process.env.GARY_DATA_DIR; else process.env.GARY_DATA_DIR = prior;
    await rm(dir, { recursive: true, force: true });
  }
}

async function publish(resourceId: string, name: string, title: string) {
  const list = (await getGaryList(resourceId, name))!;
  const preview = await createGaryListPublishPreview({ resourceId, listId: list.id, title, customTitle: false });
  assert.equal((await confirmGaryListPublish(resourceId, preview.id)).status, 'ok');
  return list.id;
}

const outcomes = (receipt: Awaited<ReturnType<typeof syncGaryListShelves>>) =>
  receipt.changes.map(({ title, mediaType, outcome, added, removed }) => ({ title, mediaType, outcome, added, removed }));

function item(fields: Partial<GaryListItem> & Pick<GaryListItem, 'title' | 'mediaType'>): GaryListItem {
  return { id: fields.title, addedAt: '2026-10-31T00:00:00.000Z', ...fields };
}

const inventory: PlexShelfInventory = { sections: SECTIONS, collections: [] };

test('a tmdb id match beats a title and year match', () => {
  const resolution = resolveGaryShelfItems([item({ title: 'Dune', year: 2021, mediaType: 'movie', tmdbId: 841 })], inventory);
  assert.deepEqual(resolution.matched.map(({ mediaType, ratingKey }) => ({ mediaType, ratingKey })), [{ mediaType: 'movie', ratingKey: '104' }]);
  assert.deepEqual(resolution.unmatched, []);
});

test('a title that matches more than one Plex item is left unmatched', () => {
  const resolution = resolveGaryShelfItems([item({ title: 'Dune', mediaType: 'movie' }), item({ title: 'Dune', year: 1984, mediaType: 'movie' })], inventory);
  assert.deepEqual(resolution.matched.map(({ ratingKey }) => ratingKey), ['104']);
  assert.deepEqual(resolution.unmatched.map(({ item: entry, reason }) => [entry.title, entry.year, reason]), [['Dune', undefined, 'ambiguous']]);
});

test('an unknown media type searches both libraries and needs exactly one match', () => {
  const resolution = resolveGaryShelfItems([
    item({ title: 'severance', mediaType: 'unknown' }),
    item({ title: 'Heat', mediaType: 'unknown' }),
    item({ title: 'Heat', year: 1995, mediaType: 'unknown' }),
    item({ title: 'Paddington 3', mediaType: 'unknown' }),
  ], inventory);
  assert.deepEqual(resolution.matched.map(({ item: entry, mediaType, ratingKey }) => [entry.title, mediaType, ratingKey]), [
    ['severance', 'tv', '201'],
    ['Heat', 'movie', '101'],
  ]);
  assert.deepEqual(resolution.unmatched.map(({ item: entry, reason }) => [entry.title, entry.year, reason]), [
    ['Heat', undefined, 'ambiguous'],
    ['Paddington 3', undefined, 'not-in-library'],
  ]);
});

test('the first sync creates one collection per library and a rerun changes nothing', () => isolated(async () => {
  await addGaryListItems(alice, 'Watchlist', [
    { title: 'Heat', year: 1995, mediaType: 'movie', tmdbId: 949 },
    { title: 'Severance', year: 2022, mediaType: 'tv' },
    { title: 'Paddington 3', mediaType: 'movie' },
  ]);
  await addGaryListItems(alice, 'Private', [{ title: 'Arrival', mediaType: 'movie' }]);
  const listId = await publish(alice, 'Watchlist', "Alice's Watchlist");
  const { plex, state } = fakePlex();

  const first = await syncGaryListShelves({ plex });
  assert.deepEqual(state.mutations, ['create 900 "Alice\'s Watchlist" [101]', 'create 901 "Alice\'s Watchlist" [201]']);
  assert.deepEqual(outcomes(first), [
    { title: "Alice's Watchlist", mediaType: 'movie', outcome: 'created', added: ['101'], removed: [] },
    { title: "Alice's Watchlist", mediaType: 'tv', outcome: 'created', added: ['201'], removed: [] },
  ]);
  assert.deepEqual(first.unmatched, [{ listId, resourceId: alice, title: 'Paddington 3', reason: 'not-in-library' }]);
  assert.deepEqual(await listGaryShelfCollectionLinks(), [
    { listId, resourceId: alice, mediaType: 'movie', ratingKey: '900' },
    { listId, resourceId: alice, mediaType: 'tv', ratingKey: '901' },
  ]);

  state.mutations.length = 0;
  const second = await syncGaryListShelves({ plex });
  assert.deepEqual(state.mutations, []);
  assert.deepEqual(second.changes.map((change) => change.outcome), ['unchanged', 'unchanged']);
}));

test('list edits add and remove members, and removing the last match deletes that library’s collection', () => isolated(async () => {
  await addGaryListItems(alice, 'Watchlist', [
    { title: 'Heat', year: 1995, mediaType: 'movie' },
    { title: 'Severance', mediaType: 'tv' },
  ]);
  await publish(alice, 'Watchlist', "Alice's Watchlist");
  const { plex, state } = fakePlex();
  await syncGaryListShelves({ plex });
  state.mutations.length = 0;

  await addGaryListItems(alice, 'Watchlist', [{ title: 'Arrival', year: 2016, mediaType: 'movie' }]);
  await removeGaryListItems(alice, 'Watchlist', [{ title: 'Heat' }, { title: 'Severance' }]);
  const receipt = await syncGaryListShelves({ plex });

  assert.deepEqual(state.mutations, ['add 900 [102]', 'remove 900 101', 'delete 901']);
  assert.deepEqual(outcomes(receipt), [
    { title: "Alice's Watchlist", mediaType: 'movie', outcome: 'updated', added: ['102'], removed: ['101'] },
    { title: "Alice's Watchlist", mediaType: 'tv', outcome: 'deleted', added: [], removed: [] },
  ]);
  assert.deepEqual(state.collections, [{ ratingKey: '900', title: "Alice's Watchlist", sectionKey: '1', itemKeys: ['102'] }]);
  assert.deepEqual((await listGaryShelfCollectionLinks()).map((link) => link.mediaType), ['movie']);
}));

test('renaming a published list retitles its collection', () => isolated(async () => {
  await addGaryListItems(alice, 'Watchlist', [{ title: 'Heat', year: 1995, mediaType: 'movie' }]);
  await publish(alice, 'Watchlist', "Alice's Watchlist");
  const { plex, state } = fakePlex();
  await syncGaryListShelves({ plex });
  state.mutations.length = 0;

  await renameGaryList(alice, 'Watchlist', 'Movie night');
  await syncGaryListShelves({ plex, resourceId: alice });
  assert.deepEqual(state.mutations, ['retitle 900 "Alice\'s Movie night" "Alice\'s Movie night, kept with Gary."']);
}));

test('a deleted list’s collection is swept as an orphan, scoped to that user', () => isolated(async () => {
  await addGaryListItems(alice, 'Watchlist', [{ title: 'Heat', year: 1995, mediaType: 'movie' }]);
  await addGaryListItems(bob, 'Watchlist', [{ title: 'Arrival', year: 2016, mediaType: 'movie' }]);
  const aliceList = await publish(alice, 'Watchlist', "Alice's Watchlist");
  await publish(bob, 'Watchlist', "Bob's Watchlist");
  const { plex, state } = fakePlex();
  await syncGaryListShelves({ plex });
  state.mutations.length = 0;

  await deleteGaryList(alice, 'Watchlist');
  const receipt = await syncGaryListShelves({ plex, resourceId: alice });
  assert.deepEqual(state.mutations, ['delete 900']);
  assert.deepEqual(receipt.changes.map(({ listId, outcome, ratingKey, title }) => ({ listId, outcome, ratingKey, title })), [
    { listId: aliceList, outcome: 'orphan-removed', ratingKey: '900', title: "Alice's Watchlist" },
  ]);
  assert.deepEqual(state.collections.map((collection) => collection.title), ["Bob's Watchlist"]);
  assert.deepEqual((await listGaryShelfCollectionLinks()).map((link) => link.resourceId), [bob]);
}));

test('a shelf whose title collides with an existing collection fails without stopping other shelves', () => isolated(async () => {
  await addGaryListItems(alice, 'Watchlist', [{ title: 'Heat', year: 1995, mediaType: 'movie' }]);
  await addGaryListItems(bob, 'Watchlist', [{ title: 'Arrival', year: 2016, mediaType: 'movie' }]);
  await publish(alice, 'Watchlist', "Alice's Watchlist");
  await publish(bob, 'Watchlist', "Bob's Watchlist");
  const { plex, state } = fakePlex([{ ratingKey: '500', title: 'ALICE’S WATCHLIST', sectionKey: '1', itemKeys: ['103'] }]);

  const receipt = await syncGaryListShelves({ plex });
  assert.deepEqual(state.mutations, ['create 900 "Bob\'s Watchlist" [102]']);
  assert.deepEqual(receipt.changes.map(({ title, outcome, error }) => ({ title, outcome, error })), [
    { title: "Alice's Watchlist", outcome: 'failed', error: 'A Plex collection called "ALICE’S WATCHLIST" already exists.' },
    { title: "Bob's Watchlist", outcome: 'created', error: undefined },
  ]);
  assert.deepEqual((await listGaryShelfCollectionLinks()).map((link) => link.resourceId), [bob]);
}));

test('a Plex outage is reported and changes nothing', () => isolated(async () => {
  await addGaryListItems(alice, 'Watchlist', [{ title: 'Heat', year: 1995, mediaType: 'movie' }]);
  await publish(alice, 'Watchlist', "Alice's Watchlist");
  const { plex } = fakePlex();
  plex.loadInventory = async () => { throw new Error('Plex returned HTTP 503'); };

  assert.deepEqual(await syncGaryListShelves({ plex }), { changes: [], unmatched: [], errors: ['Could not read Plex: Plex returned HTTP 503'] });
  assert.deepEqual(await listGaryShelfCollectionLinks(), []);
}));
