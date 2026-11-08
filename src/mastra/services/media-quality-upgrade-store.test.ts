import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { consumeMediaQualityUpgradePlan, createMediaQualityUpgradePlan, resetMediaQualityUpgradeStoreForTests } from './media-quality-upgrade-store';

test('quality upgrade plans are actor-bound, expiring, and single-use', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gary-quality-upgrade-')); const previous = process.env.GARY_DATA_DIR;
  process.env.GARY_DATA_DIR = dir; resetMediaQualityUpgradeStoreForTests();
  const item = { title: 'Movie Alpha', mediaType: 'movie' as const, arrId: 7, currentProfileId: 6, targetProfileId: 8, currentBytes: 100, fileCount: 1, failures: ['No Dolby Vision.'] };
  try {
    const now = new Date('2026-08-03T00:00:00Z');
    const first = await createMediaQualityUpgradePlan('whatsapp:owner', [item], now);
    assert.equal(await consumeMediaQualityUpgradePlan(first.id, 'whatsapp:other', now), undefined);
    assert.deepEqual(await consumeMediaQualityUpgradePlan(first.id, 'whatsapp:owner', now), [item]);
    assert.equal(await consumeMediaQualityUpgradePlan(first.id, 'whatsapp:owner', now), undefined);
    const expired = await createMediaQualityUpgradePlan('whatsapp:owner', [item], now);
    assert.equal(await consumeMediaQualityUpgradePlan(expired.id, 'whatsapp:owner', new Date(now.getTime() + 31 * 60_000)), undefined);
  } finally {
    resetMediaQualityUpgradeStoreForTests();
    if (previous === undefined) delete process.env.GARY_DATA_DIR; else process.env.GARY_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
