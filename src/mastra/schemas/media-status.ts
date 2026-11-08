import { z } from 'zod';
import { mediaTypeSchema } from './media-request';

export const mediaStatusLookupInputSchema = z.object({
  query: z.string().min(1),
  mediaType: mediaTypeSchema.default('unknown'),
  year: z.number().int().min(1888).max(2100).optional(),
  requester: z.string().min(1).default('admin'),
});

export type MediaStatusLookupInput = z.infer<typeof mediaStatusLookupInputSchema>;

export const mediaStatusMatchSchema = z.object({
  title: z.string(),
  mediaType: z.enum(['movie', 'tv']),
  year: z.number().int().optional(),
  releaseDate: z.string().optional(),
  tmdbId: z.number().int().positive(),
  overview: z.string().optional(),
});

export const mediaServiceStatusSchema = z.object({
  code: z.number().int().optional(),
  label: z.string(),
  available: z.boolean(),
});

export const mediaRequestStatusEntrySchema = z.object({
  requestId: z.number().int().positive(),
  statusCode: z.number().int().optional(),
  statusLabel: z.string(),
  requestedBy: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export const mediaStatusLookupOutputSchema = z.object({
  status: z.enum(['found', 'needs-clarification', 'not-found', 'service-unavailable']),
  query: z.string(),
  requester: z.string(),
  selected: mediaStatusMatchSchema.optional(),
  matches: z.array(mediaStatusMatchSchema).default([]),
  mediaStatus: mediaServiceStatusSchema.optional(),
  requests: z.array(mediaRequestStatusEntrySchema).default([]),
  casualSummary: z.string(),
  summary: z.string(),
  nextReadOnlyChecks: z.array(z.string()).default([]),
  approvalRequiredBefore: z.array(z.string()).default([]),
});

export type MediaStatusLookupOutput = z.infer<typeof mediaStatusLookupOutputSchema>;
