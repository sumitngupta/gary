import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSabnzbdHealth } from './gary-media-health-gate';

for (const status of ['Idle', 'Downloading']) {
  test(`Usenet ${status} queue permits requests without a torrent client`, async () => {
    const result = await checkSabnzbdHealth({
      readConfig: async () => 'api_key = test-key',
      fetchFn: (async (url: URL) => {
        assert.equal(url.searchParams.get('mode'), 'queue');
        assert.equal(url.searchParams.get('apikey'), 'test-key');
        return Response.json({ queue: { paused: false, status } });
      }) as typeof fetch,
    });
    assert.equal(result.healthy, true);
  });
}

for (const body of [
  { queue: { paused: true, status: 'Paused' } },
  { queue: { paused: false, status: 'Paused for post-processing' } },
  { status: false, error: 'API Key Incorrect' },
  { queue: {} },
]) {
  test(`Usenet fails closed for paused or invalid queue: ${JSON.stringify(body)}`, async () => {
    const result = await checkSabnzbdHealth({
      readConfig: async () => 'api_key = test-key',
      fetchFn: (async () => Response.json(body)) as typeof fetch,
    });
    assert.equal(result.healthy, false);
  });
}

test('Usenet fails closed without credentials, on HTTP failure, and redacts transport errors', async () => {
  assert.equal((await checkSabnzbdHealth({ readConfig: async () => '' })).healthy, false);
  assert.equal((await checkSabnzbdHealth({
    readConfig: async () => 'api_key = test-key',
    fetchFn: (async () => new Response('', { status: 503 })) as typeof fetch,
  })).healthy, false);
  const result = await checkSabnzbdHealth({
    readConfig: async () => 'api_key = test-key',
    fetchFn: (async () => { throw new Error('http://sabnzbd/api?apikey=test-key'); }) as typeof fetch,
  });
  assert.deepEqual(result, { healthy: false, detail: 'Usenet download queue unavailable' });
});
