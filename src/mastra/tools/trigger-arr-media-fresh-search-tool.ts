import { createTool } from '@mastra/core/tools';
import {
  arrMediaFreshSearchInputSchema,
  arrMediaFreshSearchOutputSchema,
  type ArrMediaFreshSearchOutput,
} from '../schemas/media-service-status';
import {
  triggerRadarrMovieSearch,
  triggerSonarrSeriesSearch,
} from '../services/arr-readonly-client';
import { serverName, serverNameTitle } from '../config/branding';

export const triggerArrMediaFreshSearchTool = createTool({
  id: 'trigger-arr-media-fresh-search',
  description:
    `Repair action that triggers a fresh ${serverName()} search for an exact existing tracked TV show or movie after read-only diagnostics confirm content is missing. This may start downloads through existing media automation.`,
  inputSchema: arrMediaFreshSearchInputSchema,
  outputSchema: arrMediaFreshSearchOutputSchema,
  execute: async (input): Promise<ArrMediaFreshSearchOutput> => {
    const request = arrMediaFreshSearchInputSchema.parse(input);

    try {
      if (request.mediaType === 'tv') {
        const result = await triggerSonarrSeriesSearch(request);

        if (!result) {
          return {
            status: 'not-found',
            mediaType: request.mediaType,
            query: request.query,
            summary: `${request.query}${request.year ? ` (${request.year})` : ''} is not tracked in ${serverName()} repair, so I did not trigger a fresh search.`,
          };
        }

        if (!result.command) {
          if (result.reason === 'season-not-found') {
            return {
              status: 'not-found',
              mediaType: request.mediaType,
              query: request.query,
              title: result.series.title,
              year: result.series.year,
              seasonNumber: result.seasonNumber,
              sonarrSeriesId: result.series.id,
              summary: `${result.series.title}${result.series.year ? ` (${result.series.year})` : ''} does not have season ${result.seasonNumber} tracked in ${serverName()} repair, so I did not trigger a fresh search.`,
            };
          }

          return {
            status: 'nothing-to-search',
            mediaType: request.mediaType,
            query: request.query,
            title: result.series.title,
            year: result.series.year,
            seasonNumber: result.seasonNumber,
            monitoredEpisodeCount: result.monitoredEpisodeCount,
            missingMonitoredEpisodeCount: result.missingMonitoredEpisodeCount,
            airedEpisodeCount: 'airedEpisodeCount' in result ? result.airedEpisodeCount : undefined,
            upcomingEpisodeCount: 'upcomingEpisodeCount' in result ? result.upcomingEpisodeCount : undefined,
            nextAirDateUtc: 'nextAirDateUtc' in result ? result.nextAirDateUtc : undefined,
            sonarrSeriesId: result.series.id,
            summary: result.seasonNumber !== undefined
              ? `${result.series.title}${result.series.year ? ` (${result.series.year})` : ''} season ${result.seasonNumber} has no missing aired episodes to search.${'upcomingEpisodeCount' in result && result.upcomingEpisodeCount ? ` ${result.upcomingEpisodeCount} episodes have not aired yet; next air date: ${result.nextAirDateUtc}.` : ''}`
              : `${result.series.title}${result.series.year ? ` (${result.series.year})` : ''} does not have missing monitored episodes for ${serverName()} to search.`,
          };
        }

        return {
          status: 'started',
          mediaType: request.mediaType,
          query: request.query,
          title: result.series.title,
          year: result.series.year,
          seasonNumber: result.seasonNumber,
          monitoredEpisodeCount: result.monitoredEpisodeCount,
          missingMonitoredEpisodeCount: result.missingMonitoredEpisodeCount,
          sonarrSeriesId: result.series.id,
          commandName: result.command.name || 'EpisodeSearch',
          commandId: result.command.id,
          commandStatus: result.command.status,
          summary: result.seasonNumber !== undefined
            ? `Started a fresh ${serverName()} search for ${result.series.title}${result.series.year ? ` (${result.series.year})` : ''} season ${result.seasonNumber}. ${serverNameTitle()} will show it once it lands.`
            : `Started a fresh ${serverName()} search for ${result.series.title}${result.series.year ? ` (${result.series.year})` : ''}. ${serverNameTitle()} will show it once it lands.`,
        };
      }

      const result = await triggerRadarrMovieSearch(request);

      if (!result) {
        return {
          status: 'not-found',
          mediaType: request.mediaType,
          query: request.query,
          summary: `${request.query}${request.year ? ` (${request.year})` : ''} is not tracked in ${serverName()} repair, so I did not trigger a fresh search.`,
        };
      }

      return {
        status: 'started',
        mediaType: request.mediaType,
        query: request.query,
        title: result.movie.title,
        year: result.movie.year,
        radarrMovieId: result.movie.id,
        commandName: result.command.name || 'MoviesSearch',
        commandId: result.command.id,
        commandStatus: result.command.status,
        summary: `Started a fresh ${serverName()} search for ${result.movie.title}${result.movie.year ? ` (${result.movie.year})` : ''}. ${serverNameTitle()} will show it once it lands.`,
      };
    } catch (error) {
      return {
        status: 'service-unavailable',
        mediaType: request.mediaType,
        query: request.query,
        summary: `I could not trigger the fresh ${request.mediaType === 'tv' ? 'TV' : 'movie'} search: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});
