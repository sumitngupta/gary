import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { syncGaryListShelves } from '../services/gary-list-shelf-sync';

const outcomeCounts = z.record(z.string(), z.number());

const step = createStep({
  id: 'sync-gary-list-shelves',
  inputSchema: z.object({}),
  outputSchema: z.object({ outcomes: outcomeCounts, unmatched: z.number(), errors: z.array(z.string()) }),
  execute: async () => {
    const receipt = await syncGaryListShelves();
    const outcomes: Record<string, number> = {};
    for (const change of receipt.changes) outcomes[change.outcome] = (outcomes[change.outcome] ?? 0) + 1;
    const failures = receipt.changes.flatMap((change) => change.outcome === 'failed' ? [`${change.listId}/${change.mediaType}: ${change.error}`] : []);
    const summary = { outcomes, unmatched: receipt.unmatched.length, errors: [...receipt.errors, ...failures] };
    console.info(JSON.stringify({ event: 'gary.list-shelf-sync', ...summary }));
    return summary;
  },
});

export const garyListShelfSyncWorkflow = createWorkflow({
  id: 'gary-list-shelf-sync',
  inputSchema: z.object({}),
  outputSchema: step.outputSchema,
  schedule: { cron: '30 4 * * *', timezone: 'America/New_York', inputData: {} },
}).then(step).commit();
