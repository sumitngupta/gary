import assert from 'node:assert/strict';
import test from 'node:test';
import { extractLinkedVisualList, mediaUrlsFromHtml, outboundUrlsFromText, safePublicHttpUrl } from './gary-linked-visual-extraction-workflow';

test('linked visual discovery resolves Open Graph and gallery images without private-network URLs', () => {
  assert.deepEqual(mediaUrlsFromHtml(`
    <meta property="og:image" content="/poster.jpg">
    <img src="https://cdn.example.com/list-2.png">
    <img src="http://192.168.1.20/private.png"> <!-- scrub-allow: private-network fixture -->
  `, 'https://example.com/post/1'), [
    'https://example.com/poster.jpg',
    'https://cdn.example.com/list-2.png',
  ]);
  assert.equal(safePublicHttpUrl('http://localhost/secret'), undefined);
  assert.equal(safePublicHttpUrl('http://10.0.0.2/secret'), undefined); // scrub-allow: private-network fixture
  assert.equal(safePublicHttpUrl('https://example.com/list.jpg'), 'https://example.com/list.jpg');
});

test('linked page text promotes embedded social-media sources for visual discovery', () => {
  assert.deepEqual(outboundUrlsFromText(
    'Source https://www.instagram.com/p/example/?img_index=1 and context https://example.org/article.',
    'https://www.reddit.com/r/example/post',
  ), ['https://www.instagram.com/p/example/?img_index=1', 'https://example.org/article']);
});

test('Bob-style linked infographic becomes a source-bound structured list', async () => {
  const result = await extractLinkedVisualList({
    url: 'https://www.reddit.com/r/example/s/shared',
    query: 'MCU catch-up titles shown in the linked infographic',
    maxItems: 20,
  }, {
    fetchPage: async () => ({ status: 'ok', url: 'https://www.reddit.com/r/example/s/shared', provider: 'exa', fallbackUsed: false, mutation: false, page: { url: 'https://www.reddit.com/r/example/s/shared', content: 'The list is shown in the attached infographic.', highlights: [], provider: 'exa' }, warnings: [], summary: 'Fetched.' }),
    discover: async () => ({ finalUrl: 'https://www.reddit.com/r/example/post', mediaUrls: ['https://preview.redd.it/mcu-list.jpg'] }),
    analyze: async () => ({ items: [
      { rawText: 'Captain America: Brave New World', normalizedText: 'Captain America: Brave New World', confidence: 0.98 },
      { rawText: 'Thunderbolts*', normalizedText: 'Thunderbolts*', confidence: 0.95 },
    ], unresolvedItems: [] }),
    search: async () => ({ status: 'ok', query: 'unused', provider: 'exa', fallbackUsed: false, mutation: false, results: [], warnings: [], summary: 'unused' }),
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.contentType, 'image');
  assert.deepEqual(result.items.map((item) => item.normalizedText), ['Captain America: Brave New World', 'Thunderbolts*']);
  assert.ok(result.items.every((item) => item.evidence.includes('visual-ocr')));
  assert.equal(result.mutation, false);
});

test('visual extraction asks for an upload only after fetch, discovery, and search fail to expose the list', async () => {
  const result = await extractLinkedVisualList({ url: 'https://example.com/blocked', query: 'book list', maxItems: 10 }, {
    fetchPage: async () => ({ status: 'error', url: 'https://example.com/blocked', fallbackUsed: true, mutation: false, warnings: ['blocked'], summary: 'No page.' }),
    discover: async () => ({ finalUrl: 'https://example.com/blocked', mediaUrls: [], warning: 'HTTP 403' }),
    analyze: async () => ({ items: [], unresolvedItems: [] }),
    search: async () => ({ status: 'error', query: 'book list', fallbackUsed: true, mutation: false, results: [], warnings: ['no mirror'], summary: 'No result.' }),
  });
  assert.equal(result.status, 'needs-user-upload');
  assert.match(result.summary, /upload|paste/i);
  assert.deepEqual(result.items, []);
});
