import assert from 'node:assert/strict';
import test from 'node:test';
import { interpretRoutinePendingIntent, pendingIntentAllowsSemanticInterpretation } from './gary-pending-intent-interpreter';
import type { PendingIntent } from './gary-operations-store';

const intent: PendingIntent = {
  id: 'intent', resourceId: 'resource', threadId: 'thread', kind: 'tv-season-scope',
  question: 'All seasons or the first two?', options: [
    { key: 'all', label: 'All seasons' }, { key: 'first-two', label: 'Seasons 1 and 2' },
  ], payload: {}, status: 'pending', expiresAt: '2099-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

test('semantic pending interpretation can select only a frozen option', async () => {
  const agent = { generate: async () => ({ object: { decision: 'select', optionKey: 'first-two', reason: 'Context identifies the first two.' } }) } as never;
  const result = await interpretRoutinePendingIntent('yes those first ones', intent, agent);
  assert.equal(result.decision, 'select');
  if (result.decision === 'select') assert.equal(result.optionKey, 'first-two');
});

test('semantic pending interpretation accepts novel routine kinds but rejects invented options and sensitive intents', async () => {
  const agent = { generate: async () => ({ object: { decision: 'select', optionKey: 'invented', reason: 'bad' } }) } as never;
  assert.equal((await interpretRoutinePendingIntent('whatever', intent, agent)).decision, 'unclear');
  const customRoutine = { ...intent, kind: 'tim-curry-movie-scope' };
  assert.equal(pendingIntentAllowsSemanticInterpretation(customRoutine), true);
  assert.equal((await interpretRoutinePendingIntent('yeah get all of those', customRoutine, {
    generate: async () => ({ object: { decision: 'select', optionKey: 'all', reason: 'The reply selects every item.' } }),
  } as never)).decision, 'select');
  assert.equal(pendingIntentAllowsSemanticInterpretation({ ...intent, kind: 'plex-collection-change-approval' }), false);
  assert.equal((await interpretRoutinePendingIntent('yes', { ...intent, kind: 'delete-media' }, agent)).decision, 'unsupported');
  assert.equal((await interpretRoutinePendingIntent('yes', { ...intent, kind: 'quality-upgrade-approval' }, agent)).decision, 'unsupported');
  assert.equal((await interpretRoutinePendingIntent('yes', { ...intent, kind: 'external-message-confirmation' }, agent)).decision, 'unsupported');
});

test('new identifying clues reopen title research without approving the rejected candidate', async () => {
  const agent = { generate: async () => ({ object: { decision: 'revise', optionKey: null, reason: 'A corrected title was supplied.' } }) } as never;
  assert.equal((await interpretRoutinePendingIntent("Father O’Finnegan Forgives", { ...intent, kind: 'title-clarification' }, agent)).decision, 'revise');
  assert.equal((await interpretRoutinePendingIntent('another title', intent, agent)).decision, 'unclear');
  assert.equal((await interpretRoutinePendingIntent('another title', { ...intent, kind: 'supervisor-escalation' }, agent)).decision, 'unsupported');
});
