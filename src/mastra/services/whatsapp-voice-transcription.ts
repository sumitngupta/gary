const MAX_VOICE_BYTES = 25 * 1024 * 1024;

type FetchLike = typeof fetch;

export async function transcribeWhatsAppVoice(
  data: Buffer,
  mimeType = 'audio/ogg',
  fetchImpl: FetchLike = fetch,
) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('Voice transcription is not configured');
  if (data.byteLength === 0) throw new Error('The voice message was empty');
  if (data.byteLength > MAX_VOICE_BYTES) throw new Error('The voice message is larger than 25 MB');

  const form = new FormData();
  form.append('model', process.env.GARY_TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe');
  form.append('response_format', 'json');
  form.append('file', new Blob([new Uint8Array(data)], { type: mimeType }), mimeType.includes('mpeg') ? 'voice.mp3' : 'voice.ogg');

  const response = await fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Voice transcription failed with status ${response.status}`);
  const result = await response.json() as { text?: unknown };
  if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('Voice transcription returned no text');
  return result.text.trim();
}
