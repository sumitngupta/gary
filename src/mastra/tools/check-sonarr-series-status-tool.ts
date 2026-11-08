import { createTool } from '@mastra/core/tools';
import {
  sonarrSeriesStatusInputSchema,
  sonarrSeriesStatusOutputSchema,
  type SonarrSeriesStatusOutput,
} from '../schemas/media-service-status';
import { getSonarrSeriesStatus } from '../services/arr-readonly-client';
import { summarizeSonarrSeasons } from '../services/sonarr-season-summary';
import { serverName } from '../config/branding';

type QueueItem = Awaited<ReturnType<typeof getSonarrSeriesStatus>> extends infer T
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

function dedupeDownloads(queueItems: QueueItem[]) {
  const seen = new Set<string>();

  return queueItems.filter((item) => {
    const key = item.title || `${item.status || ''}:${item.episode?.seasonNumber || ''}:${item.episode?.episodeNumber || ''}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function casualDownloadSummary(queueItems: QueueItem[]) {
  const downloads = dedupeDownloads(queueItems);

  if (downloads.length === 0) {
    return '';
  }

  const first = downloads[0];
  const progress = downloadProgress(first);
  const progressText = progress !== undefined ? `, about ${Math.round(progress)}% complete` : '';
  const timeText = first.timeleft ? ` with about ${first.timeleft} left` : '';
  const issueText = first.errorMessage ? ` It currently says: ${first.errorMessage}.` : '';
  const countText = downloads.length === 1
    ? `There is 1 active ${serverName()} download`
    : `There are ${downloads.length} active ${serverName()} downloads`;

  return ` ${countText}${progressText}${timeText}.${issueText}`;
}

function seasonScopeSummary(seasons: ReturnType<typeof summarizeSonarrSeasons>) {
  const complete = seasons.filter((season) => season.episodeFileCount === season.episodeCount).map((season) => season.seasonNumber);
  const absent = seasons.filter((season) => season.episodeFileCount === 0).map((season) => season.seasonNumber);
  const unmonitoredAbsent = seasons
    .filter((season) => season.episodeFileCount === 0 && season.monitoredEpisodeCount === 0)
    .map((season) => season.seasonNumber);
  const parts = [
    complete.length ? `complete seasons: ${complete.join(', ')}` : undefined,
    absent.length ? `seasons with no files: ${absent.join(', ')}` : undefined,
    unmonitoredAbsent.length ? `unmonitored seasons with no files: ${unmonitoredAbsent.join(', ')}` : undefined,
    ...seasons.filter((season) => season.upcomingEpisodeCount > 0).map((season) =>
      `season ${season.seasonNumber}: ${season.airedEpisodeCount - season.missingAiredEpisodeCount}/${season.airedEpisodeCount} aired episodes have files; ${season.upcomingEpisodeCount} episodes have not aired yet (next: ${season.nextAirDateUtc})`),
  ].filter(Boolean);
  return parts.join('; ');
}

export const checkSonarrSeriesStatusTool = createTool({
  id: 'check-sonarr-series-status',
  description:
    'Read-only TV download/import lookup for series monitoring, episode file counts, and queue/import state. Does not search, download, monitor, unmonitor, or modify files.',
  inputSchema: sonarrSeriesStatusInputSchema,
  outputSchema: sonarrSeriesStatusOutputSchema,
  execute: async (input): Promise<SonarrSeriesStatusOutput> => {
    const request = sonarrSeriesStatusInputSchema.parse(input);

    try {
      const result = await getSonarrSeriesStatus(request);

      if (!result) {
        return {
          status: 'not-found',
          query: request.query,
          seasons: [],
          queueCount: 0,
          queueItems: [],
          casualSummary: `${request.query}${request.year ? ` (${request.year})` : ''} is not in the TV download/import system.`,
          summary: `${request.query}${request.year ? ` (${request.year})` : ''} was not found in the TV download/import system.`,
        };
      }

      const { series, episodes, queueItems } = result;
      const stats = series.statistics || {};
      const seasons = summarizeSonarrSeasons(episodes);
      const seasonSummary = seasonScopeSummary(seasons);
      const queueSummary = queueItems.length > 0
        ? `${queueItems.length} queue item(s) currently match this series.`
        : 'No active queue items currently match this series.';
      const fileSummary = `${stats.episodeFileCount || 0}/${stats.episodeCount || 0} aired episodes have files`;
      const casualQueueText = casualDownloadSummary(queueItems);

      return {
        status: 'found',
        query: request.query,
        title: series.title,
        year: series.year,
        monitored: Boolean(series.monitored),
        seriesId: series.id,
        tvdbId: series.tvdbId,
        tmdbId: series.tmdbId,
        episodeFileCount: stats.episodeFileCount || 0,
        episodeCount: stats.episodeCount || 0,
        totalEpisodeCount: stats.totalEpisodeCount || 0,
        percentOfEpisodes: stats.percentOfEpisodes || 0,
        seasons,
        sizeOnDisk: stats.sizeOnDisk || 0,
        queueCount: queueItems.length,
        queueItems: queueItems.slice(0, 10).map((item) => ({
          title: item.title,
          status: item.status,
          episodeTitle: item.episode?.title,
          trackedDownloadStatus: item.trackedDownloadStatus,
          trackedDownloadState: item.trackedDownloadState,
          progress: downloadProgress(item),
          size: item.size,
          sizeLeft: item.sizeleft,
          timeLeft: item.timeleft,
          estimatedCompletionTime: item.estimatedCompletionTime,
          errorMessage: item.errorMessage,
        })),
        casualSummary: `${series.title}${series.year ? ` (${series.year})` : ''} has ${stats.episodeFileCount || 0} episode file${(stats.episodeFileCount || 0) === 1 ? '' : 's'} in ${serverName()}. ${seasonSummary}.${casualQueueText}`,
        summary: `${series.title}${series.year ? ` (${series.year})` : ''} is ${series.monitored ? 'monitored' : 'not monitored'} in the TV download/import system. ${fileSummary}; this aggregate may cover only monitored episodes. Season breakdown: ${seasonSummary}. ${queueSummary}`,
      };
    } catch (error) {
      return {
        status: 'service-unavailable',
        query: request.query,
        seasons: [],
        queueCount: 0,
        queueItems: [],
        casualSummary: `I could not check TV download/import status for "${request.query}" right now.`,
        summary: `I could not reach the TV download/import system for a read-only series lookup: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});
