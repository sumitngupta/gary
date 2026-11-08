import { createTool } from '@mastra/core/tools';
import {
  radarrMovieStatusInputSchema,
  radarrMovieStatusOutputSchema,
  type RadarrMovieStatusOutput,
} from '../schemas/media-service-status';
import { getRadarrMovieStatus } from '../services/arr-readonly-client';
import { serverName } from '../config/branding';

type QueueItem = Awaited<ReturnType<typeof getRadarrMovieStatus>> extends infer T
  ? T extends { queueItems: Array<infer Q> } ? Q : never
  : never;

function downloadProgress(item: QueueItem) {
  if (typeof item.progress === 'number') {
    return item.progress;
  }

  if (typeof item.size === 'number' && item.size > 0 && typeof item.sizeleft === 'number') {
    return Math.max(0, Math.min(100, ((item.size - item.sizeleft) / item.size) * 100));
  }

  return undefined;
}

function casualDownloadSummary(queueItems: QueueItem[]) {
  if (queueItems.length === 0) {
    return '';
  }

  const first = queueItems[0];
  const progress = downloadProgress(first);
  const progressText = progress !== undefined ? `, about ${Math.round(progress)}% complete` : '';
  const timeText = first.timeleft ? ` with about ${first.timeleft} left` : '';
  const issueText = first.errorMessage ? ` It currently says: ${first.errorMessage}.` : '';
  const countText = queueItems.length === 1
    ? `There is 1 active ${serverName()} download`
    : `There are ${queueItems.length} active ${serverName()} downloads`;

  return ` ${countText}${progressText}${timeText}.${issueText}`;
}

export const checkRadarrMovieStatusTool = createTool({
  id: 'check-radarr-movie-status',
  description:
    'Read-only movie download/import lookup for movie monitoring, downloaded/imported file state, quality, and queue/import status. Does not search, download, monitor, unmonitor, or modify files.',
  inputSchema: radarrMovieStatusInputSchema,
  outputSchema: radarrMovieStatusOutputSchema,
  execute: async (input): Promise<RadarrMovieStatusOutput> => {
    const request = radarrMovieStatusInputSchema.parse(input);

    try {
      const result = await getRadarrMovieStatus(request);

      if (!result) {
        return {
          status: 'not-found',
          query: request.query,
          queueCount: 0,
          queueItems: [],
          casualSummary: `${request.query}${request.year ? ` (${request.year})` : ''} is not in the movie download/import system.`,
          summary: `${request.query}${request.year ? ` (${request.year})` : ''} was not found in the movie download/import system.`,
        };
      }

      const { movie, queueItems } = result;
      const quality = movie.movieFile?.quality?.quality?.name;
      const fileSummary = movie.hasFile || movie.downloaded
        ? `A movie file is present${quality ? ` at ${quality}` : ''}.`
        : 'No imported movie file is present.';
      const queueSummary = queueItems.length > 0
        ? `${queueItems.length} queue item(s) currently match this movie.`
        : 'No active queue items currently match this movie.';
      const casualFileText = movie.hasFile || movie.downloaded
        ? `${movie.title}${movie.year ? ` (${movie.year})` : ''} has a movie file in ${serverName()}.`
        : `${movie.title}${movie.year ? ` (${movie.year})` : ''} does not have a movie file in ${serverName()} yet.`;
      const casualQueueText = casualDownloadSummary(queueItems);

      return {
        status: 'found',
        query: request.query,
        title: movie.title,
        year: movie.year,
        movieId: movie.id,
        tmdbId: movie.tmdbId,
        monitored: Boolean(movie.monitored),
        hasFile: Boolean(movie.hasFile),
        downloaded: Boolean(movie.downloaded),
        quality,
        size: movie.movieFile?.size,
        queueCount: queueItems.length,
        queueItems: queueItems.slice(0, 10).map((item) => ({
          title: item.title,
          status: item.status,
          trackedDownloadStatus: item.trackedDownloadStatus,
          trackedDownloadState: item.trackedDownloadState,
          progress: downloadProgress(item),
          size: item.size,
          sizeLeft: item.sizeleft,
          timeLeft: item.timeleft,
          estimatedCompletionTime: item.estimatedCompletionTime,
          errorMessage: item.errorMessage,
        })),
        casualSummary: `${casualFileText}${casualQueueText}`,
        summary: `${movie.title}${movie.year ? ` (${movie.year})` : ''} is ${movie.monitored ? 'monitored' : 'not monitored'} in the movie download/import system. ${fileSummary} ${queueSummary}`,
      };
    } catch (error) {
      return {
        status: 'service-unavailable',
        query: request.query,
        queueCount: 0,
        queueItems: [],
        casualSummary: `I could not check movie download/import status for "${request.query}" right now.`,
        summary: `I could not reach the movie download/import system for a read-only movie lookup: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});
