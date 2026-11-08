import { z } from 'zod';

export const mediaQualityUpgradeCandidateSchema = z.object({
  title: z.string().min(1), mediaType: z.enum(['movie', 'tv']), year: z.number().int().optional(),
  tmdbId: z.number().int().positive().optional(), tvdbId: z.number().int().positive().optional(),
});

export const mediaQualityUpgradeItemSchema = mediaQualityUpgradeCandidateSchema.extend({
  arrId: z.number().int().positive(), currentProfileId: z.number().int().positive(),
  targetProfileId: z.number().int().positive(), currentBytes: z.number().int().nonnegative(),
  fileCount: z.number().int().nonnegative(), failures: z.array(z.string()),
});

export const mediaQualityUpgradePreviewInputSchema = z.object({
  candidates: z.array(mediaQualityUpgradeCandidateSchema).min(1).max(20),
  objective: z.literal('4k-dv-atmos-hard').default('4k-dv-atmos-hard'),
});
export const mediaQualityUpgradePreviewOutputSchema = z.object({
  status: z.enum(['ready', 'nothing-to-upgrade', 'not-found', 'denied', 'service-unavailable']),
  planId: z.string().uuid().optional(), expiresAt: z.string().datetime().optional(),
  items: z.array(mediaQualityUpgradeItemSchema).default([]), totalCurrentBytes: z.number().int().nonnegative(),
  summary: z.string(), mutation: z.literal(false),
});
export const mediaQualityUpgradeExecuteInputSchema = z.object({ planId: z.string().uuid() });
export const mediaQualityUpgradeExecuteOutputSchema = z.object({
  status: z.enum(['started', 'partially-started', 'expired', 'denied', 'failed']),
  started: z.array(mediaQualityUpgradeItemSchema).default([]),
  failed: z.array(mediaQualityUpgradeItemSchema.extend({ error: z.string() })).default([]),
  summary: z.string(), mutation: z.literal(true),
});
export type MediaQualityUpgradeItem = z.infer<typeof mediaQualityUpgradeItemSchema>;
