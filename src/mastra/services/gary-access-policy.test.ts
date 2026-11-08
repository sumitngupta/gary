import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  claimGaryInboundEvent,
  claimGaryWhatsAppEnrollment,
  createGaryWhatsAppEnrollment,
  deleteGaryPolicyEvents,
  enforceGaryAccessPolicy,
  isGaryWhatsAppActorAuthorized,
  listGaryPolicyEvents,
  resetGaryPolicyClientForTests,
} from './gary-access-policy';

async function isolatedPolicy(run: () => Promise<void>) {
  const path = await mkdtemp(join(tmpdir(), 'gary-policy-'));
  const prior = { ...process.env };
  process.env.GARY_DATA_DIR = path;
  resetGaryPolicyClientForTests();
  try { await run(); } finally {
    process.env = prior;
    resetGaryPolicyClientForTests();
    await rm(path, { recursive: true, force: true });
  }
}

test('WhatsApp fails closed until explicitly enabled and allowlisted', async () => isolatedPolicy(async () => {
  const disabled = await enforceGaryAccessPolicy({ toolName: 'checkPlexAvailability', input: {}, resourceId: 'whatsapp:+15550001' });
  assert.equal(disabled.allowed, false);
  process.env.GARY_WHATSAPP_ENABLED = 'true';
  const unknown = await enforceGaryAccessPolicy({ toolName: 'checkPlexAvailability', input: {}, resourceId: 'whatsapp:+15550001' });
  assert.equal(unknown.allowed, false);
  process.env.GARY_WHATSAPP_ALLOWED_USERS = '+15550001';
  const allowed = await enforceGaryAccessPolicy({ toolName: 'checkPlexAvailability', input: {}, resourceId: 'whatsapp:+15550001' });
  assert.equal(allowed.allowed, true);
}));

test('WhatsApp normalizes Cloud API numeric user ids against E.164 allowlist entries', async () => isolatedPolicy(async () => {
  process.env.GARY_WHATSAPP_ENABLED = 'true';
  process.env.GARY_WHATSAPP_ALLOWED_USERS = '+15550001';
  const allowed = await enforceGaryAccessPolicy({
    toolName: 'checkPlexAvailability',
    input: {},
    resourceId: 'whatsapp:15550001',
  });
  assert.equal(allowed.allowed, true);
}));

test('one-time enrollment securely binds the sender and cannot be replayed', async () => isolatedPolicy(async () => {
  process.env.GARY_WHATSAPP_ENABLED = 'true';
  const enrollment = await createGaryWhatsAppEnrollment({ name: 'Friend', email: 'friend@example.com' });
  assert.equal(await isGaryWhatsAppActorAuthorized('+15550001'), false);

  const claimed = await claimGaryWhatsAppEnrollment('+15550001', `Hi Gary — enroll ${enrollment.code}`);
  assert.deepEqual(claimed, { accepted: true, reasonCode: 'enrolled', preferredName: 'Friend' });
  assert.equal(await isGaryWhatsAppActorAuthorized('15550001'), true);
  assert.equal((await enforceGaryAccessPolicy({
    toolName: 'checkPlexAvailability',
    input: {},
    resourceId: 'whatsapp:+15550001',
  })).allowed, true);

  const replay = await claimGaryWhatsAppEnrollment('+15550002', enrollment.code);
  assert.equal(replay.accepted, false);
  assert.equal(await isGaryWhatsAppActorAuthorized('+15550002'), false);
}));

test('enrollment rejects messages without a valid code', async () => isolatedPolicy(async () => {
  assert.equal((await claimGaryWhatsAppEnrollment('+15550001', 'Hi Gary, this is Friend')).accepted, false);
  assert.equal((await claimGaryWhatsAppEnrollment('+15550001', 'GARY-000000000000')).accepted, false);
}));

test('WhatsApp mutations require kill-switch enablement and a trusted event id', async () => isolatedPolicy(async () => {
  process.env.GARY_WHATSAPP_ENABLED = 'true';
  process.env.GARY_WHATSAPP_ALLOWED_USERS = '+15550001';
  let result = await enforceGaryAccessPolicy({ toolName: 'createMediaRequest', input: { title: 'Heat' }, resourceId: 'whatsapp:+15550001' });
  assert.match(result.reason, /mutations are disabled/);
  process.env.GARY_WHATSAPP_MUTATIONS_ENABLED = 'true';
  result = await enforceGaryAccessPolicy({ toolName: 'createMediaRequest', input: { title: 'Heat' }, resourceId: 'whatsapp:+15550001' });
  assert.match(result.reason, /event id/);
}));

test('batch media requests use the same mutation and quota policy as single requests', async () => isolatedPolicy(async () => {
  process.env.GARY_WHATSAPP_ENABLED = 'true';
  process.env.GARY_WHATSAPP_ALLOWED_USERS = '+15550001';
  const result = await enforceGaryAccessPolicy({ toolName: 'createMediaRequestBatch', input: { requests: [{ title: 'Heat' }] }, resourceId: 'whatsapp:+15550001', eventId: 'batch' });
  assert.equal(result.allowed, false);
  assert.equal(result.mutation, true);
  assert.equal(result.category, 'request');
}));

