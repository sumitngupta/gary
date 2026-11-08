import { z } from 'zod';

export const mediaRadarTypeSchema = z.enum(['movie', 'tv']);

export const mediaRadarCandidateSchema = z.object({
  title: z.string().min(1),
  mediaType: mediaRadarTypeSchema,
  year: z.number().int().min(1888).max(2100).optional(),
  source: z.string().min(1).default('manual'),
  sourceUrl: z.string().url().optional(),
  releaseDate: z.string().optional(),
  metascore: z.number().min(0).max(100).optional(),
  userScore: z.number().min(0).max(10).optional(),
  criticReviewCount: z.number().int().min(0).optional(),
  genres: z.array(z.string().min(1)).default([]),
  signals: z.array(z.string().min(1)).default([]),
  alreadyKnown: z.boolean().default(false),
});

export type MediaRadarCandidate = z.infer<typeof mediaRadarCandidateSchema>;

export const mediaRadarPreferencesSchema = z.object({
  requester: z.string().min(1).default('admin'),
  theme: z.string().min(1).default('weekly watchlist radar'),
  minMetascore: z.number().min(0).max(100).default(70),
  minUserScore: z.number().min(0).max(10).default(7),
  minCriticReviewCount: z.number().int().min(0).default(8),
  shortlistSize: z.number().int().min(1).max(20).default(5),
  preferredGenres: z.array(z.string().min(1)).default([]),
  blockedGenres: z.array(z.string().min(1)).default([]),
  includeAlreadyKnown: z.boolean().default(false),
  deliveryChannel: z.enum(['telegram', 'whatsapp', 'none']).default('telegram'),
});

export type MediaRadarPreferences = z.infer<typeof mediaRadarPreferencesSchema>;

export const mediaRadarInputSchema = z.object({
  candidates: z.array(mediaRadarCandidateSchema).min(1),
  preferences: mediaRadarPreferencesSchema.default({
    requester: 'admin',
    theme: 'weekly watchlist radar',
    minMetascore: 70,
    minUserScore: 7,
    minCriticReviewCount: 8,
    shortlistSize: 5,
    preferredGenres: [],
    blockedGenres: [],
    includeAlreadyKnown: false,
    deliveryChannel: 'telegram',
  }),
});

export type MediaRadarInput = z.infer<typeof mediaRadarInputSchema>;

export const mediaRadarScoredCandidateSchema = mediaRadarCandidateSchema.extend({
  score: z.number(),
  recommendation: z.enum(['shortlist', 'watch', 'reject']),
  reasons: z.array(z.string()).default([]),
});

export type MediaRadarScoredCandidate = z.infer<typeof mediaRadarScoredCandidateSchema>;

export const mediaRadarPlanSchema = z.object({
  status: z.literal('draft-ready'),
  requester: z.string(),
  theme: z.string(),
  shortlist: z.array(mediaRadarScoredCandidateSchema),
  rejected: z.array(mediaRadarScoredCandidateSchema),
  draftMessage: z.string(),
  nextReadOnlyChecks: z.array(z.string()),
  approvalRequiredBefore: z.array(z.string()),
});

export type MediaRadarPlan = z.infer<typeof mediaRadarPlanSchema>;
