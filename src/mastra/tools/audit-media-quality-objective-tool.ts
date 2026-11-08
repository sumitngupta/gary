import { createTool } from '@mastra/core/tools';
import { garyMediaQualityInputSchema, garyMediaQualityOutputSchema } from '../workflows/gary-media-quality-workflow';

export const auditMediaQualityObjectiveTool = createTool({
  id: 'audit-media-quality-objective',
  description: 'Read-only, request-scoped audit of exact movie/show files against resolution, Dolby Vision, and Atmos requirements. Produces acquisition and approval-gated upgrade actions without changing profiles, files, or searches.',
  inputSchema: garyMediaQualityInputSchema, outputSchema: garyMediaQualityOutputSchema,
  mcp: { annotations: { title: 'Audit Media Quality Objective', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  execute: async (input, context) => {
    const workflow = context.mastra?.getWorkflow('garyMediaQuality');
    if (!workflow) throw new Error('The registered media-quality workflow is unavailable.');
    const run = await workflow.createRun();
    const result = await run.start({ inputData: input });
    if (result.status !== 'success') throw new Error(`Media-quality workflow ended with ${result.status}.`);
    return garyMediaQualityOutputSchema.parse(result.result);
  },
});
