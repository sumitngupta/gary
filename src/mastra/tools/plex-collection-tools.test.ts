import assert from 'node:assert/strict';
import test from 'node:test';
import { executePlexCollectionChangeTool, inspectPlexCollectionsTool, previewPlexCollectionChangeTool } from './plex-collection-tools';

test('Plex collection tools keep inspection and preview read-only and execution conversationally bound', () => {
  assert.equal(inspectPlexCollectionsTool.requireApproval, false);
  assert.equal(previewPlexCollectionChangeTool.requireApproval, false);
  assert.equal(executePlexCollectionChangeTool.requireApproval, false);
});
