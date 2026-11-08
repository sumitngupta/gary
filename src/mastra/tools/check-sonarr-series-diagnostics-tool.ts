import { createTool } from '@mastra/core/tools';
import {
  sonarrSeriesDiagnosticsInputSchema,
  sonarrSeriesDiagnosticsOutputSchema,
  type SonarrSeriesDiagnosticsOutput,
} from '../schemas/media-service-status';
import { getSonarrSeriesDiagnostics } from '../services/arr-readonly-client';

export const checkSonarrSeriesDiagnosticsTool = createTool({
  id: 'check-sonarr-series-diagnostics',
  description:
    'Read-only deeper TV import diagnostic for series history, blocklist, indexer search capability, health, missing aired episodes, and queue state. Does not trigger searches, downloads, imports, monitoring changes, or file changes.',
  inputSchema: sonarrSeriesDiagnosticsInputSchema,
  outputSchema: sonarrSeriesDiagnosticsOutputSchema,
  execute: async (input): Promise<SonarrSeriesDiagnosticsOutput> => {
    const request = sonarrSeriesDiagnosticsInputSchema.parse(input);

    try {
      const result = await getSonarrSeriesDiagnostics(request);

      if (!result) {
        return {
          status: 'not-found',
          query: request.query,
          queueCount: 0,
          recentHistory: [],
          blocklistItems: [],
          indexers: [],
          health: [],
          casualSummary: `${request.query}${request.year ? ` (${request.year})` : ''} is not in the TV import system.`,
          summary: `${request.query}${request.year ? ` (${request.year})` : ''} was not found in the TV import system.`,
        };
      }

      const { series, missingAiredMonitoredEpisodes, queueItems, historyItems, blocklistItems, indexers, health } = result;
      const stats = series.statistics || {};
      const enabledSearchIndexers = indexers.filter((indexer) =>
        indexer.supportsSearch !== false
        && (indexer.enableAutomaticSearch !== false || indexer.enableInteractiveSearch !== false),
      );
      const recentFailedEvents = historyItems.filter((item) =>
        /failed|downloadFailed|grabbed/i.test(item.eventType || ''),
      );
      const title = `${series.title}${series.year ? ` (${series.year})` : ''}`;

      const causalHints = [
        blocklistItems.length > 0 ? `${blocklistItems.length} blocklisted release${blocklistItems.length === 1 ? '' : 's'}` : undefined,
        recentFailedEvents.length > 0 ? `${recentFailedEvents.length} recent failed/grabbed history event${recentFailedEvents.length === 1 ? '' : 's'}` : undefined,
        enabledSearchIndexers.length === 0 ? 'no search-enabled indexers visible' : undefined,
        health.length > 0 ? `${health.length} TV import health warning${health.length === 1 ? '' : 's'}` : undefined,
      ].filter((hint): hint is string => Boolean(hint));
      const hintText = causalHints.length > 0
        ? ` Possible clues: ${causalHints.join(', ')}.`
        : ' No blocklist entries, recent failed history events, or indexer health warnings showed up in this read-only check.';

      return {
        status: 'found',
        query: request.query,
        title: series.title,
        year: series.year,
        seriesId: series.id,
        monitored: Boolean(series.monitored),
        episodeFileCount: stats.episodeFileCount || 0,
        episodeCount: stats.episodeCount || 0,
        missingAiredMonitoredCount: missingAiredMonitoredEpisodes.length,
        queueCount: queueItems.length,
        recentHistory: historyItems.slice(0, request.historyLimit).map((item) => ({
          date: item.date,
          eventType: item.eventType,
          sourceTitle: item.sourceTitle,
          episodeTitle: item.episode?.title,
          seasonNumber: item.episode?.seasonNumber,
          episodeNumber: item.episode?.episodeNumber,
          downloadId: item.downloadId,
        })),
        blocklistItems: blocklistItems.slice(0, request.blocklistLimit).map((item) => ({
          date: item.date,
          sourceTitle: item.sourceTitle,
          indexer: item.indexer,
          protocol: item.protocol,
          reason: item.reason,
        })),
        indexers: indexers.map((indexer) => ({
          name: indexer.name,
          protocol: indexer.protocol,
          enableAutomaticSearch: indexer.enableAutomaticSearch,
          enableInteractiveSearch: indexer.enableInteractiveSearch,
          supportsSearch: indexer.supportsSearch,
          priority: indexer.priority,
        })),
        health: health.map((item) => ({
          type: item.type,
          source: item.source,
          message: item.message,
        })),
        casualSummary: `${title} is monitored but stalled: ${stats.episodeFileCount || 0}/${stats.episodeCount || 0} episodes are present, ${missingAiredMonitoredEpisodes.length} aired monitored episodes are missing, and ${queueItems.length} item${queueItems.length === 1 ? ' is' : 's are'} in the queue.${hintText}`,
        summary: `${title} diagnostics: ${stats.episodeFileCount || 0}/${stats.episodeCount || 0} episodes present; ${missingAiredMonitoredEpisodes.length} aired monitored episodes missing; ${queueItems.length} queue items; ${historyItems.length} recent history items; ${blocklistItems.length} blocklist items; ${enabledSearchIndexers.length}/${indexers.length} indexers search-enabled; ${health.length} health warnings.`,
      };
    } catch (error) {
      return {
        status: 'service-unavailable',
        query: request.query,
        queueCount: 0,
        recentHistory: [],
        blocklistItems: [],
        indexers: [],
        health: [],
        casualSummary: `I could not run deeper TV import diagnostics for "${request.query}" right now.`,
        summary: `I could not reach the TV import system for deeper read-only diagnostics: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});
