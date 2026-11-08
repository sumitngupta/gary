export const FLEET_MODEL_USE_CASE_CONTEXT_KEY = 'fleetModelUseCase';

export const fleetModels = {
  default: process.env.FLEET_DEFAULT_MODEL || 'openai/gpt-5.6-luna',
  gary: process.env.GARY_AGENT_MODEL || 'openai/gpt-6-luna',
  efficient: process.env.FLEET_EFFICIENT_MODEL || 'openai/gpt-5.6-luna',
  balanced: process.env.FLEET_BALANCED_MODEL || 'openai/gpt-5.6-terra',
} as const;

export type FleetModelUseCase =
  | 'default'
  | 'bounded-classification'
  | 'bounded-home-conversation'
  | 'bounded-media-operation'
  | 'media-recommendation'
  | 'media-taste-synthesis'
  | 'complex-escalation';

export function resolveFleetModel(useCase: FleetModelUseCase = 'default') {
  switch (useCase) {
    case 'bounded-classification':
    case 'bounded-home-conversation':
    case 'bounded-media-operation':
      return fleetModels.efficient;
    case 'complex-escalation':
      return fleetModels.balanced;
    case 'media-recommendation':
    case 'media-taste-synthesis':
    case 'default':
    default:
      return fleetModels.default;
  }
}

export function resolveGaryFleetModel(useCase: FleetModelUseCase = 'default') {
  // Gary uses one model across every channel. Keep it independent of the
  // general default so helper paths can change models on their own cadence.
  return fleetModels.gary;
}

export function fleetProviderOptions(model: string) {
  // The installed provider needs explicit capability metadata for GPT-6.
  if (model === fleetModels.gary && model.startsWith('openai/gpt-6')) {
    return { openai: { reasoningEffort: 'none' as const, forceReasoning: true } };
  }
  return (model === fleetModels.efficient || model === fleetModels.gary)
    ? { openai: { reasoningEffort: 'none' as const } }
    : undefined;
}

export function fleetEvaluationTelemetry(input: {
  result: unknown;
  resourceId: string;
  threadId: string;
  useCase: FleetModelUseCase;
  model?: string;
}) {
  const evaluationIdentity = input.resourceId.startsWith('model-eval:')
    || input.resourceId.startsWith('model-shadow:')
    || input.threadId.startsWith('model-eval:')
    || input.threadId.startsWith('model-shadow:');
  if (!evaluationIdentity) return undefined;
  const usage = (input.result as { usage?: Record<string, unknown> })?.usage;
  const token = (key: string) => Number.isFinite(Number(usage?.[key]))
    ? Math.max(0, Math.round(Number(usage?.[key])))
    : 0;
  const model = input.model || resolveFleetModel(input.useCase);
  return {
    model,
    useCase: input.useCase,
    reasoningEffort: fleetProviderOptions(model)?.openai.reasoningEffort || 'deployment-default',
    inputTokens: token('inputTokens'),
    cachedInputTokens: token('cachedInputTokens'),
    cacheCreationInputTokens: token('cacheCreationInputTokens'),
    outputTokens: token('outputTokens'),
    reasoningTokens: token('reasoningTokens'),
    totalTokens: token('totalTokens'),
  };
}

export function classifyGaryDelegatedUseCase(task: string): FleetModelUseCase {
  if (/\b(recommend|recommendation|shortlist|radar|what (?:should|can) .*watch|anything good)\b/i.test(task)) {
    return 'media-recommendation';
  }

  if (/\b(taste|preference|profile|viewing history|watch history|similar to what .*watch)\b/i.test(task)) {
    return 'media-taste-synthesis';
  }

  if (/\b(diagnostic|debug|repair|stuck|stalled|why|research|investigate|deep dive)\b/i.test(task)) {
    return 'default';
  }

  if (/\b(status|available|streamable|queue|download|import|ready|do we have|request|watch for)\b/i.test(task)) {
    return 'bounded-media-operation';
  }

  return 'default';
}
