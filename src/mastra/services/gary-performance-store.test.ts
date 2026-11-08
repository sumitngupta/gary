import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { recordGaryPerformanceRun, resetGaryPerformanceStoreForTests } from './gary-performance-store';

test('stores bounded Gary performance telemetry without conversation content', async () => {
  const previous = process.env.GARY_DATA_DIR;
  const directory = await mkdtemp(join(tmpdir(), 'gary-performance-'));
  process.env.GARY_DATA_DIR = directory; resetGaryPerformanceStoreForTests();
  try {
    await recordGaryPerformanceRun({ runId: 'run-1', recordedAt: '2026-08-03T00:00:00.000Z', durationMs: 1234,
      finishReason: 'stop', stepCount: 3, toolCallCount: 2, toolNames: ['search_tools', 'audit-media-quality-objective'],
      dynamicallyLoadedTools: ['audit-media-quality-objective'], retryCount: 0, inputTokens: 100, cachedInputTokens: 80,
      cacheCreationInputTokens: 10, outputTokens: 20, reasoningTokens: 0, totalTokens: 120 });
    await recordGaryPerformanceRun({ runId: 'run-1', recordedAt: '2026-08-03T00:00:00.000Z', durationMs: 9999,
      finishReason: 'stop', stepCount: 9, toolCallCount: 0, toolNames: [], dynamicallyLoadedTools: [], retryCount: 0,
      inputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 });
    const client = createClient({ url: `file:${directory}/gary-performance.db` });
    const rows = await client.execute('SELECT * FROM gary_performance_runs');
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0]?.duration_ms, 1234);
    assert.equal(rows.rows[0]?.tool_names_json, '["search_tools","audit-media-quality-objective"]');
    assert.equal(Object.keys(rows.rows[0] || {}).some((key) => /message|resource|thread|text|args|result/i.test(key)), false);
    await client.close();
  } finally {
    resetGaryPerformanceStoreForTests();
    if (previous === undefined) delete process.env.GARY_DATA_DIR; else process.env.GARY_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
