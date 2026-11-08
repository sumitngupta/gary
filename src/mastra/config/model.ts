import type { OpenAICompatibleConfig } from '@mastra/core/llm';
import { garyConfig, type ModelSettings } from './gary-config';

type OpenAIReasoningOptions = { reasoningEffort: 'none' | 'minimal'; forceReasoning?: true };

// Lowest reasoning effort each OpenAI family accepts, checked against the live
// API: gpt-5 and its mini/nano reject 'none'; gpt-5.1 and later reject 'minimal'.
const OPENAI_REASONING: Array<[RegExp, OpenAIReasoningOptions]> = [
  // The installed provider registry has no capability metadata for gpt-6.
  [/^gpt-6/, { reasoningEffort: 'none', forceReasoning: true }],
  [/^gpt-5\.\d/, { reasoningEffort: 'none' }],
  [/^gpt-5(-mini|-nano)?$/, { reasoningEffort: 'minimal' }],
];

export function garyLanguageModel(settings: ModelSettings = garyConfig().model): OpenAICompatibleConfig {
  if (settings.baseUrl) {
    return { providerId: 'custom', modelId: settings.model, url: settings.baseUrl, apiKey: settings.apiKey };
  }
  return { id: settings.model as `${string}/${string}`, apiKey: settings.apiKey };
}

export function garyProviderOptions(settings: ModelSettings = garyConfig().model) {
  if (settings.baseUrl || !settings.model.startsWith('openai/')) return undefined;
  const name = settings.model.slice('openai/'.length);
  const options = OPENAI_REASONING.find(([pattern]) => pattern.test(name))?.[1];
  return options ? { openai: options } : undefined;
}

export function transcriptionEndpoint(settings: ModelSettings = garyConfig().model) {
  if (!settings.transcribeModel) return undefined;
  return {
    url: `${settings.baseUrl || 'https://api.openai.com/v1'}/audio/transcriptions`,
    model: settings.transcribeModel,
    apiKey: settings.apiKey,
  };
}

const MODEL_STATUS_REASONS: Record<number, string> = {
  401: 'the provider rejected LLM_API_KEY',
  403: 'the provider refused LLM_API_KEY for this model',
  404: 'the provider does not know LLM_MODEL',
  429: 'rate limited or out of quota',
};

/** Provider error bodies can echo the key back, so only the status or a network code is reported. */
export function describeModelError(error: unknown): string {
  for (let current = error; current instanceof Error; current = current.cause) {
    const { statusCode, code } = current as Error & { statusCode?: unknown; code?: unknown };
    if (typeof statusCode === 'number') return MODEL_STATUS_REASONS[statusCode] ? `HTTP ${statusCode}: ${MODEL_STATUS_REASONS[statusCode]}` : `HTTP ${statusCode} from the provider`;
    if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) return `could not reach the model endpoint (${code})`;
  }
  return `model call failed (${error instanceof Error ? error.name : typeof error})`;
}
