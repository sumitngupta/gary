import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  webFetchOutputSchema,
  webSearchOutputSchema,
} from '../schemas/web-lookup';
import { fetchWebPage, searchWeb } from '../services/web-lookup-client';

const domainSchema = z.string().min(1).max(253).regex(/^[a-z0-9.-]+$/i);

export const webSearchTool = createTool({
  id: 'web-search',
  description:
    'Read-only live web search for open-ended current facts and source discovery. Uses Exa first and Bright Data as fallback; returns structured results with URLs and snippets/highlights.',
  inputSchema: z.object({
    query: z.string().min(2).max(500),
    maxResults: z.number().int().min(1).max(10).default(5),
    searchType: z.enum(['auto', 'fast', 'instant', 'deep-lite', 'deep', 'deep-reasoning']).default('auto'),
    includeDomains: z.array(domainSchema).max(20).optional(),
    excludeDomains: z.array(domainSchema).max(20).optional(),
    useBrightDataFallback: z.boolean().default(true),
  }),
  outputSchema: webSearchOutputSchema,
  mcp: {
    annotations: {
      title: 'Web Search',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  execute: async (input) => searchWeb(input),
});

export const webFetchTool = createTool({
  id: 'web-fetch',
  description:
    'Read-only live page fetch for known public URLs, including schedules. Prefer contentMode text when extracting page details. Independent of local Chromium/Playwright: use this when browser_* cannot launch, has a missing executable, or times out, before asking the user to paste content. Uses Exa contents first and Bright Data Web Unlocker as fallback; returns highlights or capped text for source-grounded answers. Does not replace screenshots or authenticated browser interactions.',
  inputSchema: z.object({
    url: z.string().url(),
    query: z.string().min(1).max(500).optional(),
    contentMode: z.enum(['highlights', 'text']).default('highlights'),
    maxCharacters: z.number().int().min(500).max(20000).default(12000),
    useBrightDataFallback: z.boolean().default(true),
  }),
  outputSchema: webFetchOutputSchema,
  mcp: {
    annotations: {
      title: 'Web Fetch',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  execute: async (input) => fetchWebPage(input),
});
