import assert from 'node:assert/strict';
import test from 'node:test';
import { garyLanguageModel, garyProviderOptions, transcriptionEndpoint } from './model';

test('the default OpenAI route passes the router id and key explicitly', () => {
  const settings = { model: 'openai/gpt-5.6-luna', apiKey: 'llm-key' };
  assert.deepEqual(garyLanguageModel(settings), { id: 'openai/gpt-5.6-luna', apiKey: 'llm-key' });
});

test('LLM_BASE_URL produces the custom OpenAI-compatible model shape', () => {
  const settings = { model: 'meta-llama/Llama-3.1-8B-Instruct', apiKey: 'local-key', baseUrl: 'http://vllm.test/v1' };
  assert.deepEqual(garyLanguageModel(settings), {
    providerId: 'custom',
    modelId: 'meta-llama/Llama-3.1-8B-Instruct',
    url: 'http://vllm.test/v1',
    apiKey: 'local-key',
  });
});

test('OpenAI reasoning options follow what each model family accepts', () => {
  assert.deepEqual(garyProviderOptions({ model: 'openai/gpt-5.6-luna' }), { openai: { reasoningEffort: 'none' } });
  assert.deepEqual(garyProviderOptions({ model: 'openai/gpt-5-mini' }), { openai: { reasoningEffort: 'minimal' } });
  assert.deepEqual(garyProviderOptions({ model: 'openai/gpt-6-luna' }), { openai: { reasoningEffort: 'none', forceReasoning: true } });
  assert.equal(garyProviderOptions({ model: 'openai/gpt-4.1-mini' }), undefined);
});

test('OpenAI-only options are omitted for other providers and custom endpoints', () => {
  assert.equal(garyProviderOptions({ model: 'anthropic/claude-sonnet-4-6' }), undefined);
  assert.equal(garyProviderOptions({ model: 'gpt-5.6-luna', baseUrl: 'http://proxy.test/v1' }), undefined);
});

test('transcription is off unless a model is configured', () => {
  assert.equal(transcriptionEndpoint({ model: 'local', baseUrl: 'http://llm.test/v1' }), undefined);
  assert.deepEqual(transcriptionEndpoint({ model: 'openai/gpt-5.6-luna', apiKey: 'k', transcribeModel: 'gpt-4o-mini-transcribe' }), {
    url: 'https://api.openai.com/v1/audio/transcriptions', model: 'gpt-4o-mini-transcribe', apiKey: 'k',
  });
});
