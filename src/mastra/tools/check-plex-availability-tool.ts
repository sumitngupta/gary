import { createTool } from '@mastra/core/tools';
import {
  plexAvailabilityInputSchema,
  plexAvailabilityOutputSchema,
  type PlexAvailabilityOutput,
} from '../schemas/media-service-status';
import { searchPlexAvailability } from '../services/plex-readonly-client';
import { serverName } from '../config/branding';

function titleWithYear(title: string, year?: number) {
  return `${title}${year ? ` (${year})` : ''}`;
}

export async function checkPlexAvailability(input: unknown): Promise<PlexAvailabilityOutput> {
    const request = plexAvailabilityInputSchema.parse(input);

    try {
      const matches = await searchPlexAvailability(request);

      if (matches.length === 0) {
        return {
          status: 'not-found',
          query: request.query,
          streamable: false,
          matches: [],
          casualSummary: `${request.query}${request.year ? ` (${request.year})` : ''} is not in ${serverName()} yet.`,
          summary: `${request.query}${request.year ? ` (${request.year})` : ''} was not found in ${serverName()} library, so it does not appear streamable from ${serverName()} right now.`,
        };
      }

      const primaryMatch = matches[0];
      const episodeText = primaryMatch.episodeCount !== undefined
        ? ` Looks like ${primaryMatch.episodeCount} episodes are there.`
        : '';
      const seasonText = primaryMatch.availableSeasons?.length
        ? ` Plex currently shows season${primaryMatch.availableSeasons.length === 1 ? '' : 's'} ${primaryMatch.availableSeasons.join(', ')}.`
        : '';
      const details = matches
        .slice(0, 3)
        .map((match) => {
          const count = match.episodeCount !== undefined ? `, ${match.episodeCount} episodes` : '';
          const seasons = match.availableSeasons?.length ? `, seasons ${match.availableSeasons.join(', ')}` : '';
          return `${match.title}${match.year ? ` (${match.year})` : ''} in ${match.library || `${serverName()} library`}${count}${seasons}`;
        })
        .join('; ');

      return {
        status: 'found',
        query: request.query,
        streamable: true,
        matches,
        casualSummary: `${titleWithYear(primaryMatch.title, primaryMatch.year)} is available in ${serverName()}.${episodeText}${seasonText}`,
        summary: `${request.query}${request.year ? ` (${request.year})` : ''} appears streamable from ${serverName()}: ${details}.`,
      };
    } catch (error) {
      return {
        status: 'service-unavailable',
        query: request.query,
        streamable: false,
        matches: [],
        casualSummary: `I could not check ${serverName()} for "${request.query}" right now.`,
        summary: `I could not reach ${serverName()} library for a read-only availability lookup: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
}

export const checkPlexAvailabilityTool = createTool({
  id: 'check-plex-availability',
  description:
    `Read-only ${serverName()} library lookup for whether a movie/show is currently streamable from ${serverName()}. Does not modify the library, requests, downloads, or files.`,
  inputSchema: plexAvailabilityInputSchema,
  outputSchema: plexAvailabilityOutputSchema,
  execute: checkPlexAvailability,
});
