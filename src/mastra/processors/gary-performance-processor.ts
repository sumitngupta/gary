import { randomUUID } from 'node:crypto';
import type { Processor, ProcessInputArgs, ProcessOutputResultArgs } from '@mastra/core/processors';
import { recordGaryPerformanceRun } from '../services/gary-performance-store';

type ToolCall = { toolName?: string; payload?: { toolName?: string } };
type ToolResult = { toolName?: string; payload?: { toolName?: string; result?: unknown }; result?: unknown };

function name(value: ToolCall | ToolResult) {
  return value.toolName || value.payload?.toolName;
}

function loadedTools(result: unknown) {
  if (!result || typeof result !== 'object') return [];
  const value = result as { results?: Array<{ name?: unknown }> };
  return Array.isArray(value.results)
    ? value.results.flatMap((item) => typeof item.name === 'string' ? [item.name] : [])
    : [];
}

export class GaryPerformanceProcessor implements Processor {
  readonly id = 'gary-performance-telemetry';
  readonly name = 'Gary Performance Telemetry';

  processInput({ messages, state }: ProcessInputArgs) {
    state.garyPerformanceStartedAt = Date.now();
    state.garyPerformanceRunId = randomUUID();
    return messages;
  }

  async processOutputResult({ messages, state, result, retryCount }: ProcessOutputResultArgs) {
    const toolCalls = result.steps.flatMap((step) => (step.toolCalls || []) as ToolCall[]);
    const toolNames = toolCalls.flatMap((call) => name(call) ? [name(call)!] : []);
    const dynamic = result.steps.flatMap((step) => ((step.toolResults || []) as ToolResult[]).flatMap((toolResult) => {
      if (name(toolResult) !== 'search_tools') return [];
      return loadedTools(toolResult.result ?? toolResult.payload?.result);
    }));
    const usage = result.usage;
    try {
      await recordGaryPerformanceRun({
        runId: typeof state.garyPerformanceRunId === 'string' ? state.garyPerformanceRunId : randomUUID(),
        recordedAt: new Date().toISOString(),
        durationMs: Math.max(0, Date.now() - (typeof state.garyPerformanceStartedAt === 'number' ? state.garyPerformanceStartedAt : Date.now())),
        finishReason: result.finishReason,
        stepCount: result.steps.length,
        toolCallCount: toolNames.length,
        toolNames: [...new Set(toolNames)],
        dynamicallyLoadedTools: [...new Set(dynamic)],
        retryCount,
        inputTokens: usage.inputTokens || 0,
        cachedInputTokens: usage.cachedInputTokens || 0,
        cacheCreationInputTokens: usage.cacheCreationInputTokens || 0,
        outputTokens: usage.outputTokens || 0,
        reasoningTokens: usage.reasoningTokens || 0,
        totalTokens: usage.totalTokens || 0,
      });
    } catch (error) {
      console.warn(JSON.stringify({ event: 'gary.performance.record-failed', error: error instanceof Error ? error.message : String(error) }));
    }
    return messages;
  }
}
