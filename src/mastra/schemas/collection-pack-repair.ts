import { z } from 'zod';

export const collectionPackItemSchema = z.object({
  title: z.string().min(1),
  year: z.number().int().optional(),
  tmdbId: z.number().int().positive(),
  size: z.number().int().nonnegative(),
  quality: z.string().optional(),
});

export const collectionPackReviewInputSchema = z.object({
  planId: z.string().uuid().optional(),
});

export const collectionPackReviewOutputSchema = z.object({
  status: z.enum(['ready', 'not-found', 'expired', 'denied', 'service-unavailable']),
  planId: z.string().uuid().optional(),
  expiresAt: z.string().optional(),
  targetTitle: z.string().optional(),
  items: z.array(collectionPackItemSchema).default([]),
  summary: z.string(),
  mutation: z.literal(false),
});

export const collectionPackExecuteInputSchema = z.object({ planId: z.string().uuid() });
export const collectionPackExecuteOutputSchema = z.object({
  status: z.enum(['started', 'expired', 'denied', 'failed']),
  imported: z.array(collectionPackItemSchema).default([]),
  failed: z.array(collectionPackItemSchema.extend({ error: z.string() })).default([]),
  summary: z.string(),
  mutation: z.literal(true),
});

export type CollectionPackItem = z.infer<typeof collectionPackItemSchema>;
