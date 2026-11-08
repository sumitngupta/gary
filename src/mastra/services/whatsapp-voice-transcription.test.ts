import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { transcribeWhatsAppVoice } from './whatsapp-voice-transcription';

function useEnv(t: TestContext, values: Record<string, string | undefined>) {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
}

function recordingFetch() {
  const calls: Array<{ url: string; authorization: string | null; model: FormDataEntryValue | null }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization'), model: (init?.body as FormData).get('model') });
    return Response.json({ text: ' Please check whether Heat is available. ' });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test('sends voice data to the OpenAI transcription endpoint with the LLM key', async (t) => {
  useEnv(t, { LLM_API_KEY: 'test-key', LLM_BASE_URL: undefined, LLM_TRANSCRIBE_MODEL: undefined });
  const { calls, fetchImpl } = recordingFetch();
  assert.equal(await transcribeWhatsAppVoice(Buffer.from('voice bytes'), 'audio/ogg', fetchImpl), 'Please check whether Heat is available.');
  assert.deepEqual(calls, [{ url: 'https://api.openai.com/v1/audio/transcriptions', authorization: 'Bearer test-key', model: 'gpt-4o-mini-transcribe' }]);
});

test('uses the custom base URL when a transcription model is configured for it', async (t) => {
  useEnv(t, { LLM_API_KEY: undefined, LLM_BASE_URL: 'http://llm.test/v1/', LLM_MODEL: 'local-model', LLM_TRANSCRIBE_MODEL: 'whisper-1' });
  const { calls, fetchImpl } = recordingFetch();
  await transcribeWhatsAppVoice(Buffer.from('voice bytes'), 'audio/ogg', fetchImpl);
  assert.deepEqual(calls, [{ url: 'http://llm.test/v1/audio/transcriptions', authorization: null, model: 'whisper-1' }]);
});

test('voice transcription is off for a custom endpoint without a transcription model', async (t) => {
  useEnv(t, { LLM_BASE_URL: 'http://llm.test/v1', LLM_MODEL: 'local-model', LLM_TRANSCRIBE_MODEL: undefined });
  await assert.rejects(() => transcribeWhatsAppVoice(Buffer.from('voice bytes')), { message: 'Voice transcription is not configured' });
});

test('rejects empty and oversized voice messages before calling the endpoint', async () => {
  await assert.rejects(() => transcribeWhatsAppVoice(Buffer.alloc(0)), /empty/);
  await assert.rejects(() => transcribeWhatsAppVoice(Buffer.alloc(25 * 1024 * 1024 + 1)), /25 MB/);
});
