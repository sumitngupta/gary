import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectionOwner, consumePlexCollectionPreview, createPlexCollectionPreview, recordCollectionOwner, removeCollectionOwner, replaceCollectionOwner, resetPlexCollectionStoreForTests } from './plex-collection-store';

async function isolated(run: () => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'plex-collections-')); const prior = process.env.GARY_DATA_DIR;
  process.env.GARY_DATA_DIR = directory; resetPlexCollectionStoreForTests();
  try { await run(); } finally { resetPlexCollectionStoreForTests(); if (prior === undefined) delete process.env.GARY_DATA_DIR; else process.env.GARY_DATA_DIR = prior; await rm(directory, { recursive: true, force: true }); }
}

test('collection ownership follows a recreated rating key and remains actor scoped', async () => isolated(async () => {
  await recordCollectionOwner('100', 'whatsapp:one');
  assert.equal(await collectionOwner('100'), 'whatsapp:one');
  await replaceCollectionOwner('100', '101', 'whatsapp:one');
  assert.equal(await collectionOwner('100'), undefined);
  assert.equal(await collectionOwner('101'), 'whatsapp:one');
  await removeCollectionOwner('101', 'whatsapp:other');
  assert.equal(await collectionOwner('101'), 'whatsapp:one');
  await removeCollectionOwner('101', 'whatsapp:one');
  assert.equal(await collectionOwner('101'), undefined);
}));

test('collection previews are creator-bound, expiring, atomic, and single-use', async () => isolated(async () => {
  const now = new Date('2026-08-24T00:00:00Z');
  const preview = await createPlexCollectionPreview({ actorId: 'whatsapp:one', input: { action: 'create', mediaType: 'movie', collectionTitle: 'Canary', add: [], remove: [] }, available: [], alreadyRequested: [], missing: [], ambiguous: [], removed: [] }, now);
  assert.equal(await consumePlexCollectionPreview(preview.id, 'whatsapp:other', now), undefined);
  assert.equal((await consumePlexCollectionPreview(preview.id, 'whatsapp:one', now))?.input.collectionTitle, 'Canary');
  assert.equal(await consumePlexCollectionPreview(preview.id, 'whatsapp:one', now), undefined);
  const expired = await createPlexCollectionPreview({ actorId: 'whatsapp:one', input: { action: 'delete', mediaType: 'movie', collectionTitle: 'Old', add: [], remove: [] }, available: [], alreadyRequested: [], missing: [], ambiguous: [], removed: [] }, now);
  assert.equal(await consumePlexCollectionPreview(expired.id, 'whatsapp:one', new Date('2026-08-24T00:16:00Z')), undefined);
}));
