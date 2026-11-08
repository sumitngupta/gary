import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { assertMutationAllowed, ENV_NAMES, GaryConfigError, parseGaryConfig, requireService } from './gary-config';

const seerrOnly = { SEERR_URL: 'http://seerr.test:5055/', SEERR_API_KEY: 'seerr-key', LLM_API_KEY: 'llm-key' };

function problems(env: Record<string, string>) {
  try {
    parseGaryConfig(env);
  } catch (error) {
    assert.ok(error instanceof GaryConfigError);
    return error.problems;
  }
  assert.fail('expected the configuration to be rejected');
}

test('a Seerr-only configuration parses with documented defaults', () => {
  const config = parseGaryConfig(seerrOnly);
  assert.deepEqual(config.services, { seerr: { url: 'http://seerr.test:5055', apiKey: 'seerr-key' } });
  assert.equal(config.dataDir, './data');
  assert.equal(config.port, 4111);
  assert.equal(config.readOnly, false);
  assert.equal(config.allowRequests, true);
  assert.deepEqual(config.model, { model: 'openai/gpt-5.6-luna', apiKey: 'llm-key', transcribeModel: 'gpt-4o-mini-transcribe' });
});

test('Seerr is required even when Sonarr and Radarr are configured', () => {
  assert.deepEqual(problems({
    LLM_API_KEY: 'llm-key',
    SONARR_URL: 'http://sonarr.test', SONARR_API_KEY: 'sonarr-key',
    RADARR_URL: 'http://radarr.test', RADARR_API_KEY: 'radarr-key',
  }), ['Seerr is required: Gary sends every media request through it. Set SEERR_URL and SEERR_API_KEY.']);
});

test('a half-configured Seerr block reports only the missing half', () => {
  assert.deepEqual(problems({ LLM_API_KEY: 'llm-key', SEERR_URL: 'http://seerr.test' }), ['SEERR_API_KEY is required when SEERR_URL is set.']);
});

test('a half-configured service block fails and names the missing variable', () => {
  assert.deepEqual(problems({ ...seerrOnly, PLEX_URL: 'http://plex.test' }), ['PLEX_TOKEN is required when PLEX_URL is set.']);
  assert.deepEqual(problems({ ...seerrOnly, TAUTULLI_API_KEY: 'k' }), ['TAUTULLI_URL is required when TAUTULLI_API_KEY is set.']);
});

test('malformed values are reported against their variable', () => {
  assert.deepEqual(problems({ ...seerrOnly, SONARR_URL: 'sonarr:8989', SONARR_API_KEY: 'k', GARY_READ_ONLY: 'maybe' }).map((line) => line.split(':')[0]), [
    'GARY_READ_ONLY',
    'SONARR_URL',
  ]);
});

test('blank variables count as unset', () => {
  assert.equal(parseGaryConfig({ ...seerrOnly, PLEX_URL: '', PLEX_TOKEN: '  ' }).services.plex, undefined);
});

test('the LLM key falls back to OPENAI_API_KEY and is required without a base URL', () => {
  assert.equal(parseGaryConfig({ ...seerrOnly, LLM_API_KEY: '', OPENAI_API_KEY: 'openai-key' }).model.apiKey, 'openai-key');
  assert.deepEqual(problems({ SEERR_URL: 'http://seerr.test', SEERR_API_KEY: 'k' }), [
    'LLM_API_KEY is required (OPENAI_API_KEY is accepted as a fallback) unless LLM_BASE_URL points at an endpoint without auth.',
  ]);
});

test('a custom endpoint takes a bare model name, needs no key, and has no default transcription model', () => {
  const config = parseGaryConfig({ SEERR_URL: 'http://seerr.test', SEERR_API_KEY: 'k', LLM_BASE_URL: 'http://ollama.test:11434/v1/', LLM_MODEL: 'llama3.1:8b' });
  assert.deepEqual(config.model, { model: 'llama3.1:8b', apiKey: undefined, baseUrl: 'http://ollama.test:11434/v1', transcribeModel: undefined });
  assert.deepEqual(problems({ ...seerrOnly, LLM_MODEL: 'llama3.1:8b' }), [
    'LLM_MODEL must be a provider/model id such as openai/gpt-5.6-luna unless LLM_BASE_URL is set.',
  ]);
});

test('requireService explains how to enable a missing service', () => {
  const config = parseGaryConfig(seerrOnly);
  assert.deepEqual(requireService('seerr', config), { url: 'http://seerr.test:5055', apiKey: 'seerr-key' });
  assert.throws(() => requireService('radarr', config), { message: 'Radarr is not configured on this server. Set RADARR_URL and RADARR_API_KEY to enable it.' });
});

test('read-only mode refuses every mutation and GARY_ALLOW_REQUESTS=false refuses only requests', () => {
  const readOnly = parseGaryConfig({ ...seerrOnly, GARY_READ_ONLY: 'true' });
  assert.throws(() => assertMutationAllowed('message', readOnly), { message: 'Gary is running in read-only mode (GARY_READ_ONLY=true), so I did not send that message.' });
  const noRequests = parseGaryConfig({ ...seerrOnly, GARY_ALLOW_REQUESTS: 'false' });
  assert.throws(() => assertMutationAllowed('request', noRequests), { message: 'New media requests are turned off on this server (GARY_ALLOW_REQUESTS=false), so I did not submit that request.' });
  assert.equal(assertMutationAllowed('change', noRequests), undefined);
});

test('channels are enabled by presence and a partial WhatsApp block names what is missing', () => {
  const none = parseGaryConfig(seerrOnly);
  assert.deepEqual([none.web.adminPassword, none.telegram, none.whatsapp], [undefined, undefined, undefined]);
  const both = parseGaryConfig({ ...seerrOnly, GARY_ADMIN_PASSWORD: 'pw', TELEGRAM_BOT_TOKEN: 'bot-token' });
  assert.deepEqual([both.web.adminPassword, both.telegram], ['pw', { botToken: 'bot-token' }]);
  assert.deepEqual(problems({ ...seerrOnly, GARY_WHATSAPP_ACCESS_TOKEN: 't', GARY_WHATSAPP_APP_SECRET: 's' }), [
    'WhatsApp is partly configured. Also set GARY_WHATSAPP_PHONE_NUMBER_ID, GARY_WHATSAPP_VERIFY_TOKEN, or unset the other GARY_WHATSAPP_* credentials.',
  ]);
});

test('.env.example documents every variable the config reads, and the example parses', () => {
  const example = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
  const documented = [...example.matchAll(/^#? ?([A-Z][A-Z0-9_]+)=/gm)].map((match) => match[1]);
  assert.deepEqual([...documented].sort(), [...ENV_NAMES].sort());
  const required = Object.fromEntries([...example.matchAll(/^([A-Z][A-Z0-9_]+)=(.*)$/gm)].map(([, name, value]) => [name, value || 'filled-in']));
  assert.deepEqual(Object.keys(required), ['LLM_API_KEY', 'SEERR_URL', 'SEERR_API_KEY']);
  assert.equal(parseGaryConfig(required).services.seerr?.url, 'http://seerr:5055');
});
