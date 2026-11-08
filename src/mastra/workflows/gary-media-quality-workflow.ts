import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { getArrMediaQualityAudit } from '../services/arr-readonly-client';

const titleSchema = z.object({
  title: z.string().min(1), mediaType: z.enum(['movie', 'tv']), year: z.number().int().optional(),
  tmdbId: z.number().int().positive().optional(), tvdbId: z.number().int().positive().optional(),
});
const inputSchema = z.object({
  titles: z.array(titleSchema).min(1).max(100),
  objective: z.object({
    minimumResolution: z.enum(['1080p', '2160p']).default('2160p'),
    requireDolbyVision: z.boolean().default(false), requireAtmos: z.boolean().default(false),
    strength: z.enum(['hard', 'prefer']).default('hard'), scope: z.literal('request').default('request'),
  }),
});
const fileSchema = z.object({
  fileId: z.number().int().optional(), size: z.number().int().optional(), quality: z.string().optional(), resolution: z.number(),
  dynamicRange: z.string().optional(), audioCodec: z.string().optional(), audioChannels: z.number().optional(),
  customFormats: z.array(z.string()), customFormatScore: z.number().optional(), hasDolbyVision: z.boolean(), hasAtmos: z.boolean(),
});
const resultSchema = z.object({
  title: z.string(), year: z.number().int().optional(), mediaType: z.enum(['movie', 'tv']),
  status: z.enum(['compliant', 'noncompliant', 'missing', 'not-tracked', 'unknown']),
  files: z.array(fileSchema), failures: z.array(z.string()), action: z.enum(['none', 'acquire', 'upgrade', 'monitor', 'review']),
  replacementApprovalRequired: z.boolean(),
});
const outputSchema = z.object({
  status: z.enum(['audited', 'partial', 'service-unavailable']), objective: inputSchema.shape.objective,
  results: z.array(resultSchema), totalCurrentBytes: z.number(), replacementApprovalRequired: z.boolean(),
  summary: z.string(), mutation: z.literal(false),
});

type Input = z.infer<typeof inputSchema>;
type Output = z.infer<typeof outputSchema>;
type QualityAudit = (input: { query: string; mediaType: 'movie' | 'tv'; year?: number; tmdbId?: number; tvdbId?: number }) => Promise<{
  title: string; year?: number; mediaType: 'movie' | 'tv'; monitored: boolean; files: z.infer<typeof fileSchema>[];
} | undefined>;

export async function auditMediaQualityObjective(
  inputValue: Input,
  qualityAudit: QualityAudit = getArrMediaQualityAudit,
): Promise<Output> {
  const input = inputSchema.parse(inputValue);
  const targetResolution = input.objective.minimumResolution === '2160p' ? 2160 : 1080;
  const settled = await Promise.all(input.titles.map(async (title) => {
    try {
      const audit = await qualityAudit({ ...title, query: title.title });
      if (!audit) return { title: title.title, year: title.year, mediaType: title.mediaType, status: 'not-tracked' as const, files: [], failures: ['Title is not tracked in the corresponding Arr service.'], action: 'acquire' as const, replacementApprovalRequired: false };
      if (!audit.files.length) return { title: audit.title, year: audit.year, mediaType: title.mediaType, status: 'missing' as const, files: [], failures: ['No imported files are present.'], action: 'acquire' as const, replacementApprovalRequired: false };
      const failures = audit.files.flatMap((file, index) => [
        file.resolution < targetResolution ? `File ${index + 1} is below ${input.objective.minimumResolution}.` : undefined,
        input.objective.requireDolbyVision && !file.hasDolbyVision ? `File ${index + 1} has no verified Dolby Vision evidence.` : undefined,
        input.objective.requireAtmos && !file.hasAtmos ? `File ${index + 1} has no verified Atmos evidence.` : undefined,
      ].filter((value): value is string => Boolean(value)));
      return { title: audit.title, year: audit.year, mediaType: title.mediaType, status: failures.length ? 'noncompliant' as const : 'compliant' as const,
        files: audit.files, failures, action: failures.length ? 'upgrade' as const : 'none' as const, replacementApprovalRequired: failures.length > 0 };
    } catch (error) {
      return { title: title.title, year: title.year, mediaType: title.mediaType, status: 'unknown' as const, files: [], failures: [error instanceof Error ? error.message : String(error)], action: 'review' as const, replacementApprovalRequired: false };
    }
  }));
  const unknown = settled.filter((item) => item.status === 'unknown').length;
  const replacements = settled.filter((item) => item.replacementApprovalRequired).length;
  return outputSchema.parse({ status: unknown === settled.length ? 'service-unavailable' : unknown ? 'partial' : 'audited', objective: input.objective,
    results: settled, totalCurrentBytes: settled.flatMap((item) => item.files).reduce((sum, file) => sum + (file.size || 0), 0),
    replacementApprovalRequired: replacements > 0,
    summary: `${settled.length - unknown}/${settled.length} title(s) audited; ${settled.filter((item) => item.status === 'compliant').length} compliant, ${replacements} require an approval-gated upgrade, and ${settled.filter((item) => ['missing', 'not-tracked'].includes(item.status)).length} require acquisition.`, mutation: false });
}

const auditStep = createStep({ id: 'audit-gary-media-quality-objective', inputSchema, outputSchema, execute: ({ inputData }) => auditMediaQualityObjective(inputData) });
export const garyMediaQualityWorkflow = createWorkflow({ id: 'gary-media-quality-audit', inputSchema, outputSchema }).then(auditStep).commit();
export { inputSchema as garyMediaQualityInputSchema, outputSchema as garyMediaQualityOutputSchema };
