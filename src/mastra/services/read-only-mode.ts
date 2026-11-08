import { garyConfig } from '../config/gary-config';

const readOnlyTools = new Set([
  'checkMediaStatus',
  'checkMediaStatuses',
  'checkPlexAvailability',
  'checkRadarrMovieStatus',
  'checkSonarrSeriesDiagnostics',
  'checkSonarrSeriesStatus',
  'inspectGaryRequestHistory',
  'webFetch',
  'webSearch',
  'extractLinkedVisualList',
  'auditMediaQualityObjective',
  'verifyRecommendationConstraints',
  'planMediaRadar',
  'planMediaRequest',
  'updateWorkingMemory',
]);

export function assertReadOnlyToolAllowed(toolName: string, config = garyConfig()) {
  if (!config.readOnly || readOnlyTools.has(toolName)) return;
  throw new Error(`Gary is running in read-only mode (GARY_READ_ONLY=true), so ${toolName} is turned off.`);
}
