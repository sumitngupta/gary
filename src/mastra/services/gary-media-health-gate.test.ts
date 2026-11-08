import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGaryConfig } from '../config/gary-config';
import { checkGaryMediaHealthGate, checkSabnzbdHealth } from './gary-media-health-gate';

const sabnzbd = { url: 'http://sabnzbd.test', apiKey: 'test-key' };

for (const status of ['Idle', 'Downloading']) {
  test(`Usenet ${status} queue permits requests`, async () => {
    const result = await checkSabnzbdHealth(sabnzbd, (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      assert.equal(url.searchParams.get('mode'), 'queue');
      assert.equal(url.searchParams.get('apikey'), 'test-key');
      return Response.json({ queue: { paused: false, status } });
    }) as typeof fetch);
    assert.deepEqual(result, { healthy: true, detail: `Usenet download queue responded (${status})` });
  });
}

for (const body of [
  { queue: { paused: true, status: 'Paused' } },
  { queue: { paused: false, status: 'Paused for post-processing' } },
  { status: false, error: 'API Key Incorrect' },
  { queue: {} },
]) {
  test(`Usenet fails closed for paused or invalid queue: ${JSON.stringify(body)}`, async () => {
    const result = await checkSabnzbdHealth(sabnzbd, (async () => Response.json(body)) as typeof fetch);
    assert.equal(result.healthy, false);
  });
}

test('Usenet fails closed on HTTP failure and redacts transport errors', async () => {
  assert.deepEqual(
    await checkSabnzbdHealth(sabnzbd, (async () => new Response('', { status: 503 })) as typeof fetch),
    { healthy: false, detail: 'Usenet download queue responded (503)' },
  );
  assert.deepEqual(
    await checkSabnzbdHealth(sabnzbd, (async () => { throw new Error('http://sabnzbd/api?apikey=test-key'); }) as typeof fetch),
    { healthy: false, detail: 'Usenet download queue unavailable' },
  );
});

test('the gate checks only the services that are configured', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requested: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requested.push(`${url.host}${url.pathname}`);
    return Response.json({ version: '2.7.0' });
  }) as typeof fetch;
  const gate = await checkGaryMediaHealthGate(parseGaryConfig({ SEERR_URL: 'http://seerr.test', SEERR_API_KEY: 'k', LLM_API_KEY: 'k' }));
  assert.deepEqual(gate, { healthy: true, checks: { seerr: { healthy: true, detail: 'request service responded' } } });
  assert.deepEqual(requested.sort(), ['seerr.test/api/v1/auth/me', 'seerr.test/api/v1/status']);
});
