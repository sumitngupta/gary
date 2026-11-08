import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { PinoLogger } from '@mastra/loggers';
import { garyAgent } from './agents/gary-agent';
import { garyPendingIntentInterpreterAgent } from './agents/gary-pending-intent-interpreter-agent';
import { garyEscalationDispositionRoute, garyEscalationsRoute, garyOperationTimelineRoute } from './routes/gary-operations';
import { healthzRoute } from './routes/health';
import {
  mediaAvailabilityWatchRoute,
  mediaAvailabilityWatchSweepRoute,
  plexMediaEventRoute,
  radarrMediaEventRoute,
  sonarrMediaEventRoute,
} from './routes/media-availability-watch';
import { whatsappGaryDeliveryRoute, whatsappGaryVerificationRoute } from './routes/whatsapp-verification';
import { modelEvaluationModeEnabled } from './services/model-evaluation-safety';
import { garyLinkedVisualExtractionWorkflow } from './workflows/gary-linked-visual-extraction-workflow';
import { garyListShelfSyncWorkflow } from './workflows/gary-list-shelf-sync-workflow';
import { garyMediaQualityWorkflow } from './workflows/gary-media-quality-workflow';
import { garyRecommendationVerificationWorkflow } from './workflows/gary-recommendation-verification-workflow';
import { garyTitleResolutionWorkflow } from './workflows/gary-title-resolution-workflow';
import { mediaAvailabilityWatchWorkflow } from './workflows/media-availability-watch-workflow';

const dataDir = process.env.GARY_DATA_DIR || './data';
mkdirSync(dataDir, { recursive: true });

function isMediaRadarSchedule(agentId: string, metadata: unknown) {
  return agentId === 'gary' && (metadata as { kind?: string } | undefined)?.kind === 'gary-media-radar';
}

export const mastra = new Mastra({
  bundler: {
    externals: true,
  },
  agents: {
    gary: garyAgent,
    garyPendingIntentInterpreter: garyPendingIntentInterpreterAgent,
  },
  workflows: {
    mediaAvailabilityWatch: mediaAvailabilityWatchWorkflow,
    garyTitleResolution: garyTitleResolutionWorkflow,
    garyLinkedVisualExtraction: garyLinkedVisualExtractionWorkflow,
    garyMediaQuality: garyMediaQualityWorkflow,
    garyRecommendationVerification: garyRecommendationVerificationWorkflow,
    garyListShelfSync: garyListShelfSyncWorkflow,
  },
  scheduler: { enabled: !modelEvaluationModeEnabled() },
  schedules: {
    prepare: async ({ agentId, schedule }) => {
      if (!isMediaRadarSchedule(agentId, schedule.metadata)) return undefined;
      const [{ getMediaRadarSubscription, updateMediaRadarSubscription }, { mediaRadarSchedulePrompt }] = await Promise.all([
        import('./services/media-radar-subscription-store'),
        import('./tools/media-radar-subscription-tools'),
      ]);
      const item = await getMediaRadarSubscription(schedule.id);
      if (!item || item.status !== 'active') return null;
      await updateMediaRadarSubscription(item.id, { lastRunAt: new Date().toISOString(), lastError: undefined });
      return {
        threadId: `gary-radar:${item.id}:${randomUUID()}`,
        prompt: mediaRadarSchedulePrompt({
          subscriptionId: item.id,
          theme: item.theme,
          constraints: item.constraints,
          preferredGenres: item.preferredGenres,
          blockedGenres: item.blockedGenres,
          shortlistSize: item.shortlistSize,
          previouslySurfaced: item.surfaced.map((entry) => `${entry.title}${entry.year ? ` (${entry.year})` : ''}`),
        }),
      };
    },
    onFinish: async ({ agentId, schedule, outcome }) => {
      if (!isMediaRadarSchedule(agentId, schedule.metadata) || outcome === 'skipped') return;
      const { getMediaRadarSubscription, updateMediaRadarSubscription } = await import('./services/media-radar-subscription-store');
      const item = await getMediaRadarSubscription(schedule.id);
      if (item && (!item.lastDeliveredAt || item.lastDeliveredAt < (item.lastRunAt || ''))) {
        await updateMediaRadarSubscription(item.id, { lastError: 'The scheduled run ended without an accepted digest delivery.' });
      }
    },
    onError: async ({ agentId, schedule, error }) => {
      if (!isMediaRadarSchedule(agentId, schedule.metadata)) return;
      const { updateMediaRadarSubscription } = await import('./services/media-radar-subscription-store');
      await updateMediaRadarSubscription(schedule.id, { lastError: error.message, lastRunAt: new Date().toISOString() });
    },
  },
  storage: new LibSQLStore({
    id: 'gary-storage',
    url: `file:${dataDir}/mastra.db`,
  }),
  logger: new PinoLogger({
    name: 'Gary',
    level: 'info',
  }),
  server: {
    apiRoutes: [
      healthzRoute,
      whatsappGaryVerificationRoute,
      whatsappGaryDeliveryRoute,
      garyEscalationsRoute,
      garyEscalationDispositionRoute,
      garyOperationTimelineRoute,
      mediaAvailabilityWatchRoute,
      mediaAvailabilityWatchSweepRoute,
      sonarrMediaEventRoute,
      radarrMediaEventRoute,
      plexMediaEventRoute,
    ],
    build: {
      apiReqLogs: {
        enabled: true,
        excludePaths: ['/healthz'],
      },
    },
  },
});
