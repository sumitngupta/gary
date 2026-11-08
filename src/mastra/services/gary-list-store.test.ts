import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  addGaryListItems,
  confirmGaryListPublish,
  createGaryListPublishPreview,
  deleteGaryList,
  deleteGaryListsForResource,
  exportGaryListsForResource,
  getGaryList,
  isGaryShelfTitleTaken,
  listGaryLists,
  listGaryShelfCollectionLinks,
  listPublishedGaryLists,
  recordGaryShelfCollectionLink,
  removeGaryListItems,
  renameGaryList,
  resetGaryListStoreForTests,
  unpublishGaryList,
} from './gary-list-store';

const alice = 'whatsapp:15550000001';
const bob = 'whatsapp:15550000002';

async function isolated(run: () => Promise<void>) {
  const prior = process.env.GARY_DATA_DIR;
  const dir = await mkdtemp(join(tmpdir(), 'gary-lists-'));
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

const titlesOf = async (resourceId: string, name: string) =>
  (await getGaryList(resourceId, name))?.items.map((item) => `${item.title}|${item.year ?? ''}|${item.mediaType}`);

test('same-named lists stay separate per user', () => isolated(async () => {
  await addGaryListItems(alice, 'Watchlist', [{ title: 'Heat', year: 1995, mediaType: 'movie' }]);
  await addGaryListItems(bob, 'Watchlist', [{ title: 'Severance', mediaType: 'tv' }]);

  assert.deepEqual(await titlesOf(alice, 'Watchlist'), ['Heat|1995|movie']);
  assert.deepEqual(await titlesOf(bob, 'Watchlist'), ['Severance||tv']);
  assert.deepEqual((await listGaryLists(alice)).map(({ name, itemCount }) => ({ name, itemCount })), [{ name: 'Watchlist', itemCount: 1 }]);

  assert.equal((await removeGaryListItems(bob, 'Watchlist', [{ title: 'Heat' }])).status, 'ok');
  assert.equal((await deleteGaryList(bob, 'Watchlist')).status, 'ok');
  assert.deepEqual(await titlesOf(alice, 'Watchlist'), ['Heat|1995|movie']);
  assert.equal(await getGaryList(bob, 'Watchlist'), undefined);
}));

test('adds are idempotent and list names ignore case and spacing', () => isolated(async () => {
  const first = await addGaryListItems(alice, 'watchlist', [{ title: 'The  Bear', mediaType: 'tv', note: 'Dana liked it' }]);
  assert.equal(first.status, 'ok');
  assert.equal(first.status === 'ok' && first.created, true);

  const second = await addGaryListItems(alice, '  Watchlist ', [
    { title: 'the bear', mediaType: 'tv' },
    { title: 'Arrival', year: 2016, mediaType: 'movie' },
  ]);
  assert.equal(second.status, 'ok');
  if (second.status !== 'ok') return;
  assert.equal(second.created, false);
  assert.deepEqual(second.added.map((item) => item.title), ['Arrival']);
  assert.deepEqual(second.alreadyPresent.map((item) => item.title), ['The Bear']);
  assert.equal(second.list.name, 'watchlist');

  assert.deepEqual(await titlesOf(alice, 'WATCHLIST'), ['The Bear||tv', 'Arrival|2016|movie']);
  assert.equal((await getGaryList(alice, 'Watchlist'))?.items[0].note, 'Dana liked it');
  assert.equal((await listGaryLists(alice)).length, 1);
}));

test('remove matches by title, needs a year when titles collide, and reports misses', () => isolated(async () => {
  await addGaryListItems(alice, 'Maybe later', [
    { title: 'Dune', year: 1984, mediaType: 'movie' },
    { title: 'Dune', year: 2021, mediaType: 'movie' },
    { title: 'Arrival', year: 2016, mediaType: 'movie' },
  ]);

  const ambiguous = await removeGaryListItems(alice, 'maybe later', [{ title: 'dune' }, { title: 'Arrival' }, { title: 'Heat' }]);
  assert.equal(ambiguous.status, 'ok');
  if (ambiguous.status !== 'ok') return;
  assert.deepEqual(ambiguous.removed.map((item) => item.title), ['Arrival']);
  assert.deepEqual(ambiguous.notFound, [{ title: 'Heat' }]);
  assert.deepEqual(ambiguous.ambiguous[0].matches.map((item) => item.year), [1984, 2021]);
  assert.deepEqual(await titlesOf(alice, 'Maybe later'), ['Dune|1984|movie', 'Dune|2021|movie']);

  const byYear = await removeGaryListItems(alice, 'Maybe later', [{ title: 'Dune', year: 1984 }]);
  assert.equal(byYear.status === 'ok' && byYear.list.itemCount, 1);
  const list = await getGaryList(alice, 'Maybe later');
  const byId = await removeGaryListItems(alice, 'Maybe later', [{ id: list!.items[0].id }]);
  assert.equal(byId.status === 'ok' && byId.removed[0].year, 2021);
  assert.deepEqual(await titlesOf(alice, 'Maybe later'), []);

  assert.deepEqual(await removeGaryListItems(alice, 'Nope', [{ title: 'Dune' }]), { status: 'list-not-found', name: 'Nope' });
}));

test('rename keeps items, refuses collisions, and allows a case-only change', () => isolated(async () => {
  await addGaryListItems(alice, 'Watchlist', [{ title: 'Heat', mediaType: 'movie' }]);
  await addGaryListItems(alice, 'Movie night', [{ title: 'Up', mediaType: 'movie' }]);

  assert.deepEqual(await renameGaryList(alice, 'Watchlist', 'movie NIGHT'), { status: 'name-taken', name: 'Movie night' });
  assert.equal((await renameGaryList(alice, 'Ghost', 'Anything')).status, 'list-not-found');
  assert.equal((await renameGaryList(alice, 'Watchlist', 'x'.repeat(61))).status, 'invalid');

  const renamed = await renameGaryList(alice, 'watchlist', 'Date night');
  assert.equal(renamed.status === 'ok' && renamed.previousName, 'Watchlist');
  assert.deepEqual(await titlesOf(alice, 'date night'), ['Heat||movie']);
  assert.equal(await getGaryList(alice, 'Watchlist'), undefined);

  const recased = await renameGaryList(alice, 'Movie night', 'Movie Night');
  assert.equal(recased.status === 'ok' && recased.list.name, 'Movie Night');

  await renameGaryList(bob, 'Date night', 'Stolen');
  assert.deepEqual(await titlesOf(alice, 'Date night'), ['Heat||movie']);
}));

test('delete-list removes the list and its items', () => isolated(async () => {
  const added = await addGaryListItems(alice, 'Watchlist', [{ title: 'Heat', mediaType: 'movie' }, { title: 'Up', mediaType: 'movie' }]);
  assert.equal(added.status, 'ok');
  assert.deepEqual(await deleteGaryList(alice, 'WATCHLIST'), { status: 'ok', listId: added.list.id, name: 'Watchlist', itemCount: 2, wasPublished: false });
  assert.deepEqual(await listGaryLists(alice), []);
  assert.deepEqual(await deleteGaryList(alice, 'Watchlist'), { status: 'list-not-found', name: 'Watchlist' });

  const recreated = await addGaryListItems(alice, 'Watchlist', [{ title: 'Heat', mediaType: 'movie' }]);
  assert.equal(recreated.status === 'ok' && recreated.added.length, 1);
}));

test('limits return typed results instead of throwing', () => isolated(async () => {
  for (let index = 0; index < 20; index += 1) {
    await addGaryListItems(alice, `List ${index}`, [{ title: 'Heat', mediaType: 'movie' }]);
  }
  assert.deepEqual(await addGaryListItems(alice, 'List 21', [{ title: 'Heat', mediaType: 'movie' }]), { status: 'list-limit', limit: 20 });
  assert.equal((await addGaryListItems(alice, 'List 0', [{ title: 'Up', mediaType: 'movie' }])).status, 'ok');
  assert.equal((await listGaryLists(alice)).length, 20);

  const bulk = Array.from({ length: 199 }, (_, index) => ({ title: `Movie ${index}`, mediaType: 'movie' as const }));
  assert.equal((await addGaryListItems(bob, 'Big', bulk)).status, 'ok');
  assert.deepEqual(
    await addGaryListItems(bob, 'big', [{ title: 'One', mediaType: 'movie' }, { title: 'Two', mediaType: 'movie' }]),
    { status: 'item-limit', name: 'Big', limit: 200, remaining: 1 },
  );
  assert.equal((await addGaryListItems(bob, 'Big', [{ title: 'Movie 0', mediaType: 'movie' }, { title: 'One', mediaType: 'movie' }])).status, 'ok');
  assert.equal((await getGaryList(bob, 'Big'))?.items.length, 200);

  assert.deepEqual(await addGaryListItems(bob, 'x'.repeat(61), [{ title: 'Up', mediaType: 'movie' }]), {
    status: 'invalid',
    reason: 'List names can be at most 60 characters.',
  });
  assert.deepEqual(await addGaryListItems(bob, 'Fresh', [{ title: 'x'.repeat(201), mediaType: 'movie' }]), {
    status: 'invalid',
    reason: 'Titles can be at most 200 characters.',
  });
  assert.deepEqual(await addGaryListItems(bob, 'Fresh', [{ title: 'Up', mediaType: 'movie', note: 'x'.repeat(301) }]), {
    status: 'invalid',
    reason: 'Notes can be at most 300 characters.',
  });
  assert.equal(await getGaryList(bob, 'Fresh'), undefined);

  const tooMany = Array.from({ length: 201 }, (_, index) => ({ title: `Show ${index}`, mediaType: 'tv' as const }));
  assert.deepEqual(await addGaryListItems(bob, 'Fresh', tooMany), { status: 'item-limit', name: 'Fresh', limit: 200, remaining: 200 });
  assert.equal(await getGaryList(bob, 'Fresh'), undefined);
}));

test('privacy export and delete cover only the selected user', () => isolated(async () => {
  await addGaryListItems(alice, 'Watchlist', [{ title: 'Heat', year: 1995, mediaType: 'movie' }]);
  await addGaryListItems(alice, 'Maybe later', [{ title: 'Up', mediaType: 'movie' }, { title: 'Severance', mediaType: 'tv' }]);
  await addGaryListItems(bob, 'Watchlist', [{ title: 'Arrival', mediaType: 'movie' }]);

  const exported = await exportGaryListsForResource(alice);
  assert.deepEqual(
    exported.map((list) => ({ name: list.name, titles: list.items.map((item) => item.title) })).sort((a, b) => a.name.localeCompare(b.name)),
    [{ name: 'Maybe later', titles: ['Up', 'Severance'] }, { name: 'Watchlist', titles: ['Heat'] }],
  );

  assert.deepEqual(await deleteGaryListsForResource(alice), { lists: 2, items: 3, shelves: 0 });
  assert.deepEqual(await exportGaryListsForResource(alice), []);
  assert.deepEqual(await titlesOf(bob, 'Watchlist'), ['Arrival||movie']);
}));

async function listId(resourceId: string, name: string) {
  return (await getGaryList(resourceId, name))!.id;
}

async function publish(resourceId: string, name: string, title: string, customTitle = false) {
  const preview = await createGaryListPublishPreview({ resourceId, listId: await listId(resourceId, name), title, customTitle });
  return confirmGaryListPublish(resourceId, preview.id);
}

test('a publish preview is single-use and bound to the user who made it', () => isolated(async () => {
  await addGaryListItems(alice, 'Watchlist', [{ title: 'Heat', mediaType: 'movie' }]);
  const id = await listId(alice, 'Watchlist');
  const now = new Date('2026-10-31T12:00:00Z');
  const preview = await createGaryListPublishPreview({ resourceId: alice, listId: id, title: "Alice's Watchlist", customTitle: false }, now);

  assert.deepEqual(await confirmGaryListPublish(bob, preview.id, now), { status: 'expired' });
  assert.equal((await getGaryList(alice, 'Watchlist'))!.shelf, undefined);

  assert.deepEqual(await confirmGaryListPublish(alice, preview.id, now), { status: 'ok', listId: id, listName: 'Watchlist', title: "Alice's Watchlist" });
  assert.deepEqual(await confirmGaryListPublish(alice, preview.id, now), { status: 'expired' });
  assert.deepEqual((await listGaryLists(alice)).map((list) => list.shelf), [{ title: "Alice's Watchlist", customTitle: false, publishedAt: '2026-10-31T12:00:00.000Z' }]);
  assert.deepEqual((await listPublishedGaryLists()).map(({ resourceId, listName, title }) => ({ resourceId, listName, title })), [
    { resourceId: alice, listName: 'Watchlist', title: "Alice's Watchlist" },
  ]);
}));

test('a preview cannot publish another user’s list and expires after 15 minutes', () => isolated(async () => {
  await addGaryListItems(alice, 'Watchlist', [{ title: 'Heat', mediaType: 'movie' }]);
  const aliceList = await listId(alice, 'Watchlist');
  const now = new Date('2026-10-31T12:00:00Z');

  const forged = await createGaryListPublishPreview({ resourceId: bob, listId: aliceList, title: "Bob's Watchlist", customTitle: true }, now);
  assert.deepEqual(await confirmGaryListPublish(bob, forged.id, now), { status: 'list-not-found' });
  assert.equal((await getGaryList(alice, 'Watchlist'))!.shelf, undefined);

  const stale = await createGaryListPublishPreview({ resourceId: alice, listId: aliceList, title: "Alice's Watchlist", customTitle: false }, now);
  assert.deepEqual(await confirmGaryListPublish(alice, stale.id, new Date('2026-10-31T12:15:00Z')), { status: 'expired' });
  assert.deepEqual(await listPublishedGaryLists(), []);
}));

test('shelf titles are unique across users and unpublish keeps the list', () => isolated(async () => {
  await addGaryListItems(alice, 'Watchlist', [{ title: 'Heat', mediaType: 'movie' }]);
  await addGaryListItems(bob, 'Watchlist', [{ title: 'Up', mediaType: 'movie' }]);
  assert.equal((await publish(alice, 'Watchlist', "Sam's Watchlist")).status, 'ok');
  assert.deepEqual(await publish(bob, 'Watchlist', "SAM'S  watchlist", true), { status: 'title-taken', title: "SAM'S  watchlist" });
  assert.equal(await isGaryShelfTitleTaken("sam's watchlist"), true);

  assert.deepEqual(await unpublishGaryList(bob, 'Watchlist'), { status: 'not-published', listName: 'Watchlist' });
  assert.deepEqual(await unpublishGaryList(alice, 'watchlist'), { status: 'ok', listId: await listId(alice, 'Watchlist'), listName: 'Watchlist', title: "Sam's Watchlist" });
  assert.equal(await isGaryShelfTitleTaken("Sam's Watchlist"), false);
  assert.deepEqual(await titlesOf(alice, 'Watchlist'), ['Heat||movie']);
}));

test('rename re-derives a default shelf title and keeps a custom one', () => isolated(async () => {
  await addGaryListItems(alice, 'Watchlist', [{ title: 'Heat', mediaType: 'movie' }]);
  await addGaryListItems(alice, 'Faves', [{ title: 'Up', mediaType: 'movie' }]);
  await publish(alice, 'Watchlist', "Alice's Watchlist");
  await publish(alice, 'Faves', 'Alice picks', true);

  await renameGaryList(alice, 'Watchlist', 'Movie night');
  await renameGaryList(alice, 'Faves', 'Favorites');
  assert.deepEqual((await listPublishedGaryLists(alice)).map(({ listName, title }) => ({ listName, title })), [
    { listName: 'Movie night', title: "Alice's Movie night" },
    { listName: 'Favorites', title: 'Alice picks' },
  ]);
}));

test('deleting a published list drops the shelf but leaves its Plex link for the sync to sweep', () => isolated(async () => {
  await addGaryListItems(alice, 'Watchlist', [{ title: 'Heat', mediaType: 'movie' }]);
  const id = await listId(alice, 'Watchlist');
  await publish(alice, 'Watchlist', "Alice's Watchlist");
  await recordGaryShelfCollectionLink({ listId: id, resourceId: alice, mediaType: 'movie', ratingKey: '900' });

  assert.deepEqual(await deleteGaryList(alice, 'Watchlist'), { status: 'ok', listId: id, name: 'Watchlist', itemCount: 1, wasPublished: true });
  assert.deepEqual(await listPublishedGaryLists(), []);
  assert.deepEqual(await listGaryShelfCollectionLinks(alice), [{ listId: id, resourceId: alice, mediaType: 'movie', ratingKey: '900' }]);
  assert.deepEqual(await listGaryShelfCollectionLinks(bob), []);
}));

test('privacy delete removes the user’s shelves and leaves other users published', () => isolated(async () => {
  await addGaryListItems(alice, 'Watchlist', [{ title: 'Heat', mediaType: 'movie' }]);
  await addGaryListItems(bob, 'Watchlist', [{ title: 'Up', mediaType: 'movie' }]);
  await publish(alice, 'Watchlist', "Alice's Watchlist");
  await publish(bob, 'Watchlist', "Bob's Watchlist");

  assert.deepEqual(await deleteGaryListsForResource(alice), { lists: 1, items: 1, shelves: 1 });
  assert.deepEqual((await listPublishedGaryLists()).map((shelf) => shelf.title), ["Bob's Watchlist"]);
}));
