import assert from 'node:assert/strict';
import test from 'node:test';
import { executeMediaQualityUpgradeTool, previewMediaQualityUpgradeTool } from './media-quality-upgrade-tools';

test('existing-title quality execution is approval-gated while its preview is read-only', () => {
  assert.equal(previewMediaQualityUpgradeTool.requireApproval, false);
  assert.equal(executeMediaQualityUpgradeTool.requireApproval, true);
});

test('a quality preview is denied when no enrolled person is calling', async () => {
  const result = await previewMediaQualityUpgradeTool.execute!({ candidates: [{ title: 'Heat', mediaType: 'movie', year: 1995 }] } as never, { agent: { resourceId: 'telegram:42' } } as never);
  assert.deepEqual(result, { status: 'denied', items: [], totalCurrentBytes: 0, summary: 'Quality upgrades require someone enrolled with Gary.', mutation: false });
});
