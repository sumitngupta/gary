import { z } from 'zod';

export const webLookupProviderSchema = z.enum(['exa', 'brightdata']);

export const webSearchResultSchema = z.object({
  title: z.string(),
  url: z.string().url(),
  snippet: z.string().optional(),
  highlights: z.array(z.string()).default([]),
  publishedDate: z.string().optional(),
  author: z.string().optional(),
  rank: z.number().int().positive().optional(),
  score: z.number().optional(),
  provider: webLookupProviderSchema,
});

export const webSearchOutputSchema = z.object({
  status: z.enum(['ok', 'missing-config', 'error']),
  query: z.string(),
  provider: webLookupProviderSchema.optional(),
  fallbackUsed: z.boolean(),
  mutation: z.literal(false),
  results: z.array(webSearchResultSchema),
  warnings: z.array(z.string()),
  summary: z.string(),
  costDollars: z.number().optional(),
});

export const webFetchedPageSchema = z.object({
  url: z.string().url(),
  title: z.string().optional(),
  content: z.string().optional(),
  highlights: z.array(z.string()).default([]),
  publishedDate: z.string().optional(),
  author: z.string().optional(),
  provider: webLookupProviderSchema,
});

export const webFetchOutputSchema = z.object({
  status: z.enum(['ok', 'missing-config', 'error']),
  url: z.string().url(),
  provider: webLookupProviderSchema.optional(),
  fallbackUsed: z.boolean(),
  mutation: z.literal(false),
  page: webFetchedPageSchema.optional(),
  warnings: z.array(z.string()),
  summary: z.string(),
  costDollars: z.number().optional(),
});

export type WebSearchOutput = z.infer<typeof webSearchOutputSchema>;
export type WebFetchOutput = z.infer<typeof webFetchOutputSchema>;
export type WebSearchResult = z.infer<typeof webSearchResultSchema>;
export type WebFetchedPage = z.infer<typeof webFetchedPageSchema>;
