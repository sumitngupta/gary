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
