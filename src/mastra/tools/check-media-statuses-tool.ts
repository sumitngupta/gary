import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { checkMediaStatus } from './check-media-status-tool';
import { checkPlexAvailability } from './check-plex-availability-tool';
import { serverName } from '../config/branding';

const titleSchema = z.object({
  title: z.string().min(1),
  mediaType: z.enum(['movie', 'tv', 'unknown']).default('unknown'),
  year: z.number().int().min(1888).max(2100).optional(),
});

const resultSchema = z.object({
  title: z.string(),
  year: z.number().int().optional(),
  mediaType: z.enum(['movie', 'tv', 'unknown']),
  status: z.enum([
    'available',
    'requested',
    'partially-available',
    'missing',
    'needs-clarification',
    'not-found',
    'service-unavailable',
  ]),
  resolvedTitle: z.string().optional(),
  resolvedYear: z.number().int().optional(),
  resolvedTmdbId: z.number().int().positive().optional(),
  summary: z.string(),
});

const inputSchema = z.object({
  titles: z.array(titleSchema).min(1).max(20),
  requester: z.string().min(1).default('admin'),
});

const outputSchema = z.object({
  status: z.enum(['completed', 'partially-completed', 'failed']),
  results: z.array(resultSchema),
  totals: z.object({
    available: z.number().int(),
    requested: z.number().int(),
    partiallyAvailable: z.number().int(),
    missing: z.number().int(),
    unresolved: z.number().int(),
  }),
  summary: z.string(),
});

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  callback: (value: T) => Promise<R>,
) {
  const results = new Array<R>(values.length);
  let next = 0;

  async function worker() {
    while (next < values.length) {
      const index = next++;
      results[index] = await callback(values[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

export const checkMediaStatusesTool = createTool({
  id: 'check-media-statuses',
  description:
    `Read-only, evidence-backed ${serverName()} request and library status checks for up to 20 exact movie/show titles in one deterministic call. Use this instead of many individual status tools for a shortlist.`,
  inputSchema,
  outputSchema,
  execute: async (input) => checkMediaStatuses(input),
});

export async function checkMediaStatuses(input: z.input<typeof inputSchema>) {
    const parsed = inputSchema.parse(input);
    const results = await mapWithConcurrency(parsed.titles, 3, async (item) => {
      const [media, plex] = await Promise.all([
        checkMediaStatus({
          query: item.title,
          mediaType: item.mediaType,
          year: item.year,
          requester: parsed.requester,
        }),
        checkPlexAvailability({
          query: item.title,
          mediaType: item.mediaType,
          year: item.year,
        }),
      ]);
      const resolvedTitle = media.selected?.title || plex.matches[0]?.title;
      const resolvedYear = media.selected?.year || plex.matches[0]?.year;
      const resolvedTmdbId = media.selected?.tmdbId;
      const base = { title: item.title, year: item.year, mediaType: item.mediaType, resolvedTitle, resolvedYear, resolvedTmdbId };

      if (plex.status === 'service-unavailable' || media.status === 'service-unavailable') {
        return { ...base, status: 'service-unavailable' as const, summary: `Could not complete the current ${serverName()} checks for ${item.title}.` };
      }
      if (media.mediaStatus?.label === 'partially available') {
        const count = plex.matches[0]?.episodeCount;
        return { ...base, status: 'partially-available' as const, summary: `${resolvedTitle || item.title}${resolvedYear ? ` (${resolvedYear})` : ''} is partially available in ${serverName()}.${count !== undefined ? ` Plex currently has ${count} episodes.` : ''}` };
      }
      if (plex.streamable || media.mediaStatus?.available) {
        return { ...base, status: 'available' as const, summary: `${resolvedTitle || item.title}${resolvedYear ? ` (${resolvedYear})` : ''} is available in ${serverName()}.` };
      }
      if (media.status === 'needs-clarification') {
        return { ...base, status: 'needs-clarification' as const, summary: media.casualSummary };
      }
      if (media.status === 'not-found') {
        return { ...base, status: 'not-found' as const, summary: media.casualSummary };
      }
      const requested = media.requests.some((request) =>
        ['approved', 'processing', 'completed', 'pending approval'].includes(request.statusLabel),
      );
      if (requested) {
        return { ...base, status: 'requested' as const, summary: media.casualSummary };
      }
      return {
        ...base,
        status: 'missing' as const,
        summary: `${resolvedTitle || item.title}${resolvedYear ? ` (${resolvedYear})` : ''} is not available in ${serverName()} and has no active request.`,
      };
    });

    const totals = {
      available: results.filter((item) => item.status === 'available').length,
      requested: results.filter((item) => item.status === 'requested').length,
      partiallyAvailable: results.filter((item) => item.status === 'partially-available').length,
      missing: results.filter((item) => item.status === 'missing').length,
      unresolved: results.filter((item) =>
        ['needs-clarification', 'not-found', 'service-unavailable'].includes(item.status)
      ).length,
    };
    const failures = results.filter((item) => item.status === 'service-unavailable').length;
    const status = failures === results.length
      ? 'failed' as const
      : failures > 0
        ? 'partially-completed' as const
        : 'completed' as const;

    return {
      status,
      results,
      totals,
      summary: `Checked ${results.length} ${serverName()} titles: ${totals.available} available, ${totals.requested} requested, ${totals.partiallyAvailable} partial, ${totals.missing} missing, ${totals.unresolved} unresolved.`,
    };
}
