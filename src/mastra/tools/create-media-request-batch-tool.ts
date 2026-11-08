import { setTimeout as delay } from 'node:timers/promises';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { mediaRequestCreateInputSchema, mediaRequestCreateOutputSchema } from '../schemas/media-request';
import { createMediaRequest, ensureMediaRequestLifecycleWatch } from './create-media-request-tool';
import { appendOperationEvent, checkpointOperationBatch, getOperationBatch } from '../services/gary-operations-store';
import { checkGaryMediaHealthGate } from '../services/gary-media-health-gate';
import { serverNameTitle } from '../config/branding';

export const plannedBatchItemSchema = z.object({
  ordinal: z.number().int().nonnegative(),
  title: z.string(),
  disposition: z.enum(['ready', 'unchanged', 'omitted']),
  reason: z.string(),
  request: mediaRequestCreateInputSchema.optional(),
  unchangedResult: mediaRequestCreateOutputSchema.optional(),
});
export type PlannedBatchItem = z.infer<typeof plannedBatchItemSchema>;

const batchResultSchema = z.object({
  ordinal: z.number().int().nonnegative(), title: z.string(),
  status: z.enum(['created', 'already-available', 'already-requested', 'blocked', 'needs-season-scope', 'service-unavailable', 'omitted']),
  summary: z.string(), requestId: z.number().int().positive().optional(), requestStatus: z.string().optional(),
});

const inputSchema = z.object({ batchId: z.string().uuid() });
const outputSchema = z.object({
  status: z.enum(['completed', 'partially-completed', 'failed']), batchId: z.string().uuid(), correlationId: z.string(),
  results: z.array(batchResultSchema), summary: z.string(),
});

function publicResult(item: PlannedBatchItem, result?: z.infer<typeof mediaRequestCreateOutputSchema>) {
  if (item.disposition === 'omitted') return { ordinal: item.ordinal, title: item.title, status: 'omitted' as const, summary: item.reason };
  const value = result || item.unchangedResult!;
  return { ordinal: item.ordinal, title: value.title || item.title, status: value.status, summary: value.summary, requestId: value.requestId, requestStatus: value.requestStatus };
}

export const createMediaRequestBatchTool = createTool({
  id: 'create-media-request-batch',
  description: 'Execute one previously planned and durably authorized Gary media batch by batch ID. Authorization may come from the user\'s explicit exact-set request or a later approval of a frozen preview. Execution is health-gated, throttled, checkpointed, and resumable.',
  inputSchema, outputSchema,
  execute: async ({ batchId }, context) => {
    const resourceId = context.agent?.resourceId; const threadId = context.agent?.threadId;
    if (!resourceId || !threadId) throw new Error('A durable batch requires Gary resource and thread context');
    const batch = await getOperationBatch(batchId);
    if (!batch || batch.resourceId !== resourceId || batch.threadId !== threadId) throw new Error('Batch not found for the current Gary conversation');
    if (batch.status === 'needs-clarification') throw new Error('This batch preview has unresolved or incomplete titles and cannot be approved yet');
    if (!['approved', 'running', 'paused-health'].includes(batch.status)) {
      throw new Error('This batch does not have durable authorization bound to the current conversation');
    }
    const items = z.array(plannedBatchItemSchema).parse(batch.requests);
    const stored = new Map((batch.results as Array<z.infer<typeof batchResultSchema>>).map((result) => [result.ordinal, result]));
    const throttleMs = Math.min(Math.max(Number(process.env.GARY_BATCH_THROTTLE_MS || 500), 0), 10_000);
    let pauseReason: string | undefined;
    await appendOperationEvent({ correlationId: batch.correlationId, resourceId, threadId, batchId, phase: batch.status === 'approved' ? 'batch-started' : 'batch-resumed' });

    for (let index = batch.nextIndex; index < items.length; index++) {
      const item = items[index];
      if (item.disposition !== 'ready') {
        stored.set(item.ordinal, publicResult(item));
        await checkpointOperationBatch(batchId, { status: 'running', nextIndex: index + 1, results: [...stored.values()], failed: [...stored.values()].filter((result) => result.status === 'service-unavailable').length });
        continue;
      }
      const health = await checkGaryMediaHealthGate();
      if (!health.healthy) {
        pauseReason = Object.values(health.checks).filter((check) => !check.healthy).map((check) => check.detail).join('; ');
        await checkpointOperationBatch(batchId, { status: 'paused-health', nextIndex: index, results: [...stored.values()], failed: [...stored.values()].filter((result) => result.status === 'service-unavailable').length });
        await appendOperationEvent({ correlationId: batch.correlationId, resourceId, threadId, batchId, phase: 'health-paused', detail: { index, checks: health.checks } });
        break;
      }
      await appendOperationEvent({ correlationId: batch.correlationId, resourceId, threadId, batchId, phase: 'request-started', detail: { ordinal: item.ordinal, title: item.title } });
      const result = await createMediaRequest(item.request!);
      await ensureMediaRequestLifecycleWatch(item.request!, result, { resourceId, threadId, correlationId: batch.correlationId });
      stored.set(item.ordinal, publicResult(item, result));
      const paused = result.status === 'service-unavailable';
      const results = [...stored.values()].sort((a, b) => a.ordinal - b.ordinal);
      await checkpointOperationBatch(batchId, { status: paused ? 'paused-health' : 'running', nextIndex: paused ? index : index + 1, results, failed: results.filter((entry) => entry.status === 'service-unavailable').length });
      await appendOperationEvent({ correlationId: batch.correlationId, resourceId, threadId, batchId, requestId: result.requestId ? String(result.requestId) : undefined, phase: paused ? 'request-failed' : 'request-finished', detail: { ordinal: item.ordinal, status: result.status } });
      if (paused) break;
      if (throttleMs && index < items.length - 1) await delay(throttleMs);
    }

    const current = (await getOperationBatch(batchId))!;
    const results = [...stored.values()].sort((a, b) => a.ordinal - b.ordinal);
    const unfinished = current.nextIndex < items.length;
    const failed = results.filter((result) => result.status === 'service-unavailable').length;
    const omitted = results.filter((result) => result.status === 'omitted').length;
    const needsSeasonScope = results.filter((result) => result.status === 'needs-season-scope').length;
    const blocked = results.filter((result) => result.status === 'blocked').length;
    const status = unfinished || failed || omitted || needsSeasonScope || blocked ? 'partially-completed' as const : 'completed' as const;
    if (!unfinished) {
      await checkpointOperationBatch(batchId, { status, nextIndex: items.length, results, failed });
      await appendOperationEvent({ correlationId: batch.correlationId, resourceId, threadId, batchId, phase: 'batch-finished', detail: { status, total: items.length, omitted, needsSeasonScope, failed } });
    }
    return { status, batchId, correlationId: batch.correlationId, results,
      summary: unfinished
        ? `${serverNameTitle()} paused after ${results.length} of ${items.length} titles because ${pauseReason || 'a required service is unavailable'}. ${results.length === 0 ? 'Nothing was submitted.' : 'The completed requests are safe and will not repeat.'} Say “retry” and I’ll continue this same batch.`
        : `${results.filter((result) => result.status === 'created').length} requested, ${results.filter((result) => result.status.startsWith('already')).length} already handled, ${needsSeasonScope} need a season choice, ${omitted} unresolved, ${blocked} blocked, ${failed} failed.` };
  },
});
