import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { checkMediaStatuses } from './check-media-statuses-tool';
import { createOperationBatch, appendOperationEvent, checkpointOperationBatch, createPendingIntent } from '../services/gary-operations-store';
import { plannedBatchItemSchema, type PlannedBatchItem } from './create-media-request-batch-tool';
import { serverName } from '../config/branding';

export const planMediaRequestBatchInputSchema = z.object({
  titles: z.array(z.object({ title: z.string().min(1), mediaType: z.enum(['movie', 'tv']), year: z.number().int().min(1888).max(2100).optional(), episodeScope: z.string().min(1).optional(), seasons: z.union([z.literal('all'), z.array(z.number().int().positive()).min(1)]).optional() })).min(1).max(20),
  requester: z.string().min(1).default('admin'), completeSetConfirmed: z.boolean().describe('True only when this list is the complete franchise/catalogue set requested by the user.'),
  authorization: z.enum(['explicit-request', 'preview-required']).default('explicit-request').describe('Use explicit-request only when the user directly asked for this exact set or selected this exact scope from Gary\'s immediately preceding choices. Use preview-required when Gary assembled candidates that the user has not yet chosen to request.'),
  qualityObjective: z.enum(['household-default', '4k-dv-atmos-hard']).default('household-default'),
});
const outputSchema = z.object({ status: z.enum(['approved', 'ready-for-approval', 'needs-clarification']), batchId: z.string().uuid(), correlationId: z.string(),
  total: z.number().int(), ready: z.number().int(), unchanged: z.number().int(), omitted: z.number().int(), estimatedStorage: z.string(),
  items: z.array(plannedBatchItemSchema.omit({ request: true, unchangedResult: true })), summary: z.string() });

export function batchPreviewStatus(completeSetConfirmed: boolean, ready: number, authorization: 'explicit-request' | 'preview-required') {
  if (!completeSetConfirmed || ready === 0) return 'needs-clarification' as const;
  return authorization === 'explicit-request' ? 'approved' as const : 'ready-for-approval' as const;
}

export const planMediaRequestBatchTool = createTool({
  id: 'plan-media-request-batch', description: 'Read-only resolve and availability-check the complete requested franchise/catalogue set, persist a durable preview, and return the batch ID required for one approval-gated execution.',
  inputSchema: planMediaRequestBatchInputSchema, outputSchema,
  execute: async (input, context) => {
    const parsed = planMediaRequestBatchInputSchema.parse(input); const resourceId = context.agent?.resourceId; const threadId = context.agent?.threadId;
    if (!resourceId || !threadId) throw new Error('A durable batch preview requires Gary resource and thread context');
    const checked = await checkMediaStatuses({ titles: parsed.titles, requester: parsed.requester });
    const items: PlannedBatchItem[] = checked.results.map((result, ordinal) => {
      const label = `${result.resolvedTitle || result.title}${result.resolvedYear ? ` (${result.resolvedYear})` : ''}`;
      if (result.status === 'missing' && result.resolvedTitle && result.resolvedTmdbId && result.mediaType !== 'unknown') return {
        ordinal, title: label, disposition: 'ready', reason: `Resolved and missing from ${serverName()}.`,
        request: { title: result.resolvedTitle, mediaType: result.mediaType, year: result.resolvedYear, tmdbId: result.resolvedTmdbId, requester: parsed.requester, notifyWhenAvailable: false, notificationChannel: 'none', qualityObjective: parsed.qualityObjective, seasons: parsed.titles[ordinal].seasons, episodeScope: parsed.titles[ordinal].episodeScope },
      };
      if (result.status === 'available' || result.status === 'requested') return {
        ordinal, title: label, disposition: 'unchanged', reason: result.summary,
        unchangedResult: { status: result.status === 'available' ? 'already-available' : 'already-requested', requester: parsed.requester, title: result.resolvedTitle || result.title, mediaType: result.mediaType === 'unknown' ? parsed.titles[ordinal].mediaType : result.mediaType, year: result.resolvedYear, tmdbId: result.resolvedTmdbId, notifyWhenAvailable: false, notificationChannel: 'none', qualityObjective: 'household-default', summary: result.summary },
      };
      return { ordinal, title: label, disposition: 'omitted', reason: result.summary };
    });
    const channel = context.requestContext?.get('channel') as { messageId?: string } | undefined;
    const batch = await createOperationBatch({ resourceId, threadId, requests: items, correlationId: channel?.messageId });
    const counts = { ready: items.filter((item) => item.disposition === 'ready').length, unchanged: items.filter((item) => item.disposition === 'unchanged').length, omitted: items.filter((item) => item.disposition === 'omitted').length };
    await appendOperationEvent({ correlationId: batch.correlationId, resourceId, threadId, batchId: batch.id, phase: 'batch-previewed', detail: { total: items.length, ...counts, completeSetConfirmed: parsed.completeSetConfirmed, estimatedStorage: 'unknown until releases are selected' } });
    // Unresolved titles are explicitly omitted from the frozen preview. They
    // must not prevent approval of the exact resolved subset when the user has
    // confirmed this was the complete candidate list.
    const status = batchPreviewStatus(parsed.completeSetConfirmed, counts.ready, parsed.authorization);
    await checkpointOperationBatch(batch.id, { status, nextIndex: 0, results: [], failed: 0 });
    if (status === 'approved') await appendOperationEvent({
      correlationId: batch.correlationId, resourceId, threadId, batchId: batch.id, phase: 'batch-approved',
      detail: { source: 'explicit-user-request', ready: counts.ready },
    });
    if (status === 'ready-for-approval') await createPendingIntent({
      resourceId, threadId, kind: 'batch-request-approval', correlationId: batch.correlationId,
      question: `Request the ${counts.ready} resolved missing title${counts.ready === 1 ? '' : 's'} in this preview${counts.omitted ? ` (${counts.omitted} unresolved omitted)` : ''}?`,
      options: [{ key: 'approve', label: `Approve ${counts.ready} exact request${counts.ready === 1 ? '' : 's'}`, aliases: ['yes', 'approve', 'go ahead', 'all', 'do it'], value: { batchId: batch.id } }],
      payload: { batchId: batch.id, total: items.length, ...counts },
    });
    const countSummary = `${counts.ready} to request, ${counts.unchanged} already handled, ${counts.omitted} unresolved`;
    return { status, batchId: batch.id, correlationId: batch.correlationId, total: items.length, ...counts, estimatedStorage: 'Unknown until releases are selected; no unsupported size estimate was invented.', items: items.map(({ ordinal, title, disposition, reason }) => ({ ordinal, title, disposition, reason })), summary: status === 'approved'
      ? `The user already authorized this exact set (${countSummary}). Call createMediaRequestBatch now with this batch ID; do not ask for approval again.`
      : `Prepared the exact set (${countSummary}). Ask one natural confirmation without exposing the batch ID or internal mechanics.` };
  },
});
