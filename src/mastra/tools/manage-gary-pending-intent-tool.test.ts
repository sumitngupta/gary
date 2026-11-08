import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { manageGaryPendingIntentInputSchema } from './manage-gary-pending-intent-tool';

test('pending-intent tool emits an OpenAI-compatible object-root JSON schema', () => {
  const schema = z.toJSONSchema(manageGaryPendingIntentInputSchema) as { type?: string };
  assert.equal(schema.type, 'object');
  assert.equal(manageGaryPendingIntentInputSchema.safeParse({ action: 'record' }).success, false);
  assert.equal(manageGaryPendingIntentInputSchema.safeParse({ action: 'inspect' }).success, true);
  assert.equal(manageGaryPendingIntentInputSchema.safeParse({
    action: 'inspect', kind: null, question: null, options: [], payload: {},
  }).success, true);
});

test('batch approval records still require the planner-owned path', () => {
  assert.equal(manageGaryPendingIntentInputSchema.safeParse({
    action: 'record',
    kind: 'batch-request-approval',
    question: 'Approve?',
    options: [{ key: 'approve', label: 'Approve' }],
  }).success, true);
  // Runtime ownership is enforced by the tool because the planner-created
  // pending record must be inspected before accepting or rejecting the call.
});
