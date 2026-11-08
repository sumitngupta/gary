import { z } from 'zod';

export const plexCollectionCandidateSchema = z.object({
  title: z.string().trim().min(1), year: z.number().int().optional(), mediaType: z.enum(['movie', 'tv']),
});
export const inspectPlexCollectionsInputSchema = z.object({ mediaType: z.enum(['movie', 'tv']).optional(), title: z.string().trim().min(1).optional() });
export const plexCollectionItemSchema = z.object({ ratingKey: z.string(), title: z.string(), year: z.number().int().optional(), type: z.string() });
export const plexCollectionViewSchema = z.object({
  ratingKey: z.string(), title: z.string(), summary: z.string().optional(), mediaType: z.enum(['movie', 'tv']), sectionKey: z.string(), library: z.string(),
  owner: z.enum(['caller', 'other', 'legacy']).default('legacy'), items: z.array(plexCollectionItemSchema),
});
export const inspectPlexCollectionsOutputSchema = z.object({ status: z.enum(['ok', 'not-found', 'service-unavailable']), collections: z.array(plexCollectionViewSchema), summary: z.string() });

export const previewPlexCollectionChangeInputSchema = z.object({
  action: z.enum(['create', 'update', 'delete']), mediaType: z.enum(['movie', 'tv']), collectionTitle: z.string().trim().min(1),
  newTitle: z.string().trim().min(1).optional(), description: z.string().trim().max(1000).optional(),
  add: z.array(plexCollectionCandidateSchema).max(50).default([]), remove: z.array(plexCollectionCandidateSchema).max(50).default([]),
});
const resolutionSchema = plexCollectionCandidateSchema.extend({ ratingKey: z.string().optional(), resolvedTitle: z.string().optional(), resolvedYear: z.number().int().optional(), reason: z.string().optional() });
export const previewPlexCollectionChangeOutputSchema = z.object({
  status: z.enum(['ready', 'not-found', 'ambiguous', 'denied', 'service-unavailable']), previewId: z.string().uuid().optional(), expiresAt: z.string().datetime().optional(),
  action: z.enum(['create', 'update', 'delete']), collectionTitle: z.string(), resultingTitle: z.string().optional(), available: z.array(resolutionSchema), missing: z.array(resolutionSchema), ambiguous: z.array(resolutionSchema), removed: z.array(resolutionSchema), summary: z.string(),
  alreadyRequested: z.array(resolutionSchema).default([]),
});
export const executePlexCollectionChangeInputSchema = z.object({ previewId: z.string().uuid() });
export const executePlexCollectionChangeOutputSchema = z.object({ status: z.enum(['created', 'updated', 'deleted', 'expired', 'denied', 'failed']), collection: plexCollectionViewSchema.optional(), summary: z.string(), rollback: z.string().optional() });

export type PlexCollectionPreviewInput = z.infer<typeof previewPlexCollectionChangeInputSchema>;
export type PlexCollectionResolution = z.infer<typeof resolutionSchema>;
