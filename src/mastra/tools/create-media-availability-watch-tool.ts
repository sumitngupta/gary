import { createTool } from '@mastra/core/tools';
import {
  mediaAvailabilityWatchInputSchema,
  mediaAvailabilityWatchOutputSchema,
  type MediaAvailabilityWatchOutput,
} from '../schemas/media-availability-watch';
import { createMediaAvailabilityWatch } from '../services/media-availability-watch-store';
import { checkPlexTitleAvailability } from '../services/plex-readonly-client';
import { appendOperationEvent } from '../services/gary-operations-store';
import { getSonarrSeriesStatus } from '../services/arr-readonly-client';
import {
  completeSeasonNumbers,
  formatSeasonList,
  pendingSeasonNumbers,
  tvCompleteness,
} from '../services/sonarr-season-summary';
import type { TvCompleteness } from '../schemas/media-availability-watch';
import { serverName } from '../config/branding';
import { toolCaller } from '../channels/gary-channels';

function titleWithYear(title: string, year?: number) {
  return `${title}${year ? ` (${year})` : ''}`;
}

function partialSummary(name: string, completeness: TvCompleteness) {
  const present = completeSeasonNumbers(completeness);
  const pending = pendingSeasonNumbers(completeness);
  const presentList = formatSeasonList(present);
  const lead = present.length
    ? `${presentList[0].toUpperCase()}${presentList.slice(1)} of ${name} ${present.length === 1 ? 'is' : 'are'}`
    : `Some episodes of ${name} are`;
  return `${lead} on ${serverName()} now. I'll message you here when ${formatSeasonList(pending)} ${pending.length === 1 ? 'finishes' : 'finish'}.`;
}

async function requestedTvCompleteness(request: { title: string; year?: number; tmdbId?: number; seasonNumber?: number }) {
  try {
    const sonarr = await getSonarrSeriesStatus({ query: request.title, year: request.year, tmdbId: request.tmdbId });
    return sonarr && tvCompleteness({
      plexStreamable: true,
      seasonNumber: request.seasonNumber,
      seriesSeasons: sonarr.series.seasons,
      episodes: sonarr.episodes,
    });
  } catch {
    return 'unconfirmed' as const;
  }
}

export const createMediaAvailabilityWatchTool = createTool({
  id: 'create-media-availability-watch',
  description:
    `Create an availability notification watch for an exact movie/show so Gary can message the current thread when it becomes available. This does not request, search, download, or modify media services.`,
  inputSchema: mediaAvailabilityWatchInputSchema,
  outputSchema: mediaAvailabilityWatchOutputSchema,
  execute: async (input, context): Promise<MediaAvailabilityWatchOutput> => {
    const request = mediaAvailabilityWatchInputSchema.parse(input);
    const resourceId = context.agent?.resourceId || request.resourceId;
    const threadId = context.agent?.threadId || request.threadId;
    const caller = await toolCaller(context);
    const channel = caller?.kind === 'person' ? caller.channel : 'none';
    const channelContext = context.requestContext?.get('channel') as { messageId?: string } | undefined;
    const correlationId = channelContext?.messageId || request.correlationId;

    if (!resourceId || !threadId || channel === 'none') {
      return {
        status: 'service-unavailable',
        title: request.title,
        mediaType: request.mediaType,
        year: request.year,
        seasonNumber: request.seasonNumber,
        channel,
        summary: `I could not enable notifications for ${titleWithYear(request.title, request.year)} because this chat has no supported notification destination.`,
      };
    }

    try {
      const availability = await checkPlexTitleAvailability({
        query: request.title,
        mediaType: request.mediaType,
        year: request.year,
        seasonNumber: request.seasonNumber,
      });

      const completeness = availability.streamable && request.mediaType === 'tv'
        ? await requestedTvCompleteness(request)
        : undefined;

      if (availability.streamable && (!completeness || (completeness !== 'unconfirmed' && completeness.state === 'complete'))) {
        const primary = availability.matches[0];
        const seasonText = request.seasonNumber !== undefined ? ` season ${request.seasonNumber}` : '';
        return {
          status: 'already-available',
          title: primary?.title || request.title,
          mediaType: request.mediaType,
          year: primary?.year || request.year,
          seasonNumber: request.seasonNumber,
          resourceId,
          threadId,
          channel,
          summary: `${titleWithYear(primary?.title || request.title, primary?.year || request.year)}${seasonText} is already available in ${serverName()}.`,
        };
      }

      const result = await createMediaAvailabilityWatch({
        ...request,
        channel,
        resourceId,
        threadId,
        correlationId,
      });
      const watch = result.watch;
      await appendOperationEvent({ correlationId: watch.correlationId || watch.id, resourceId, threadId, phase: result.created ? 'watch-created' : 'watch-already-active', detail: { watchId: watch.id, title: watch.title, mediaType: watch.mediaType } });
      const seasonText = watch.seasonNumber !== undefined ? ` season ${watch.seasonNumber}` : '';

      if (completeness && completeness !== 'unconfirmed' && completeness.state === 'partial') {
        return {
          status: 'partially-available',
          watchId: watch.id,
          title: watch.title,
          mediaType: watch.mediaType,
          year: watch.year,
          seasonNumber: watch.seasonNumber,
          resourceId,
          threadId,
          channel: watch.channel,
          summary: partialSummary(titleWithYear(watch.title, watch.year), completeness),
        };
      }

      return {
        status: result.created ? 'created' : 'already-active',
        watchId: watch.id,
        title: watch.title,
        mediaType: watch.mediaType,
        year: watch.year,
        seasonNumber: watch.seasonNumber,
        resourceId,
        threadId,
        channel: watch.channel,
        summary: result.created
          ? `I will message you here when ${titleWithYear(watch.title, watch.year)}${seasonText} is available in ${serverName()}.`
          : `I am already watching for ${titleWithYear(watch.title, watch.year)}${seasonText} and will message you here when it is available in ${serverName()}.`,
      };
    } catch (error) {
      return {
        status: 'service-unavailable',
        title: request.title,
        mediaType: request.mediaType,
        year: request.year,
        seasonNumber: request.seasonNumber,
        resourceId,
        threadId,
        channel,
        summary: `I could not create an availability watch for ${titleWithYear(request.title, request.year)}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});
