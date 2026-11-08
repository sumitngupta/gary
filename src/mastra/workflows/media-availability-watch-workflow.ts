import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { mediaAvailabilityWatchSweepOutputSchema } from '../schemas/media-availability-watch';
import { sweepMediaAvailabilityWatches } from '../services/media-availability-observer';

const mediaAvailabilityWatchSweepInputSchema = z.object({
  reason: z.string().default('scheduled-sweep'),
});

const sweepMediaAvailabilityWatchesStep = createStep({
  id: 'sweep-media-availability-watches',
  inputSchema: mediaAvailabilityWatchSweepInputSchema,
  outputSchema: mediaAvailabilityWatchSweepOutputSchema,
  execute: async () => sweepMediaAvailabilityWatches(),
});

export const mediaAvailabilityWatchWorkflow = createWorkflow({
  id: 'media-availability-watch',
  inputSchema: mediaAvailabilityWatchSweepInputSchema,
  outputSchema: mediaAvailabilityWatchSweepOutputSchema,
  schedule: {
    cron: '* * * * *',
    timezone: 'Etc/UTC',
    inputData: {
      reason: 'scheduled-sweep',
    },
  },
})
  .then(sweepMediaAvailabilityWatchesStep)
  .commit();
