import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendOperationEvent, attachPendingIntentProposalMessage, bindShortAnswer, checkpointOperationBatch, createOperationBatch,
  createPendingIntent, dispositionGaryEscalation, enqueueGaryEscalation, getOperationBatch, getOperationTimeline, listGaryEscalationQueue,
  getPendingIntent, invalidatePendingIntentForMessage, pendingIntentExecutionInstruction, recordGaryEscalationDelivery, recordWhatsAppEvent, resetGaryOperationsStoreForTests, resolvePendingIntent, resolvePendingIntentForResource,
  type PendingIntent,
} from './gary-operations-store';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'gary-ops-')); process.env.GARY_DATA_DIR = directory; resetGaryOperationsStoreForTests(); });
afterEach(async () => { resetGaryOperationsStoreForTests(); delete process.env.GARY_DATA_DIR; await rm(directory, { recursive: true, force: true }); });

describe('Gary durable operations', () => {
  it('binds supervisor consent to the requesting user and frozen summary', async () => {
    await createPendingIntent({ resourceId: 'bob', threadId: 'audio-chat', kind: 'supervisor-escalation', question: 'Pass this to Alice?', options: [
      { key: 'yes', label: 'Pass my audio request to Alice', aliases: ['yes'], value: { summary: 'Please add music and audiobooks', reason: 'unsupported capability' } },
    ] });
    assert.equal((await resolvePendingIntentForResource('someone-else', 'yes')).status, 'none');
    const resolution = await resolvePendingIntentForResource('bob', 'yes');
    assert.match(pendingIntentExecutionInstruction(resolution) || '', /escalateToGarySupervisor now/);
    assert.match(pendingIntentExecutionInstruction(resolution) || '', /"userConsented":true/);
    assert.match(pendingIntentExecutionInstruction(resolution) || '', /music and audiobooks/);
    assert.equal((await resolvePendingIntentForResource('bob', 'yes')).status, 'none');
  });
  it('binds short answers only to one explicit pending proposal', async () => {
    const intent = await createPendingIntent({ resourceId: 'erin', threadId: 'chat', kind: 'choice', question: 'Which should I request?', options: [
      { key: 'A', label: 'Heat', aliases: ['first'] }, { key: 'B', label: 'Thief', aliases: ['second'] },
    ] });
    assert.deepEqual(bindShortAnswer('B', intent), { status: 'resolved', option: { key: 'B', label: 'Thief', aliases: ['second'] } });
    assert.equal(bindShortAnswer('yes', intent).status, 'ambiguous');
    assert.equal(bindShortAnswer('yes please', intent).status, 'ambiguous');
    assert.equal(bindShortAnswer('both', intent).status, 'resolved-many');
    assert.equal((await resolvePendingIntent('chat', 'the rest')).status, 'resolved-many');
    assert.equal(await getPendingIntent('chat'), undefined);
  });

  it('binds qualified routine approvals but rejects contradictory consent', () => {
    const intent: PendingIntent = {
      id: 'batch-intent', resourceId: 'alice', threadId: 'chat', kind: 'batch-request-approval',
      question: 'Request the exact batch?', options: [{ key: 'approve', label: 'Approve 14 exact requests', aliases: ['yes', 'approve'] }],
      payload: {}, status: 'pending', expiresAt: '2099-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    assert.equal(bindShortAnswer('Yes, but start with that one first', intent).status, 'resolved');
    assert.equal(bindShortAnswer('That works, but use the highest quality', intent).status, 'resolved');
    assert.equal(bindShortAnswer("I'm good with those; start whenever", intent).status, 'resolved');
    assert.equal(bindShortAnswer("Yes, but don't request them", intent).status, 'ambiguous');
  });

  it('asks for a natural clarification without exposing option keys or magic wording', async () => {
    const intent = await createPendingIntent({ resourceId: 'alice', threadId: 'natural-clarification', kind: 'title-choice', question: 'Which version?', options: [
      { key: 'movie-2025', label: 'the 2025 movie' }, { key: 'series-2023', label: 'the 2023 series' },
    ] });
    const resolution = bindShortAnswer('sure', intent);
    assert.equal(resolution.status, 'ambiguous');
    if (resolution.status !== 'ambiguous') return;
    assert.match(resolution.clarification, /answer naturally/i);
    assert.match(resolution.clarification, /the 2025 movie or the 2023 series/i);
    assert.doesNotMatch(resolution.clarification, /movie-2025|series-2023|reply with/i);

    const sensitive = await createPendingIntent({ resourceId: 'alice', threadId: 'sensitive-clarification', kind: 'delete-media', question: 'Delete this movie?', options: [{ key: 'delete-exact', label: 'delete the exact movie' }] });
    const sensitiveResolution = bindShortAnswer('maybe?', sensitive);
    assert.equal(sensitiveResolution.status, 'ambiguous');
    if (sensitiveResolution.status === 'ambiguous') {
      assert.match(sensitiveResolution.clarification, /explicit text reply/i);
      assert.doesNotMatch(sensitiveResolution.clarification, /answer naturally/i);
    }
  });

  it('treats a natural numbered scope selection as the one required authorization', () => {
    const intent: PendingIntent = {
      id: 'scope-intent', resourceId: 'alice', threadId: 'chat', kind: 'media-batch-scope',
      question: 'All 9 or the essential 5?', options: [
        { key: 'all-nine', label: 'All 9 Tim Curry movies', aliases: ['all', 'all of them'], value: { intendedAction: 'request', titles: Array.from({ length: 9 }, (_, index) => ({ title: `Movie ${index + 1}`, mediaType: 'movie' })) } },
        { key: 'essential-five', label: 'Essential 5 Tim Curry movies', aliases: ['essential five'], value: { intendedAction: 'request', titles: Array.from({ length: 5 }, (_, index) => ({ title: `Movie ${index + 1}`, mediaType: 'movie' })) } },
      ], payload: {}, status: 'pending', expiresAt: '2099-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    assert.equal((bindShortAnswer('all 9 please', intent) as { option?: { key?: string } }).option?.key, 'all-nine');
    assert.equal((bindShortAnswer('the essential 5', intent) as { option?: { key?: string } }).option?.key, 'essential-five');
    assert.equal((bindShortAnswer('Can you please go ahead and get all of them for me?', intent) as { option?: { key?: string } }).option?.key, 'all-nine');
    assert.equal(bindShortAnswer("Please don't get all of them", intent).status, 'ambiguous');
  });

  it('turns an exact media scope selection into an authorized plan-and-execute instruction', async () => {
    await createPendingIntent({
      resourceId: 'alice', threadId: 'scope-chat', kind: 'tim-curry-movie-scope', question: 'All 9 or essential 5?',
      options: [
        { key: 'all-9', label: 'All 9 movies', aliases: ['all of them'], value: { intendedAction: 'request', titles: [{ title: 'Movie A', mediaType: 'movie' }, { title: 'Movie B', mediaType: 'movie' }] } },
        { key: 'essential-5', label: 'Essential 5', value: { intendedAction: 'request', titles: [{ title: 'Movie A', mediaType: 'movie' }, { title: 'Movie C', mediaType: 'movie' }] } },
      ], payload: { requester: 'admin' },
    });
    const resolution = await resolvePendingIntent('scope-chat', 'Please get all of them');
    assert.equal(resolution.status, 'resolved');
    const instruction = pendingIntentExecutionInstruction(resolution) || '';
    assert.match(instruction, /planMediaRequestBatch now/);
    assert.match(instruction, /"authorization":"explicit-request"/);
    assert.match(instruction, /immediately call createMediaRequestBatch/);
    assert.match(instruction, /do not ask for approval again/i);
  });

  it('binds natural TV season wording to the exact frozen scope', () => {
    const intent: PendingIntent = {
      id: 'season-intent', resourceId: 'alice', threadId: 'chat', kind: 'tv-season-scope',
      question: 'All seasons or seasons 1 and 2?', options: [
        { key: 'all', label: 'All 8 seasons', value: { seasons: 'all' } },
        { key: 'seasons-1-2', label: 'Seasons 1 and 2', aliases: ['1 and 2'], value: { seasons: [1, 2] } },
      ], payload: {}, status: 'pending', expiresAt: '2099-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    assert.equal(bindShortAnswer('season 1 and 2 please', intent).status, 'resolved');
    assert.equal(bindShortAnswer("Let's start with season 1 and season 2", intent).status, 'resolved');
    assert.equal(bindShortAnswer('Yes gets season one and two', intent).status, 'resolved');
    assert.equal(bindShortAnswer('Yes one and two', intent).status, 'resolved');
    assert.equal(bindShortAnswer('1 & 2', intent).status, 'resolved');
    assert.equal(bindShortAnswer('all seasons', intent).status, 'resolved');
    assert.equal(bindShortAnswer('seasons 2 and 3', intent).status, 'ambiguous');
  });

  it('turns a bound TV season choice into an immediate exact request instruction', async () => {
    await createPendingIntent({
      resourceId: 'alice', threadId: 'season-chat', kind: 'tv-season-scope', question: 'All seasons or seasons 1 and 2?',
      options: [
        { key: 'all', label: 'All 8 seasons', value: { title: 'Show Alpha', mediaType: 'tv', tmdbId: 1399, seasons: 'all' } },
        { key: 'seasons-1-2', label: 'Seasons 1 and 2', value: { title: 'Show Alpha', mediaType: 'tv', tmdbId: 1399, seasons: [1, 2] } },
      ],
    });
    const resolution = await resolvePendingIntent('season-chat', 'season 1 and 2 please');
    assert.equal(resolution.status, 'resolved');
    assert.match(pendingIntentExecutionInstruction(resolution) || '', /call createMediaRequest now/i);
    assert.match(pendingIntentExecutionInstruction(resolution) || '', /"seasons":\[1,2\]/);
    assert.match(pendingIntentExecutionInstruction(resolution) || '', /do not ask for confirmation/i);
  });

  it('supersedes older questions instead of allowing ambiguous active state', async () => {
    await createPendingIntent({ resourceId: 'erin', threadId: 'chat', kind: 'a', question: 'Old?', options: [{ key: 'yes', label: 'Old' }] });
    const latest = await createPendingIntent({ resourceId: 'erin', threadId: 'chat', kind: 'b', question: 'New?', options: [{ key: 'yes', label: 'New' }] });
    assert.equal((await getPendingIntent('chat'))?.id, latest.id);
  });

  it('binds quoted replies and reactions only after the actual proposal delivery is attached', async () => {
    const intent = await createPendingIntent({ resourceId: 'erin', threadId: 'chat', kind: 'binary', question: 'Should I request Movie Alpha?', options: [{ key: 'yes', label: 'Request Movie Alpha' }] });
    assert.equal((await resolvePendingIntent('chat', 'yes', 'wrong')).status, 'target-mismatch');
    assert.equal(await attachPendingIntentProposalMessage('chat', 'proposal-1', 'Should I request Movie Alpha?'), true);
    assert.equal((await resolvePendingIntent('chat', '👍', 'wrong')).status, 'target-mismatch');
    assert.equal((await resolvePendingIntent('chat', '👍', 'proposal-1')).status, 'resolved');
    assert.deepEqual((await getOperationTimeline(intent.id)).map((event) => event.phase), ['proposal-recorded', 'proposal-delivered', 'proposal-approved']);
  });

  it('invalidates a deleted proposal so late approval cannot revive it', async () => {
    await createPendingIntent({ resourceId: 'dana', threadId: 'chat', kind: 'binary', question: 'Should I request Movie Beta?', options: [{ key: 'yes', label: 'Request Movie Beta' }] });
    await attachPendingIntentProposalMessage('chat', 'proposal-2', 'Should I request Movie Beta?');
    assert.equal(await invalidatePendingIntentForMessage('chat', 'proposal-2'), true);
    assert.equal((await resolvePendingIntent('chat', 'yes', 'proposal-2')).status, 'none');
  });

  it('treats reactions to sensitive proposals as acknowledgements instead of approval', async () => {
    const intent = await createPendingIntent({ resourceId: 'erin', threadId: 'sensitive-chat', kind: 'delete-media', question: 'Delete Movie Gamma?', options: [{ key: 'yes', label: 'Delete Movie Gamma' }] });
    await attachPendingIntentProposalMessage('sensitive-chat', 'sensitive-proposal', 'Delete Movie Gamma?');
    const result = await resolvePendingIntent('sensitive-chat', '👍', 'sensitive-proposal', 'reaction');
    assert.equal(result.status, 'acknowledgement-only');
    assert.equal((await getPendingIntent('sensitive-chat'))?.id, intent.id);
    assert.deepEqual((await getOperationTimeline(intent.id)).map((event) => event.phase), ['proposal-recorded', 'proposal-delivered', 'reaction-acknowledged-sensitive']);

    const collection = await createPendingIntent({ resourceId: 'erin', threadId: 'collection-chat', kind: 'plex-collection-change-approval', question: 'Apply this collection preview?', options: [{ key: 'yes', label: 'Apply exact preview' }] });
    await attachPendingIntentProposalMessage('collection-chat', 'collection-proposal', 'Apply this collection preview?');
    assert.equal((await resolvePendingIntent('collection-chat', '👍', 'collection-proposal', 'reaction')).status, 'acknowledgement-only');
    assert.equal((await getPendingIntent('collection-chat'))?.id, collection.id);
  });

  it('handles negative, informational, missing, media, and removal reactions without guessed approval', async () => {
    await createPendingIntent({ resourceId: 'dana', threadId: 'negative-chat', kind: 'media-watch', question: 'Watch for Show Delta?', options: [{ key: 'yes', label: 'Watch for Show Delta' }] });
    await attachPendingIntentProposalMessage('negative-chat', 'negative-proposal', 'Watch for Show Delta?');
    assert.equal((await resolvePendingIntent('negative-chat', '👎', 'negative-proposal', 'reaction')).status, 'declined');

    await createPendingIntent({ resourceId: 'dana', threadId: 'info-chat', kind: 'media-choice', question: 'A or B?', options: [{ key: 'A', label: 'Movie A' }, { key: 'B', label: 'Movie B' }] });
    await attachPendingIntentProposalMessage('info-chat', 'choice-proposal', 'A or B?');
    assert.equal((await resolvePendingIntent('info-chat', '👍', 'informational-message', 'reaction')).status, 'target-mismatch');
    assert.equal((await resolvePendingIntent('info-chat', '👍', 'media-message', 'reaction')).status, 'target-mismatch');
    assert.equal((await resolvePendingIntent('missing-thread', '👍', 'missing-message', 'reaction')).status, 'none');
    assert.deepEqual(await recordWhatsAppEvent({ eventId: 'reaction-add-info', threadId: 'info-chat', targetMessageId: 'informational-message', eventType: 'reaction-add', timestamp: 40 }), { accepted: true });
    assert.deepEqual(await recordWhatsAppEvent({ eventId: 'reaction-remove-info', threadId: 'info-chat', targetMessageId: 'informational-message', eventType: 'reaction-remove', timestamp: 41 }), { accepted: true });
    assert.ok(await getPendingIntent('info-chat'));
  });

  it('checkpoints a resumable batch and preserves its correlation timeline', async () => {
    const batch = await createOperationBatch({ resourceId: 'dana', threadId: 'chat-2', requests: ['a', 'b', 'c'] });
    await checkpointOperationBatch(batch.id, { status: 'paused-health', nextIndex: 1, results: [{ status: 'created' }], failed: 0 });
    await appendOperationEvent({ correlationId: batch.correlationId, batchId: batch.id, phase: 'health-paused' });
    assert.deepEqual({ ...(await getOperationBatch(batch.id)), requests: undefined, results: undefined }, { id: batch.id, resourceId: 'dana', threadId: 'chat-2', correlationId: batch.correlationId, status: 'paused-health', total: 3, completed: 1, failed: 0, nextIndex: 1, requests: undefined, results: undefined });
    assert.deepEqual((await getOperationTimeline(batch.correlationId)).map((event) => event.phase), ['batch-planned', 'health-paused']);
  });

  it('durably approves only the exact batch bound to a pending approval', async () => {
    const batch = await createOperationBatch({ resourceId: 'alice', threadId: 'batch-chat', requests: ['a'] });
    await checkpointOperationBatch(batch.id, { status: 'ready-for-approval', nextIndex: 0, results: [], failed: 0 });
    await createPendingIntent({
      resourceId: 'alice', threadId: 'batch-chat', kind: 'batch-request-approval', question: 'Request this batch?',
      options: [{ key: 'yes', label: 'Request batch', value: { batchId: batch.id } }], correlationId: batch.correlationId,
    });
    const resolution = await resolvePendingIntent('batch-chat', 'yes');
    assert.equal(resolution.status, 'resolved');
    assert.match(pendingIntentExecutionInstruction(resolution) || '', new RegExp(batch.id));
    assert.match(pendingIntentExecutionInstruction(resolution) || '', /do not call planMediaRequestBatch/i);
    assert.equal((await getOperationBatch(batch.id))?.status, 'approved');
    assert.deepEqual((await getOperationTimeline(batch.correlationId)).map((event) => event.phase),
      ['batch-planned', 'proposal-recorded', 'proposal-approved', 'batch-approved']);
  });

  it('binds collection-pack approval to its single-use execution plan', async () => {
    await createPendingIntent({
      resourceId: 'whatsapp:15550001', threadId: 'pack-chat', kind: 'collection-pack-import-approval',
      question: 'Import all collection titles?',
      options: [{ key: 'yes', label: 'Import all collection titles', value: { collectionPackPlanId: 'plan-123' } }],
    });
    const resolution = await resolvePendingIntent('pack-chat', 'yes');
    assert.equal(resolution.status, 'resolved');
    assert.match(pendingIntentExecutionInstruction(resolution) || '', /executeCollectionPackRepair now with planId plan-123/);
    assert.match(pendingIntentExecutionInstruction(resolution) || '', /Do not rebuild the plan/);
  });

  it('binds Plex collection approval to the exact frozen preview', async () => {
    await createPendingIntent({ resourceId: 'whatsapp:15550001', threadId: 'plex-chat', kind: 'plex-collection-change-approval', question: 'Apply?', options: [{ key: 'yes', label: 'Apply exact preview', value: { plexCollectionPreviewId: 'preview-123' } }] });
    const resolution = await resolvePendingIntent('plex-chat', 'yes');
    assert.match(pendingIntentExecutionInstruction(resolution) || '', /executePlexCollectionChange now with previewId preview-123/);
    assert.match(pendingIntentExecutionInstruction(resolution) || '', /Do not rebuild or alter the preview/);
  });

  it('binds list publish approval to the exact publish preview', async () => {
    await createPendingIntent({ resourceId: 'whatsapp:15550001', threadId: 'shelf-chat', kind: 'gary-list-publish-approval', question: 'Publish?', options: [{ key: 'yes', label: 'Publish shelf', value: { garyListPublishPreviewId: 'gary_shelf_preview_1' } }] });
    const resolution = await resolvePendingIntent('shelf-chat', 'yes');
    assert.equal(
      pendingIntentExecutionInstruction(resolution),
      'Deterministic approved list publish: call manageGaryLists now with {"action":"confirm-publish","previewId":"gary_shelf_preview_1"}. Do not change the shelf title, rebuild the preview, or ask for approval again.',
    );
  });

  it('resolves a Mastra-thread batch from the same WhatsApp resource identity', async () => {
    const batch = await createOperationBatch({ resourceId: 'whatsapp:15550100001', threadId: 'mastra-erin', requests: [] });
    await checkpointOperationBatch(batch.id, { status: 'ready-for-approval', nextIndex: 0, results: [], failed: 0 });
    await createPendingIntent({
      resourceId: 'whatsapp:15550100001', threadId: 'mastra-erin', kind: 'batch-request-approval',
      question: 'Request all seven titles?',
      options: [{ key: 'approve', label: 'Approve all seven', aliases: ['approve'], value: { batchId: batch.id } }],
    });
    const resolution = await resolvePendingIntentForResource('whatsapp:15550100001', 'Approve');
    assert.equal(resolution.status, 'resolved');
    assert.equal((await getOperationBatch(batch.id))?.status, 'approved');
  });

  it('binds natural batch approval wording to the approval option without selecting revisions', async () => {
    const options = [
      { key: 'approve', label: 'Approve the 5 movies', aliases: ['five movies', 'movies'] },
      { key: 'keep-shows', label: 'Keep the two shows too', aliases: ['keep shows'] },
      { key: 'revise', label: 'Revise the batch', aliases: ['change'] },
    ];
    const intent = await createPendingIntent({ resourceId: 'alice', threadId: 'natural-batch', kind: 'batch-request-approval', question: 'Approve the five movies?', options });
    assert.equal(bindShortAnswer('I approve the five movies', intent).status, 'resolved');
    assert.equal((bindShortAnswer('request them', intent) as { option?: { key?: string } }).option?.key, 'approve');
  });

  it('creates an actionable escalation correlated to the originating operation', async () => {
    const id = await enqueueGaryEscalation({ resourceId: 'erin', threadId: 'chat', correlationId: 'corr', reason: 'indexers unavailable', error: { code: 503 } });
    assert.ok(id);
    assert.equal((await getOperationTimeline('corr'))[0]?.phase, 'escalated');
    assert.equal((await listGaryEscalationQueue({ status: 'open' }))[0]?.threadId, 'chat');
    assert.equal(await recordGaryEscalationDelivery(id, { status: 'sent', messageId: 'wamid.owner-receipt' }), true);
    const delivered = (await listGaryEscalationQueue({ status: 'open' }))[0];
    assert.deepEqual((delivered?.error as { delivery?: unknown }).delivery, { status: 'sent', messageId: 'wamid.owner-receipt', at: (delivered?.error as { delivery: { at: string } }).delivery.at });
    assert.deepEqual((await getOperationTimeline('corr')).map((event) => event.phase), ['escalated', 'escalation-delivery-sent']);
    assert.equal(await dispositionGaryEscalation(id, { status: 'resolved', disposition: 'Owner handled it.' }), true);
    assert.equal((await listGaryEscalationQueue({ status: 'resolved' }))[0]?.disposition, 'Owner handled it.');
  });

  it('deduplicates and rejects stale WhatsApp mutations', async () => {
    assert.deepEqual(await recordWhatsAppEvent({ eventId: 'edit-new', threadId: 'chat', targetMessageId: 'm1', eventType: 'edit', timestamp: 20 }), { accepted: true });
    assert.deepEqual(await recordWhatsAppEvent({ eventId: 'edit-new', threadId: 'chat', targetMessageId: 'm1', eventType: 'edit', timestamp: 20 }), { accepted: false, reason: 'duplicate' });
    assert.deepEqual(await recordWhatsAppEvent({ eventId: 'edit-old', threadId: 'chat', targetMessageId: 'm1', eventType: 'delete', timestamp: 10 }), { accepted: false, reason: 'stale' });
    assert.deepEqual(await recordWhatsAppEvent({ eventId: 'edit-tied', threadId: 'chat', targetMessageId: 'm1', eventType: 'edit', timestamp: 20 }), { accepted: false, reason: 'stale' });
    assert.deepEqual(await recordWhatsAppEvent({ eventId: 'same-target-other-thread', threadId: 'other-chat', targetMessageId: 'm1', eventType: 'reaction-add', timestamp: 10 }), { accepted: true });
    assert.deepEqual(await recordWhatsAppEvent({ eventId: 'delete-new', threadId: 'chat', targetMessageId: 'm1', eventType: 'delete', timestamp: 30 }), { accepted: true });
    assert.deepEqual(await recordWhatsAppEvent({ eventId: 'reaction-after-delete', threadId: 'chat', targetMessageId: 'm1', eventType: 'reaction-add', timestamp: 40 }), { accepted: false, reason: 'target-deleted' });
  });
});

it('binds supervisor consent to the stored summary and carries execution forward', async () => {
  await createPendingIntent({ resourceId: 'fixture', threadId: 'escalation-chat', kind: 'supervisor-escalation', question: 'Pass the music capability request to Alice?', options: [{ key: 'yes', label: 'Yes', value: { summary: 'Please support music requests.', reason: 'Music acquisition is unsupported.' } }] });
  const resolution = await resolvePendingIntent('escalation-chat', 'yes');
  assert.equal(resolution.status, 'resolved');
  assert.match(pendingIntentExecutionInstruction(resolution) || '', /call escalateToGarySupervisor now/);
  assert.match(pendingIntentExecutionInstruction(resolution) || '', /Music acquisition is unsupported/);
  assert.equal(pendingIntentExecutionInstruction(await resolvePendingIntent('escalation-chat', 'yes')), undefined);
});
