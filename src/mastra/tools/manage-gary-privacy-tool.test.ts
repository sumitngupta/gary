import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// Several Gary stores resolve their file paths at import time.
const dataDir = mkdtempSync(join(tmpdir(), 'gary-privacy-'));
process.env.GARY_DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));

const {
  addGaryListItems, confirmGaryListPublish, createGaryListPublishPreview, exportGaryListsForResource, listGaryShelfCollectionLinks, recordGaryShelfCollectionLink,
} = await import('../services/gary-list-store');
const { GARY_DELETE_CONFIRMATION_PHRASE } = await import('../services/gary-confirmation-store');
const { manageGaryPrivacyTool } = await import('./manage-gary-privacy-tool');

const execute = manageGaryPrivacyTool.execute!;
const mastra = { getAgent: () => ({ getMemory: async () => undefined }), schedules: { delete: async () => undefined } };
const as = (resourceId: string) => ({ agent: { resourceId }, mastra }) as any;

test('privacy export includes the user’s lists and delete removes only theirs', async () => {
  const alice = 'whatsapp:15550000001';
  const bob = 'whatsapp:15550000002';
  await addGaryListItems(alice, 'Watchlist', [{ title: 'Heat', year: 1995, mediaType: 'movie', note: 'from Dana' }]);
  await addGaryListItems(bob, 'Watchlist', [{ title: 'Arrival', mediaType: 'movie' }]);

  const exported = await execute({ action: 'export', confirmDelete: false }, as(alice)) as any;
  assert.match(exported.summary, /, 1 list\(s\),/);
  assert.deepEqual(exported.data.lists.map(({ name, items }: any) => ({ name, items })), [
    { name: 'Watchlist', items: [{ title: 'Heat', year: 1995, mediaType: 'movie', note: 'from Dana', addedAt: exported.data.lists[0].items[0].addedAt }] },
  ]);

  const pending = await execute({ action: 'delete', confirmDelete: false }, as(alice)) as any;
  assert.equal(pending.status, 'confirmation-required');
  assert.match(pending.summary, /conversations, lists, availability watches/);
  assert.match(pending.summary, new RegExp(GARY_DELETE_CONFIRMATION_PHRASE));

  const deleted = await execute({ action: 'delete', confirmDelete: true }, as(alice)) as any;
  assert.equal(deleted.status, 'deleted');
  assert.match(deleted.summary, /1 list\(s\) with 1 title\(s\)/);
  assert.deepEqual(await exportGaryListsForResource(alice), []);
  assert.deepEqual((await exportGaryListsForResource(bob)).map((list) => list.items.map((item) => item.title)), [['Arrival']]);
});

test('privacy export shows which lists are published and delete takes the shelf out of Plex', async (t) => {
  const carol = 'whatsapp:15550000003';
  await addGaryListItems(carol, 'Watchlist', [{ title: 'Heat', mediaType: 'movie' }]);
  const [list] = await exportGaryListsForResource(carol);
  await confirmGaryListPublish(carol, (await createGaryListPublishPreview({ resourceId: carol, listId: list.id, title: "Carol's Watchlist", customTitle: false })).id);
  await recordGaryShelfCollectionLink({ listId: list.id, resourceId: carol, mediaType: 'movie', ratingKey: '900' });

  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  const priorToken = process.env.PLEX_TOKEN;
  process.env.PLEX_TOKEN = 'test-token'; process.env.PLEX_URL = 'http://plex.test';
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === 'DELETE') requests.push(`DELETE ${url.pathname}`);
    const body = url.pathname === '/library/sections' ? { MediaContainer: { Directory: [{ key: '1', type: 'movie', title: 'Movies' }] } }
      : url.pathname === '/library/sections/1/collections' ? { MediaContainer: { Metadata: [{ ratingKey: '900', title: "Carol's Watchlist" }] } }
        : { MediaContainer: {} };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    delete process.env.PLEX_URL; if (priorToken === undefined) delete process.env.PLEX_TOKEN; else process.env.PLEX_TOKEN = priorToken;
  });

  const exported = await execute({ action: 'export', confirmDelete: false }, as(carol)) as any;
  assert.deepEqual(exported.data.lists.map(({ name, published, shelfTitle }: any) => ({ name, published, shelfTitle })), [
    { name: 'Watchlist', published: true, shelfTitle: "Carol's Watchlist" },
  ]);

  await execute({ action: 'delete', confirmDelete: false }, as(carol));
  const deleted = await execute({ action: 'delete', confirmDelete: true }, as(carol)) as any;
  assert.match(deleted.summary, / Your published shelves are gone from Plex\.$/);
  assert.deepEqual(requests, ['DELETE /library/collections/900']);
  assert.deepEqual(await listGaryShelfCollectionLinks(carol), []);
});
