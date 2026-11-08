import assert from 'node:assert/strict';
import test from 'node:test';
import { actionClaimGate } from './action-claim-gate';
import { serverName } from '../config/branding';

test('allows a created claim only with a created receipt and request id', () => {
  assert.equal(actionClaimGate({
    text: 'Requested Heat (1995).',
    receipts: [{ toolName: 'createMediaRequest', status: 'created', requestIdPresent: true }],
  }).allowed, true);
  assert.deepEqual(actionClaimGate({
    text: 'Requested Heat (1995).',
    receipts: [{ toolName: 'createMediaRequest', status: 'created', requestIdPresent: false }],
  }).issues, ['created-claim-without-created-receipt']);
});

test('blocks completion wording after a failed receipt', () => {
  const result = actionClaimGate({
    text: 'Done — I sent the email.',
    receipts: [{ toolName: 'sendGoogleWorkspaceEmail', status: 'service-unavailable' }],
  });
  assert.equal(result.allowed, false);
  assert.ok(result.issues.includes('sent-claim-without-sent-receipt'));
  assert.ok(result.issues.includes('failure-receipt-described-as-success'));
  assert.match(result.fallback || '', /could not confirm/);
});

test('preserves a bounded tool failure summary instead of replacing it generically', () => {
  const result = actionClaimGate({
    text: 'Done — I requested Lanterns.',
    receipts: [{
      toolName: 'createMediaRequest',
      status: 'service-unavailable',
      summary: `Lanterns (2026) was not requested because ${serverName()} returned no verifiable receipt.`,
    }],
  });
  assert.equal(result.allowed, false);
  assert.equal(result.fallback, `Lanterns (2026) was not requested because ${serverName()} returned no verifiable receipt.`);
});

test('preserves the resumable summary for a partially completed batch', () => {
  const summary = 'Paused this request batch after 0 of 2 titles because the download queue timed out. No requests were submitted. Reply “retry” to resume the same batch safely.';
  const result = actionClaimGate({
    text: 'Done — I requested both movies.',
    receipts: [{ toolName: 'createMediaRequestBatch', status: 'partially-completed', summary }],
  });
  assert.equal(result.allowed, false);
  assert.equal(result.fallback, summary);
});

test('allows a completed batch claim when every created row has a request receipt', () => {
  assert.equal(actionClaimGate({
    text: 'Requested all five movies.',
    receipts: [{ toolName: 'createMediaRequestBatch', status: 'completed', requestIdPresent: true }],
  }).allowed, true);
});

test('does not let an unrelated successful receipt validate an email claim', () => {
  const result = actionClaimGate({
    text: 'I sent the email.',
    receipts: [{ toolName: 'createMediaAvailabilityWatch', status: 'created' }],
  });
  assert.deepEqual(result.issues, ['sent-claim-without-sent-receipt']);
});

test('does not mistake user intent wording for an assistant completion claim', () => {
  assert.equal(actionClaimGate({
    text: 'You requested a concise answer, so here is the summary.',
    receipts: [],
  }).allowed, true);
});

test(`does not equate a requested title with ${serverName()} availability`, () => {
  const result = actionClaimGate({
    text: `Requested Heat. It is available in ${serverName()}.`,
    receipts: [{ toolName: 'createMediaRequest', status: 'created', requestIdPresent: true }],
  });
  assert.deepEqual(result.issues, ['available-claim-without-availability-receipt']);
});

test('does not mistake a capability description for an availability receipt', () => {
  assert.equal(actionClaimGate({
    text: `I can help you see what is available in ${serverName()} and recommend movies or shows.`,
    receipts: [],
  }).allowed, true);
  assert.equal(actionClaimGate({
    text: `I can watch an exact title and message you when it is available in ${serverName()}.`,
    receipts: [],
  }).allowed, true);
});

test('allows already-satisfied wording for exact noop receipts', () => {
  assert.equal(actionClaimGate({
    text: 'Heat is already requested.',
    receipts: [{ toolName: 'createMediaRequest', status: 'already-requested' }],
  }).allowed, true);
  assert.equal(actionClaimGate({
    text: `Heat is already available in ${serverName()}.`,
    receipts: [{ toolName: 'createMediaRequest', status: 'already-available' }],
  }).allowed, true);
});

test('allows receipt-backed Plex collection create, update, and delete claims', () => {
  assert.equal(actionClaimGate({ text: 'I created Family Adventure.', receipts: [{ toolName: 'executePlexCollectionChange', status: 'created' }] }).allowed, true);
  assert.equal(actionClaimGate({ text: 'I updated Family Adventure.', receipts: [{ toolName: 'executePlexCollectionChange', status: 'updated' }] }).allowed, true);
  assert.equal(actionClaimGate({ text: 'I deleted the Family Adventure collection.', receipts: [{ toolName: 'executePlexCollectionChange', status: 'deleted' }] }).allowed, true);
});

test('allows a Plex collection preview-created claim only from its ready receipt', () => {
  assert.equal(actionClaimGate({
    text: 'I created an immutable preview. Nothing changed in Plex.',
    receipts: [{ toolName: 'preview-plex-collection-change', status: 'ready' }],
  }).allowed, true);
  assert.equal(actionClaimGate({
    text: 'I created an immutable preview. Nothing changed in Plex.',
    receipts: [{ toolName: 'preview-plex-collection-change', status: 'denied' }],
  }).allowed, false);
});
