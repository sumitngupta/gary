import assert from 'node:assert/strict';
import test from 'node:test';
import { webFetchOutputSchema } from '../schemas/web-lookup';
import { fetchWebPage } from './web-lookup-client';

test('Exa fetch normalizes nullable optional metadata before tool validation', async () => {
  const originalFetch = globalThis.fetch;
  const originalExaKey = process.env.EXA_API_KEY;
  const originalBrightDataToken = process.env.BRIGHTDATA_API_TOKEN;
  const originalBrightDataZone = process.env.BRIGHTDATA_WEB_UNLOCKER_ZONE;

  process.env.EXA_API_KEY = 'test-key';
  delete process.env.BRIGHTDATA_API_TOKEN;
  delete process.env.BRIGHTDATA_WEB_UNLOCKER_ZONE;
  globalThis.fetch = async () => new Response(JSON.stringify({
    results: [{
      title: 'Editora AI',
      url: 'https://www.editora.ai/',
      author: null,
      publishedDate: null,
      text: 'Automated real estate listing videos.',
      highlights: null,
    }],
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  try {
    const result = await fetchWebPage({
      url: 'https://www.editora.ai/',
      contentMode: 'text',
    });
    const parsed = webFetchOutputSchema.parse(result);

    assert.equal(parsed.status, 'ok');
    assert.equal(parsed.page?.author, undefined);
    assert.equal(parsed.page?.publishedDate, undefined);
    assert.deepEqual(parsed.page?.highlights, []);
    assert.equal(parsed.page?.content, 'Automated real estate listing videos.');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalExaKey === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = originalExaKey;
    if (originalBrightDataToken === undefined) delete process.env.BRIGHTDATA_API_TOKEN;
    else process.env.BRIGHTDATA_API_TOKEN = originalBrightDataToken;
    if (originalBrightDataZone === undefined) delete process.env.BRIGHTDATA_WEB_UNLOCKER_ZONE;
    else process.env.BRIGHTDATA_WEB_UNLOCKER_ZONE = originalBrightDataZone;
  }
});
