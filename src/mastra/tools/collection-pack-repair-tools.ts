import { createTool } from '@mastra/core/tools';
import { collectionPackExecuteInputSchema, collectionPackExecuteOutputSchema, collectionPackReviewInputSchema, collectionPackReviewOutputSchema } from '../schemas/collection-pack-repair';
import { executeCollectionPackPlan, reviewCollectionPackPlan } from '../services/collection-pack-repair';
import { appendOperationEvent } from '../services/gary-operations-store';
import { serverName } from '../config/branding';
import { callerActor } from '../channels/gary-channels';


export const reviewCollectionPackRepairTool = createTool({
  id: 'review-collection-pack-repair',
  description: 'Admin-only read-only review of the latest frozen multi-movie pack recovery plan. Shows the exact additional titles without importing or searching.',
  inputSchema: collectionPackReviewInputSchema,
  outputSchema: collectionPackReviewOutputSchema,
  execute: async (input, context) => {
    const { actorId } = await callerActor(context);
    try {
      const plan = await reviewCollectionPackPlan(actorId, input.planId);
      if (!plan) return { status: input.planId ? 'expired' as const : 'not-found' as const, items: [], summary: 'No active collection-pack import plan was found.', mutation: false as const };
      return { status: 'ready' as const, planId: plan.id, expiresAt: plan.expiresAt, targetTitle: plan.targetTitle, items: plan.items, summary: `${plan.targetTitle} was recovered from a collection pack containing ${plan.items.length} additional exact title(s). Import all of them?`, mutation: false as const };
    } catch (error) {
      return { status: 'service-unavailable' as const, items: [], summary: `Could not inspect the collection pack: ${error instanceof Error ? error.message : String(error)}`, mutation: false as const };
    }
  },
});

export const executeCollectionPackRepairTool = createTool({
  id: 'execute-collection-pack-repair',
  requireApproval: true,
  description: 'Admin-approved execution of one immutable multi-movie pack plan. Adds only the frozen exact sibling titles without searches, then asks Radarr to copy-import their existing downloaded files.',
  inputSchema: collectionPackExecuteInputSchema,
  outputSchema: collectionPackExecuteOutputSchema,
  execute: async ({ planId }, context) => {
    const { actorId } = await callerActor(context);
    try {
      const result = await executeCollectionPackPlan(actorId, planId);
      if (!result) return { status: 'expired' as const, imported: [], failed: [], summary: 'That collection-pack plan expired, was already used, or belongs to another user.', mutation: true as const };
      const status = result.failed.length ? 'failed' as const : 'started' as const;
      await appendOperationEvent({ correlationId: planId, resourceId: actorId, phase: status === 'started' ? 'collection-pack-import-started' : 'collection-pack-import-failed', detail: { imported: result.imported.length, failed: result.failed.length } });
      return { status, imported: result.imported, failed: result.failed, summary: `Started importing ${result.imported.length} additional collection title(s).${result.failed.length ? ` ${result.failed.length} could not be started.` : ''} ${serverName()} availability still requires Plex verification.`, mutation: true as const };
    } catch (error) {
      return { status: 'failed' as const, imported: [], failed: [], summary: `Collection-pack import failed safely: ${error instanceof Error ? error.message : String(error)}`, mutation: true as const };
    }
  },
});
