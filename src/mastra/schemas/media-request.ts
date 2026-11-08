import { z } from 'zod';

export const mediaTypeSchema = z.enum(['movie', 'tv', 'unknown']);
const optionalNumber = (schema: z.ZodNumber) => z.preprocess(
  (value) => (value === null ? undefined : value),
  schema.optional(),
);
const optionalString = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.string().optional(),
);

export const mediaQualityObjectiveSchema = z.enum(['household-default', '4k-dv-atmos-hard']);

export const mediaRequestInputSchema = z.object({
  title: z.string().min(1),
  requester: z.string().min(1).default('admin'),
  mediaType: mediaTypeSchema.default('unknown'),
  year: optionalNumber(z.number().int().min(1888).max(2100)),
  tmdbId: optionalNumber(z.number().int().positive()),
  notifyWhenAvailable: z.boolean().default(false),
  notificationChannel: z.enum(['slack', 'telegram', 'whatsapp', 'none']).default('slack'),
  notes: optionalString,
  qualityObjective: mediaQualityObjectiveSchema.default('household-default'),
});

export type MediaRequestInput = z.infer<typeof mediaRequestInputSchema>;

export const mediaRequestPlanSchema = z.object({
  status: z.enum(['ready-for-lookup', 'needs-clarification']),
  requester: z.string(),
  title: z.string(),
  mediaType: mediaTypeSchema,
  year: z.number().int().optional(),
  tmdbId: z.number().int().positive().optional(),
  notifyWhenAvailable: z.boolean(),
  notificationChannel: z.enum(['slack', 'telegram', 'whatsapp', 'none']),
  qualityObjective: mediaQualityObjectiveSchema.default('household-default'),
  ambiguityReasons: z.array(z.string()).default([]),
  nextChecks: z.array(z.string()).default([]),
  approvalRequiredBefore: z.array(z.string()).default([]),
});

export type MediaRequestPlan = z.infer<typeof mediaRequestPlanSchema>;

const rawMediaRequestCreateInputSchema = z.object({
  title: z.string().min(1),
  requester: z.string().min(1).default('admin'),
  mediaType: z.enum(['movie', 'tv']),
  year: optionalNumber(z.number().int().min(1888).max(2100)),
  tmdbId: optionalNumber(z.number().int().positive()),
  notifyWhenAvailable: z.boolean().default(false),
  notificationChannel: z.enum(['slack', 'telegram', 'whatsapp', 'none']).default('none'),
  notes: optionalString,
  qualityObjective: mediaQualityObjectiveSchema.default('household-default'),
  episodeScope: z.string().min(1).optional().describe('Preserve an episode-only or date-limited request verbatim; the season-only request API must not silently broaden it.'),
  seasons: z.preprocess(
    (value) => (value === null || (Array.isArray(value) && value.length === 0) ? undefined : value),
    z.union([
      z.literal('all'),
      z.array(z.number().int().positive()).min(1).transform((seasons) => [...new Set(seasons)].sort((a, b) => a - b)),
    ]).optional(),
  ),
});

export const mediaRequestCreateInputSchema = rawMediaRequestCreateInputSchema.transform((request) => {
  if (request.year === undefined) return request;

  const trailingYear = new RegExp(`\\s*\\(${request.year}\\)\\s*$`);
  return {
    ...request,
    title: request.title.replace(trailingYear, '').trim(),
  };
});

export type MediaRequestCreateInput = z.infer<typeof mediaRequestCreateInputSchema>;

export const mediaRequestCreateOutputSchema = z.object({
  status: z.enum(['created', 'already-available', 'already-requested', 'blocked', 'needs-season-scope', 'service-unavailable']),
  requester: z.string(),
  title: z.string(),
  mediaType: z.enum(['movie', 'tv']),
  year: z.number().int().optional(),
  tmdbId: z.number().int().positive().optional(),
  requestId: z.number().int().positive().optional(),
  requestStatus: z.string().optional(),
  notifyWhenAvailable: z.boolean(),
  notificationChannel: z.enum(['slack', 'telegram', 'whatsapp', 'none']),
  qualityObjective: mediaQualityObjectiveSchema.default('household-default'),
  seasonCount: z.number().int().positive().optional(),
  suggestedSeasons: z.array(z.number().int().positive()).optional(),
  summary: z.string(),
  ledgerPath: z.string().optional(),
  correlationId: z.string().optional(),
});

export type MediaRequestCreateOutput = z.infer<typeof mediaRequestCreateOutputSchema>;
