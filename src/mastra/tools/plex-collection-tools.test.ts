import assert from 'node:assert/strict';
import test from 'node:test';
import { executePlexCollectionChangeTool, inspectPlexCollectionsTool, previewPlexCollectionChangeTool, restoreCollectionSnapshot } from './plex-collection-tools';

test('Plex collection tools keep inspection and preview read-only and execution conversationally bound', () => {
  assert.equal(inspectPlexCollectionsTool.requireApproval, false);
  assert.equal(previewPlexCollectionChangeTool.requireApproval, false);
  assert.equal(executePlexCollectionChangeTool.requireApproval, false);
});

test('a failed Plex collection restore is reported instead of dropped', async () => {
  const outcome = await restoreCollectionSnapshot(async () => { throw new Error('Plex returned 500'); });
  assert.deepEqual(outcome, { restored: false, error: 'Plex returned 500' });
});

test('a successful Plex collection restore reports the new collection key', async () => {
  const outcome = await restoreCollectionSnapshot(async () => '4242');
  assert.deepEqual(outcome, { restored: true, ratingKey: '4242' });
});
