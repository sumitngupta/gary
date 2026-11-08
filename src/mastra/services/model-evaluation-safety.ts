const evaluationSafeTools = new Set([
  'checkMediaStatus',
  'inspectGaryRequestHistory',
  'checkMediaStatuses',
  'checkPlexAvailability',
  'checkRadarrMovieStatus',
  'checkSonarrSeriesDiagnostics',
  'checkSonarrSeriesStatus',
  'codexBridgeStatus',
  'delegateToGaryMedia',
  'webFetch',
  'extractLinkedVisualList',
  'auditMediaQualityObjective',
  'verifyRecommendationConstraints',
  'webSearch',
  'planMediaRadar',
  'planMediaRequest',
  'updateWorkingMemory',
]);

export function modelEvaluationModeEnabled() {
  return process.env.GARY_MODEL_EVALUATION_MODE === 'true';
}

export function assertModelEvaluationToolAllowed(toolName: string) {
  if (!modelEvaluationModeEnabled()) return;
  if (evaluationSafeTools.has(toolName)) return;
  throw new Error(
    `Model evaluation mode blocked non-read-only tool ${toolName}`,
  );
}
