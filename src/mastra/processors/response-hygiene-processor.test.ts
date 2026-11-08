import assert from 'node:assert/strict';
import test from 'node:test';
import {
  boundedActionReceiptsFromMessages,
  enforceReceiptBackedActionClaims,
  processMessages,
  processMessagesWithReceipts,
  scrubInternalMechanics,
  enforceCompactGaryResponse,
  markTruncatedGaryResponse,
} from './response-hygiene-processor';
import { serverName, serverNamePattern, serverNameTitle } from '../config/branding';

test('marks a likely truncated long response instead of silently delivering it', () => {
  const truncated = `${'MCU guidance and context. '.repeat(12)}You will not miss anything`;
  assert.match(markTruncatedGaryResponse(truncated), /cut off before it was complete/i);
  assert.equal(markTruncatedGaryResponse(`Iron Man is available in ${serverName()}.`), `Iron Man is available in ${serverName()}.`);
});

test('uses direct availability wording instead of an inferred should claim', () => {
  assert.equal(
    scrubInternalMechanics(`The Drama (2026) should be watchable in ${serverName()} library.`),
    `The Drama (2026) is already available in ${serverName()}.`,
  );
});

test(`request receipts never imply approved titles are already available in ${serverName()}`, () => {
  const result = scrubInternalMechanics(
    `Nice choice — all requested and tucked into ${serverName()}. Each request came back approved. ${serverNameTitle()} will show them when they become available.`,
  );

  assert.match(result, /All of the requests were approved/);
  assert.match(result, /when they become available/);
  assert.doesNotMatch(result, new RegExp(String.raw`tucked into ${serverNamePattern()}`, 'i'));
});

test('friend-facing media replies hide internal media product names', () => {
  const result = scrubInternalMechanics(
    'Seerr sent this to Radarr; Prowlarr found it, qBittorrent queued it, Tautulli tracks viewing, and Maintainerr curates it.',
  );
  assert.doesNotMatch(result, /Seerr|Radarr|Prowlarr|qBittorrent|Tautulli|Maintainerr/i);
  assert.match(result, new RegExp(String.raw`${serverNamePattern()}`));
});

test('compaction preserves complete lists, sources and approval questions', () => {
  const list = Array.from({ length: 9 }, (_, i) => `${i + 1}. A missing movie (${2000 + i}) — ${'A useful reason. '.repeat(20)}https://example.com/${i}`).join('\n');
  const content = `Requested titles already handled.\n\n${list}\n\nWhich edition?\nRequest these nine missing titles?`;
  assert.equal(enforceCompactGaryResponse(`Great choice!\n${content}`), content);
  assert.equal(scrubInternalMechanics(content), content);
});

test('removing a memory sentence does not leave a contraction fragment', () => {
  assert.equal(scrubInternalMechanics("I've updated your preference in my notes. The existing request remains approved."), 'The existing request remains approved.');
  assert.equal(scrubInternalMechanics('First paragraph.\n\nSecond paragraph.'), 'First paragraph.\n\nSecond paragraph.');
});

test('extracts only bounded action receipt fields from tool-result messages', () => {
  const receipts = boundedActionReceiptsFromMessages([{
    id: 'tool-message',
    role: 'assistant',
    createdAt: new Date(),
    content: {
      format: 2,
      content: '',
      parts: [{
        type: 'tool-invocation',
        toolInvocation: {
          toolCallId: 'call-1',
          toolName: 'createMediaRequest',
          args: {},
          state: 'result',
          result: {
            status: 'created',
            requestId: 42,
            privateBody: 'must not be retained',
          },
        },
      }],
    },
  }]);

  assert.deepEqual(receipts, [{
    toolName: 'createMediaRequest',
    status: 'created',
    requestIdPresent: true,
    available: false,
  }]);
  assert.equal(JSON.stringify(receipts).includes('privateBody'), false);
});

test('replaces unsupported action claims and preserves receipt-backed claims', () => {
  const fallback = enforceReceiptBackedActionClaims(
    'Done — I sent the email.',
    [{ toolName: 'sendGoogleWorkspaceEmail', status: 'service-unavailable' }],
  );
  assert.match(fallback, /could not confirm/);
  assert.doesNotMatch(fallback, /sent the email/i);

  assert.equal(enforceReceiptBackedActionClaims(
    'I sent the email.',
    [{ toolName: 'sendGoogleWorkspaceEmail', status: 'sent' }],
  ), 'I sent the email.');
});

test('response processing enforces claims against tool invocation receipts', () => {
  const messages = [{
    id: 'assistant-message',
    role: 'assistant' as const,
    createdAt: new Date(),
    content: {
      format: 2 as const,
      content: 'Done — I sent the email.',
      parts: [
        {
          type: 'tool-invocation' as const,
          toolInvocation: {
            toolCallId: 'call-1',
            toolName: 'sendGoogleWorkspaceEmail',
            args: {},
            state: 'result' as const,
            result: { status: 'service-unavailable' },
          },
        },
        {
          type: 'text' as const,
          text: 'Done — I sent the email.',
        },
      ],
    },
  }];

  const [processed] = processMessages(messages);
  assert.match(String(processed?.content.content), /could not confirm/);
  assert.match(
    processed?.content.parts.find((part) => part.type === 'text')?.text || '',
    /could not confirm/,
  );
});

test('preserves truthful claims when a receipt came from an earlier agent step', () => {
  const messages = [{
    id: 'assistant-message', role: 'assistant' as const, createdAt: new Date(),
    content: { format: 2 as const, content: 'Done — I created the availability watch.', parts: [{ type: 'text' as const, text: 'Done — I created the availability watch.' }] },
  }];
  const receipts = [{ toolName: 'createMediaAvailabilityWatch', status: 'created' }];
  const [processed] = processMessagesWithReceipts(messages, receipts);
  assert.equal(processed?.content.content, 'Done — I created the availability watch.');
});

test('preserves a receipt-backed supervisor escalation from an earlier step', () => {
  const text = 'I sent the issue to Alice.';
  assert.equal(enforceReceiptBackedActionClaims(
    text,
    [{ toolName: 'escalateToGarySupervisor', status: 'sent' }],
  ), text);
});
