import assert from 'node:assert/strict';
import test from 'node:test';
import { describeModelError, garyLanguageModel, garyProviderOptions, transcriptionEndpoint } from './model';

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

test('a rejected model key is described by status only, never by the provider message', () => {
  const upstream = Object.assign(new Error('Incorrect API key provided: sk-proj-abc...xyz. You can find your key at ...'), { statusCode: 401 });
  const wrapped = new Error('Agent generate failed', { cause: upstream });
  assert.equal(describeModelError(wrapped), 'HTTP 401: the provider rejected LLM_API_KEY');
});

test('other model failures name the status or the error class', () => {
  assert.equal(describeModelError(Object.assign(new Error('model gpt-x does not exist'), { statusCode: 404 })), 'HTTP 404: the provider does not know LLM_MODEL');
  assert.equal(describeModelError(Object.assign(new Error('slow down'), { statusCode: 429 })), 'HTTP 429: rate limited or out of quota');
  assert.equal(describeModelError(Object.assign(new Error('boom'), { statusCode: 502 })), 'HTTP 502 from the provider');
  assert.equal(describeModelError(new Error('fetch failed', { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) })), 'could not reach the model endpoint (ECONNREFUSED)');
});
