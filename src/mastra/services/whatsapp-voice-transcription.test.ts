import assert from 'node:assert/strict';
import test from 'node:test';
import { transcribeWhatsAppVoice } from './whatsapp-voice-transcription';
import { serverName } from '../config/branding';

test('sends WhatsApp voice data to the transcription endpoint', async () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  try {
    const calls: Array<{ url: string; authorization: string | null; body: FormData }> = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization'),
        body: init?.body as FormData,
      });
      return Response.json({ text: `Please check whether Heat is in ${serverName()}.` });
    }) as typeof fetch;
    const transcript = await transcribeWhatsAppVoice(Buffer.from('voice bytes'), 'audio/ogg', fakeFetch);
    assert.equal(transcript, `Please check whether Heat is in ${serverName()}.`);
    assert.equal(calls[0]?.url, 'https://api.openai.com/v1/audio/transcriptions');
    assert.equal(calls[0]?.authorization, 'Bearer test-key');
    assert.equal(calls[0]?.body.get('model'), 'gpt-4o-mini-transcribe');
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test('rejects empty and oversized voice messages before calling OpenAI', async () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  try {
    await assert.rejects(() => transcribeWhatsAppVoice(Buffer.alloc(0)), /empty/);
    await assert.rejects(() => transcribeWhatsAppVoice(Buffer.alloc(25 * 1024 * 1024 + 1)), /25 MB/);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});
