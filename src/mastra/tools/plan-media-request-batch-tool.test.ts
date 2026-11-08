import assert from 'node:assert/strict';
import test from 'node:test';
import { batchPreviewStatus } from './plan-media-request-batch-tool';

test('a complete candidate list can approve its exact resolved subset', () => {
  assert.equal(batchPreviewStatus(true, 6, 'explicit-request'), 'approved');
  assert.equal(batchPreviewStatus(true, 6, 'preview-required'), 'ready-for-approval');
  assert.equal(batchPreviewStatus(true, 0, 'explicit-request'), 'needs-clarification');
  assert.equal(batchPreviewStatus(false, 6, 'explicit-request'), 'needs-clarification');
});

test('one-title recovery preserves scope without requiring invented companion titles', async () => {
  const { planMediaRequestBatchInputSchema } = await import('./plan-media-request-batch-tool');
  const parsed = planMediaRequestBatchInputSchema.parse({ titles: [{ title: 'Real Time with Bill Maher', mediaType: 'tv', seasons: [24], episodeScope: 'Only new episodes including last Friday' }], completeSetConfirmed: true });
  assert.equal(parsed.titles.length, 1);
  assert.deepEqual(parsed.titles[0].seasons, [24]);
  assert.equal(parsed.titles[0].episodeScope, 'Only new episodes including last Friday');
});
