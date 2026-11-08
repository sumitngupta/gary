import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { blockSeerrMedia, createSeerrRequest, isSeerrMediaBlocked, searchSeerr } from './seerr-readonly-client';

const originalFetch = globalThis.fetch;
const originalSeerrUrl = process.env.SEERR_URL;

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.SEERR_URL = originalSeerrUrl;
});

test('surfaces the Seerr rejection message', async () => {
  process.env.SEERR_URL = 'http://preferred-seerr';

  globalThis.fetch = (async () => new Response(JSON.stringify({ message: 'Request service is temporarily unavailable' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch;

  await assert.rejects(
    searchSeerr('Heat'),
    /Seerr returned HTTP 503: Request service is temporarily unavailable/,
  );
});

test('percent-encodes reserved punctuation in Seerr search queries', async () => {
  process.env.SEERR_URL = 'http://preferred-seerr';

  let requestedUrl = '';
  globalThis.fetch = (async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  await searchSeerr('Fiume o morte!');

  assert.equal(requestedUrl, 'http://preferred-seerr/api/v1/search?query=Fiume%20o%20morte%21');
});

test('passes an explicit hard-quality profile through a Seerr request', async () => {
  process.env.SEERR_URL = 'http://preferred-seerr';

  let requestBody: Record<string, unknown> = {};
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ id: 42, status: 2 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  await createSeerrRequest({ mediaType: 'movie', mediaId: 123, profileId: 8 });
  assert.deepEqual(requestBody, { mediaType: 'movie', mediaId: 123, is4k: false, profileId: 8 });
});

test('refuses an empty TV season scope before calling Seerr', async () => {
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return Response.json({ id: 42, status: 2 });
  }) as typeof fetch;

  await assert.rejects(
    createSeerrRequest({ mediaType: 'tv', mediaId: 1399, seasons: [] }),
    /without an explicit non-empty season scope/,
  );
  assert.equal(fetchCalled, false);
});

test('recreates the blocklist after deleting matching requests so BLOCKLISTED is the final media status', async () => {
  process.env.SEERR_URL = 'http://preferred-seerr';
  const calls: Array<{ url: string; method: string }> = [];

  globalThis.fetch = (async (input, init) => {
    const url = String(input); const method = init?.method || 'GET';
    calls.push({ url, method });
    if (url.includes('/api/v1/blocklist/37854?mediaType=tv') && method === 'DELETE') return new Response(null, { status: 204 });
    if (url.includes('/api/v1/request?')) {
      return Response.json({ pageInfo: { pages: 1 }, results: [
        { id: 7, media: { mediaType: 'tv', tmdbId: 37854 } },
        { id: 8, media: { mediaType: 'movie', tmdbId: 99 } },
      ] });
    }
    if (url.endsWith('/api/v1/blocklist') && method === 'POST') return new Response(null, { status: 201 });
    if (url.endsWith('/api/v1/request/7') && method === 'DELETE') return new Response(null, { status: 204 });
    if (url.includes('/api/v1/blocklist/37854?mediaType=tv')) return Response.json({ tmdbId: 37854, mediaType: 'tv' });
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const result = await blockSeerrMedia({ mediaType: 'tv', tmdbId: 37854, title: 'One Piece' });
  assert.equal(await isSeerrMediaBlocked('tv', 37854), true);
  assert.deepEqual(result.removedRequestIds, [7]);
  assert.deepEqual(calls.map((call) => [call.method, new URL(call.url).pathname]), [
    ['DELETE', '/api/v1/blocklist/37854'],
    ['GET', '/api/v1/request'],
    ['DELETE', '/api/v1/request/7'],
    ['POST', '/api/v1/blocklist'],
    ['GET', '/api/v1/blocklist/37854'],
    ['GET', '/api/v1/blocklist/37854'],
  ]);
});