test('Plex library refresh uses the guarded repair mutation policy', async () => isolatedPolicy(async () => {
  process.env.GARY_WHATSAPP_ENABLED = 'true';
  process.env.GARY_WHATSAPP_MUTATIONS_ENABLED = 'true';
  process.env.GARY_WHATSAPP_ALLOWED_USERS = '+15550001';
  const result = await enforceGaryAccessPolicy({
    toolName: 'refreshPlexLibrary',
    input: { mediaType: 'tv' },
    resourceId: 'whatsapp:+15550001',
    eventId: 'wamid.refresh',
  });
  assert.equal(result.allowed, true);
  assert.equal(result.mutation, true);
  assert.equal(result.category, 'repair');
}));

test('collection-pack execution uses the guarded repair mutation policy', async () => isolatedPolicy(async () => {
  process.env.GARY_WHATSAPP_ENABLED = 'true';
  process.env.GARY_WHATSAPP_MUTATIONS_ENABLED = 'true';
  process.env.GARY_WHATSAPP_ALLOWED_USERS = '+15550001';
  const result = await enforceGaryAccessPolicy({
    toolName: 'executeCollectionPackRepair', input: { planId: 'plan' },
    resourceId: 'whatsapp:+15550001', eventId: 'wamid.pack',
  });
  assert.equal(result.allowed, true);
  assert.equal(result.mutation, true);
  assert.equal(result.category, 'repair');
}));

test('Plex collection execution uses the guarded repair mutation policy for its creator', async () => isolatedPolicy(async () => {
  process.env.GARY_WHATSAPP_ENABLED = 'true';
  process.env.GARY_WHATSAPP_MUTATIONS_ENABLED = 'true';
  process.env.GARY_WHATSAPP_ALLOWED_USERS = '+15550001';
  const result = await enforceGaryAccessPolicy({ toolName: 'executePlexCollectionChange', input: { previewId: 'preview' }, resourceId: 'whatsapp:+15550001', eventId: 'wamid.collection' });
  assert.equal(result.allowed, true); assert.equal(result.mutation, true); assert.equal(result.category, 'repair');
}));

test('WhatsApp replay protection blocks the same event operation', async () => isolatedPolicy(async () => {
  process.env.GARY_WHATSAPP_ENABLED = 'true';
  process.env.GARY_WHATSAPP_MUTATIONS_ENABLED = 'true';
  process.env.GARY_WHATSAPP_ALLOWED_USERS = '+15550001';
  const call = { toolName: 'createMediaRequest', input: { title: 'Heat' }, resourceId: 'whatsapp:+15550001', eventId: 'wamid.123' };
  assert.equal((await enforceGaryAccessPolicy(call)).allowed, true);
  const duplicate = await enforceGaryAccessPolicy(call);
  assert.equal(duplicate.allowed, false);
  assert.match(duplicate.reason, /Duplicate/);
}));

test('WhatsApp daily mutation quotas are deterministic per category and actor', async () => isolatedPolicy(async () => {
  process.env.GARY_WHATSAPP_ENABLED = 'true';
  process.env.GARY_WHATSAPP_MUTATIONS_ENABLED = 'true';
  process.env.GARY_WHATSAPP_ALLOWED_USERS = '+15550001';
  process.env.GARY_WHATSAPP_DAILY_MUTATION_LIMIT = '1';
  assert.equal((await enforceGaryAccessPolicy({ toolName: 'createMediaRequest', input: { title: 'Heat' }, resourceId: 'whatsapp:+15550001', eventId: 'one' })).allowed, true);
  const limited = await enforceGaryAccessPolicy({ toolName: 'createMediaRequest', input: { title: 'Arrival' }, resourceId: 'whatsapp:+15550001', eventId: 'two' });
  assert.equal(limited.allowed, false);
  assert.match(limited.reason, /quota/);
}));

test('personal list edits have their own quota and do not spend the profile budget', async () => isolatedPolicy(async () => {
  process.env.GARY_WHATSAPP_ENABLED = 'true';
  process.env.GARY_WHATSAPP_MUTATIONS_ENABLED = 'true';
  process.env.GARY_WHATSAPP_ALLOWED_USERS = '+15550001';
  process.env.GARY_WHATSAPP_DAILY_MUTATION_LIMIT = '1';
  const profile = await enforceGaryAccessPolicy({ toolName: 'manageGaryProfile', input: { action: 'update' }, resourceId: 'whatsapp:+15550001', eventId: 'profile' });
  assert.equal(profile.allowed, true);
  for (const eventId of ['list-1', 'list-2', 'list-3']) {
    const list = await enforceGaryAccessPolicy({ toolName: 'manageGaryLists', input: { action: 'add', items: [{ title: eventId }] }, resourceId: 'whatsapp:+15550001', eventId });
    assert.equal(list.allowed, true, eventId);
  }
  process.env.GARY_WHATSAPP_DAILY_LIST_LIMIT = '3';
  const limited = await enforceGaryAccessPolicy({ toolName: 'manageGaryLists', input: { action: 'add', items: [{ title: 'four' }] }, resourceId: 'whatsapp:+15550001', eventId: 'list-4' });
  assert.equal(limited.reasonCode, 'daily_mutation_quota_reached');
}));

