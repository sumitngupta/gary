import { z } from 'zod';

const optionalYear = z.preprocess(
  (value) => value === null ? undefined : value,
  z.number().int().min(1888).max(2100).optional(),
);

const optionalPositiveInt = z.preprocess(
  (value) => value === null ? undefined : value,
  z.number().int().positive().optional(),
);

export const tvCompletenessSchema = z.object({
  state: z.enum(['none', 'partial', 'complete']),
  seasons: z.array(z.object({
    seasonNumber: z.number().int(),
    aired: z.number().int(),
    withFiles: z.number().int(),
    upcoming: z.number().int(),
  })),
  missingAired: z.number().int(),
});

export type TvCompleteness = z.infer<typeof tvCompletenessSchema>;

export const mediaAvailabilityWatchSnapshotSchema = z.object({
  availableInLibrary: z.boolean(),
  libraryEpisodeCount: z.number().int().optional(),
  librarySeasonEpisodeCount: z.number().int().optional(),
  seasonSatisfied: z.boolean().optional(),
  checkedAt: z.string(),
  status: z.enum(['unknown', 'requested', 'approved', 'downloading', 'imported', 'available', 'not-available', 'stalled', 'failed', 'service-unavailable']),
  progress: z.number().optional(),
  timeLeft: z.string().optional(),
  detail: z.string().optional(),
  tvCompleteness: tvCompletenessSchema.optional(),
});

export type MediaAvailabilityWatchSnapshot = z.infer<typeof mediaAvailabilityWatchSnapshotSchema>;

export const mediaAvailabilityWatchSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  mediaType: z.enum(['movie', 'tv', 'unknown']).default('unknown'),
  year: optionalYear,
  seasonNumber: z.number().int().min(0).max(100).optional(),
  tmdbId: optionalPositiveInt,
  requester: z.string().min(1).default('admin'),
  resourceId: z.string().min(1),
  threadId: z.string().min(1),
  channel: z.enum(['telegram', 'whatsapp', 'none']).default('telegram'),
  status: z.enum(['active', 'available', 'delivery-pending', 'notified', 'cancelled', 'expired']).default('active'),
  dirty: z.boolean().default(true),
  createdAt: z.string(),
  updatedAt: z.string(),
  nextCheckAt: z.string().optional(),
  lastCheckedAt: z.string().optional(),
  notifiedAt: z.string().optional(),
  lastNotificationError: z.string().optional(),
  lastNotificationAttemptAt: z.string().optional(),
  lastNotificationSentAt: z.string().optional(),
  lastTelegramMessageId: z.number().int().optional(),
  lastWhatsAppMessageId: z.string().optional(),
  lastIssueNotificationAt: z.string().optional(),
  lastIssueFingerprint: z.string().optional(),
  lastSnapshot: mediaAvailabilityWatchSnapshotSchema.optional(),
  dedupeKey: z.string().min(1),
  correlationId: z.string().optional(),
});

export type MediaAvailabilityWatch = z.infer<typeof mediaAvailabilityWatchSchema>;

export const mediaAvailabilityWatchInputSchema = z.object({
  title: z.string().min(1),
  mediaType: z.enum(['movie', 'tv', 'unknown']).default('unknown'),
  year: optionalYear,
  seasonNumber: z.number().int().min(0).max(100).optional(),
  tmdbId: optionalPositiveInt,
  requester: z.string().min(1).default('admin'),
  resourceId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  correlationId: z.string().optional(),
  channel: z.enum(['telegram', 'whatsapp', 'none']).default('telegram'),
});

export const mediaAvailabilityWatchOutputSchema = z.object({
  status: z.enum(['created', 'already-active', 'already-available', 'partially-available', 'service-unavailable']),
  watchId: z.string().optional(),
  title: z.string(),
  mediaType: z.enum(['movie', 'tv', 'unknown']),
  year: z.number().int().optional(),
  seasonNumber: z.number().int().optional(),
  resourceId: z.string().optional(),
  threadId: z.string().optional(),
  channel: z.enum(['telegram', 'whatsapp', 'none']),
  summary: z.string(),
});

export type MediaAvailabilityWatchInput = z.infer<typeof mediaAvailabilityWatchInputSchema>;
export type MediaAvailabilityWatchOutput = z.infer<typeof mediaAvailabilityWatchOutputSchema>;

export const mediaAvailabilityWatchSweepOutputSchema = z.object({
  checked: z.number().int(),
  notified: z.number().int(),
  failed: z.number().int(),
  skipped: z.number().int(),
});

export type MediaAvailabilityWatchSweepOutput = z.infer<typeof mediaAvailabilityWatchSweepOutputSchema>;

export const mediaAvailabilityWatchManagementInputSchema = z.object({
  action: z.enum(['list', 'cancel']),
  title: z.string().optional(),
  watchId: z.string().optional(),
  resourceId: z.string().optional(),
  threadId: z.string().optional(),
});

export const mediaAvailabilityWatchManagementOutputSchema = z.object({
  status: z.enum(['listed', 'cancelled', 'not-found', 'service-unavailable']),
  watches: z.array(mediaAvailabilityWatchSchema).default([]),
  summary: z.string(),
});

export type MediaAvailabilityWatchManagementInput = z.infer<typeof mediaAvailabilityWatchManagementInputSchema>;
export type MediaAvailabilityWatchManagementOutput = z.infer<typeof mediaAvailabilityWatchManagementOutputSchema>;
