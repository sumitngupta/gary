import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createClient, type Client } from '@libsql/client';

export type GaryPerformanceRun = {
  runId: string;
  recordedAt: string;
  durationMs: number;
  finishReason: string;
  stepCount: number;
  toolCallCount: number;
  toolNames: string[];
  dynamicallyLoadedTools: string[];
  retryCount: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gary_performance_runs (
  run_id TEXT PRIMARY KEY,
  recorded_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  finish_reason TEXT NOT NULL,
  step_count INTEGER NOT NULL,
  tool_call_count INTEGER NOT NULL,
  tool_names_json TEXT NOT NULL,
  dynamically_loaded_tools_json TEXT NOT NULL,
  retry_count INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  cached_input_tokens INTEGER NOT NULL,
  cache_creation_input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  reasoning_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gary_performance_recorded_at ON gary_performance_runs(recorded_at);
`;

let client: Client | undefined;
let initPromise: Promise<Client> | undefined;

async function db() {
  if (client) return client;
  initPromise ??= (async () => {
    const path = `${process.env.GARY_DATA_DIR || './data'}/gary-performance.db`;
    await mkdir(dirname(path), { recursive: true });
    const next = createClient({ url: `file:${path}`, timeout: 5000 });
    await next.executeMultiple(SCHEMA);
    client = next;
    return next;
  })();
  return initPromise;
}

export async function recordGaryPerformanceRun(run: GaryPerformanceRun) {
  await (await db()).execute({
    sql: `INSERT OR IGNORE INTO gary_performance_runs
      (run_id, recorded_at, duration_ms, finish_reason, step_count, tool_call_count,
       tool_names_json, dynamically_loaded_tools_json, retry_count, input_tokens,
       cached_input_tokens, cache_creation_input_tokens, output_tokens, reasoning_tokens, total_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [run.runId, run.recordedAt, run.durationMs, run.finishReason, run.stepCount, run.toolCallCount,
      JSON.stringify(run.toolNames), JSON.stringify(run.dynamicallyLoadedTools), run.retryCount,
      run.inputTokens, run.cachedInputTokens, run.cacheCreationInputTokens, run.outputTokens,
      run.reasoningTokens, run.totalTokens],
  });
}

export async function listGaryPerformanceRunsSince(since: string) {
  const result = await (await db()).execute({
    sql: 'SELECT * FROM gary_performance_runs WHERE recorded_at >= ? ORDER BY recorded_at',
    args: [since],
  });
  return result.rows.map((row) => ({
    runId: String(row.run_id),
    recordedAt: String(row.recorded_at),
    durationMs: Number(row.duration_ms),
    finishReason: String(row.finish_reason),
    stepCount: Number(row.step_count),
    toolCallCount: Number(row.tool_call_count),
    toolNames: JSON.parse(String(row.tool_names_json)) as string[],
    dynamicallyLoadedTools: JSON.parse(String(row.dynamically_loaded_tools_json)) as string[],
    retryCount: Number(row.retry_count),
    inputTokens: Number(row.input_tokens),
    cachedInputTokens: Number(row.cached_input_tokens),
    cacheCreationInputTokens: Number(row.cache_creation_input_tokens),
    outputTokens: Number(row.output_tokens),
    reasoningTokens: Number(row.reasoning_tokens),
    totalTokens: Number(row.total_tokens),
  } satisfies GaryPerformanceRun));
}

export function resetGaryPerformanceStoreForTests() { client = undefined; initPromise = undefined; }
