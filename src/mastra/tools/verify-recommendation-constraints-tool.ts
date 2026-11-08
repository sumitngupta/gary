import { createTool } from '@mastra/core/tools';
import { garyRecommendationVerificationInputSchema, garyRecommendationVerificationOutputSchema } from '../workflows/gary-recommendation-verification-workflow';

export const verifyRecommendationConstraintsTool = createTool({
  id: 'verify-recommendation-constraints',
  description: 'Deterministically require source evidence for every user-specified recommendation constraint on every candidate. Candidates missing any constraint evidence are excluded.',
  inputSchema: garyRecommendationVerificationInputSchema, outputSchema: garyRecommendationVerificationOutputSchema,
  mcp: { annotations: { title: 'Verify Recommendation Constraints', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  execute: async (input, context) => {
    const workflow = context.mastra?.getWorkflow('garyRecommendationVerification');
    if (!workflow) throw new Error('The registered recommendation-verification workflow is unavailable.');
    const run = await workflow.createRun();
    const result = await run.start({ inputData: input });
    if (result.status !== 'success') throw new Error(`Recommendation-verification workflow ended with ${result.status}.`);
    return garyRecommendationVerificationOutputSchema.parse(result.result);
  },
});