test('existing Telegram behavior remains allowed', async () => isolatedPolicy(async () => {
  const result = await enforceGaryAccessPolicy({ toolName: 'createMediaRequest', input: { title: 'Heat' }, resourceId: 'telegram:123' });
  assert.equal(result.allowed, true);
}));

test('scheduled radar denies mutations and private history outside its exact delivery contract', async () => isolatedPolicy(async () => {
  for (const toolName of ['createMediaRequest', 'createMediaAvailabilityWatch', 'manageGaryProfile', 'inspectGaryRequestHistory', 'manageGaryLists']) {
    const input = toolName === 'manageGaryProfile' ? { action: 'update' } : toolName === 'manageGaryLists' ? { action: 'overview' } : {};
    const result = await enforceGaryAccessPolicy({ toolName, input, resourceId: 'whatsapp:15550001', threadId: 'gary-radar:radar_test' });
    assert.equal(result.allowed, false);
    assert.equal(result.reasonCode, 'radar_mutation_denied');
  }
  const delivery = await enforceGaryAccessPolicy({ toolName: 'recordMediaRadarDelivery', input: {}, resourceId: 'internal:radar', threadId: 'gary-radar:radar_test' });
  assert.equal(delivery.allowed, true);
}));

test('personal list changes count as mutations while viewing a list does not', async () => isolatedPolicy(async () => {
  const mutations = [];
  for (const action of ['overview', 'show', 'add', 'remove', 'rename', 'delete-list', 'publish', 'confirm-publish', 'unpublish']) {
    const result = await enforceGaryAccessPolicy({ toolName: 'manageGaryLists', input: { action }, resourceId: 'telegram:123' });
    assert.equal(result.allowed, true);
    mutations.push([action, result.mutation]);
  }
  assert.deepEqual(mutations, [
    ['overview', false], ['show', false], ['add', true], ['remove', true], ['rename', true], ['delete-list', true],
    ['publish', true], ['confirm-publish', true], ['unpublish', true],
  ]);
}));

test('privacy deletion removes only the selected actor policy records', async () => isolatedPolicy(async () => {
  await enforceGaryAccessPolicy({ toolName: 'checkPlexAvailability', input: {}, resourceId: 'telegram:one' });
  await enforceGaryAccessPolicy({ toolName: 'checkPlexAvailability', input: {}, resourceId: 'telegram:two' });
  await deleteGaryPolicyEvents('one');
  assert.equal((await listGaryPolicyEvents('one')).length, 0);
  assert.equal((await listGaryPolicyEvents('two')).length, 1);
}));

test('inbound claims identify first contact and reject event replay', async () => isolatedPolicy(async () => {
  const first = await claimGaryInboundEvent('whatsapp', 'wamid.one', '+15550001');
  assert.deepEqual(first, { accepted: true, firstForActor: true, reasonCode: 'accepted' });
  const next = await claimGaryInboundEvent('whatsapp', 'wamid.two', '+15550001');
  assert.deepEqual(next, { accepted: true, firstForActor: false, reasonCode: 'accepted' });
  const replay = await claimGaryInboundEvent('whatsapp', 'wamid.two', '+15550001');
  assert.deepEqual(replay, { accepted: false, firstForActor: false, reasonCode: 'duplicate_event' });
}));

test('duplicate inbound events do not consume the hourly safety budget', async () => isolatedPolicy(async () => {
  process.env.GARY_WHATSAPP_HOURLY_INBOUND_LIMIT = '1';
  assert.equal((await claimGaryInboundEvent('whatsapp', 'wamid.one', '+15550001')).accepted, true);
  assert.equal((await claimGaryInboundEvent('whatsapp', 'wamid.one', '+15550001')).reasonCode, 'duplicate_event');
  assert.equal((await claimGaryInboundEvent('whatsapp', 'wamid.two', '+15550001')).reasonCode, 'hourly_inbound_quota_reached');
}));

test('web research safety budgets are isolated by actor and have stable reason codes', async () => isolatedPolicy(async () => {
  process.env.GARY_WHATSAPP_ENABLED = 'true';
  process.env.GARY_WHATSAPP_ALLOWED_USERS = '+15550001,+15550002';
  process.env.GARY_WHATSAPP_HOURLY_WEB_LIMIT = '1';
  const first = await enforceGaryAccessPolicy({ toolName: 'webSearch', input: {}, resourceId: 'whatsapp:+15550001' });
  assert.equal(first.reasonCode, 'allowed');
  const limited = await enforceGaryAccessPolicy({ toolName: 'webSearch', input: {}, resourceId: 'whatsapp:+15550001' });
  assert.equal(limited.reasonCode, 'hourly_web_quota_reached');
  assert.equal((await enforceGaryAccessPolicy({ toolName: 'webSearch', input: {}, resourceId: 'whatsapp:+15550002' })).allowed, true);
}));
