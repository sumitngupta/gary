import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

const evidenceSchema = z.object({ claim: z.string().min(1), sourceUrl: z.string().url(), sourceName: z.string().min(1), authoritative: z.boolean().default(false) });
const constraintSchema = z.object({ id: z.string().min(1), description: z.string().min(1) });
const candidateSchema = z.object({ title: z.string().min(1), year: z.number().int().optional(), evidenceByConstraint: z.record(z.string(), z.array(evidenceSchema)) });
const inputSchema = z.object({ constraints: z.array(constraintSchema).min(1).max(20), candidates: z.array(candidateSchema).min(1).max(100) });
const outputSchema = z.object({
  status: z.literal('verified'), accepted: z.array(candidateSchema.extend({ verifiedConstraintIds: z.array(z.string()) })),
  rejected: z.array(z.object({ title: z.string(), year: z.number().int().optional(), missingConstraintIds: z.array(z.string()), reason: z.string() })),
  summary: z.string(), mutation: z.literal(false),
});

export function verifyRecommendationConstraints(value: z.infer<typeof inputSchema>) {
  const input = inputSchema.parse(value);
  const accepted: z.infer<typeof outputSchema>['accepted'] = [];
  const rejected: z.infer<typeof outputSchema>['rejected'] = [];
  for (const candidate of input.candidates) {
    const verifiedConstraintIds = input.constraints.filter((constraint) => (candidate.evidenceByConstraint[constraint.id] || []).length > 0).map((constraint) => constraint.id);
    const missingConstraintIds = input.constraints.map((constraint) => constraint.id).filter((id) => !verifiedConstraintIds.includes(id));
    if (missingConstraintIds.length) rejected.push({ title: candidate.title, year: candidate.year, missingConstraintIds, reason: `Excluded because evidence is missing for: ${missingConstraintIds.join(', ')}.` });
    else accepted.push({ ...candidate, verifiedConstraintIds });
  }
  return outputSchema.parse({ status: 'verified', accepted, rejected, summary: `${accepted.length} candidate(s) satisfy every evidenced constraint; ${rejected.length} excluded for missing evidence.`, mutation: false });
}

const verifyStep = createStep({ id: 'verify-gary-recommendation-constraints', inputSchema, outputSchema, execute: async ({ inputData }) => verifyRecommendationConstraints(inputData) });
export const garyRecommendationVerificationWorkflow = createWorkflow({ id: 'gary-recommendation-verification', inputSchema, outputSchema }).then(verifyStep).commit();
export { inputSchema as garyRecommendationVerificationInputSchema, outputSchema as garyRecommendationVerificationOutputSchema };
