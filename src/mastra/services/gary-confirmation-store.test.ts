import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  beginGaryDeletionConfirmation,
  cancelGaryDeletionConfirmation,
  consumeGaryDeletionConfirmation,
  GARY_DELETE_CONFIRMATION_PHRASE,
  resetGaryConfirmationStoreForTests,
} from './gary-confirmation-store';

async function isolated(run: () => Promise<void>) {
  const previous = process.env.GARY_DATA_DIR;
  const path = await mkdtemp(join(tmpdir(), 'gary-confirmations-'));
  process.env.GARY_DATA_DIR = path;
  resetGaryConfirmationStoreForTests();
  try { await run(); } finally {
    resetGaryConfirmationStoreForTests();
    if (previous === undefined) delete process.env.GARY_DATA_DIR;
    else process.env.GARY_DATA_DIR = previous;
    await rm(path, { recursive: true, force: true });
  }
}

test('deletion confirmation is scoped, exact, and single use', () => isolated(async () => {
  await beginGaryDeletionConfirmation('whatsapp:+15550001');
  assert.equal(await consumeGaryDeletionConfirmation('whatsapp:+15550002', GARY_DELETE_CONFIRMATION_PHRASE), false);
  assert.equal(await consumeGaryDeletionConfirmation('whatsapp:+15550001', 'yes delete it'), false);
  assert.equal(await consumeGaryDeletionConfirmation('whatsapp:+15550001', 'delete my gary data'), false);
  assert.equal(await consumeGaryDeletionConfirmation('whatsapp:+15550001', GARY_DELETE_CONFIRMATION_PHRASE), true);
  assert.equal(await consumeGaryDeletionConfirmation('whatsapp:+15550001', GARY_DELETE_CONFIRMATION_PHRASE), false);
}));

test('deletion confirmation can be cancelled and expires', () => isolated(async () => {
  const started = new Date('2026-07-17T00:00:00.000Z');
  await beginGaryDeletionConfirmation('whatsapp:+15550001', started);
  assert.equal(await cancelGaryDeletionConfirmation('whatsapp:+15550001', new Date('2026-07-17T00:01:00.000Z')), true);
  assert.equal(await consumeGaryDeletionConfirmation('whatsapp:+15550001', GARY_DELETE_CONFIRMATION_PHRASE, new Date('2026-07-17T00:02:00.000Z')), false);

  await beginGaryDeletionConfirmation('whatsapp:+15550001', started);
  assert.equal(await consumeGaryDeletionConfirmation('whatsapp:+15550001', GARY_DELETE_CONFIRMATION_PHRASE, new Date('2026-07-17T00:16:00.000Z')), false);
}));
