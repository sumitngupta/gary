import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readStorageHealth } from './storage-health';

test('classifies media storage pressure using bounded thresholds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'storage-health-'));
  const path = join(directory, 'disk.json');
  try {
    await writeFile(path, JSON.stringify({ pct: 86, avail: '2.6 TB' }));
    assert.deepEqual(await readStorageHealth(path), {
      status: 'warning',
      usedPercent: 86,
      available: '2.6 TB',
      warningAtPercent: 85,
      criticalAtPercent: 92,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('fails closed when the storage snapshot is unavailable', async () => {
  const health = await readStorageHealth('/does/not/exist');
  assert.equal(health.status, 'unavailable');
  assert.equal(health.usedPercent, null);
});
