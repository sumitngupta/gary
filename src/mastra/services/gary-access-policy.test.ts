import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { GaryUser } from '../channels/people';
import {
  claimGaryInboundEvent,
  deleteGaryPolicyEvents,
  enforceGaryAccessPolicy,
  listGaryPolicyEvents,
  resetGaryPolicyClientForTests,
  type Caller,
} from './gary-access-policy';

const alice: GaryUser = { id: 'u_alice', displayName: 'Alice', role: 'member', createdAt: '2026-01-01T00:00:00.000Z' };
const bob: GaryUser = { ...alice, id: 'u_bob', displayName: 'Bob' };
const admin: GaryUser = { ...alice, id: 'u_admin', displayName: 'Admin', role: 'admin' };

const member = (eventId?: string, person = alice): Caller => ({ kind: 'person', person, channel: 'telegram', eventId });

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

test('a tool call without an identified person is denied on every channel', async () => isolatedPolicy(async () => {
  const result = await enforceGaryAccessPolicy({ caller: undefined, toolName: 'checkPlexAvailability', input: {} });
  assert.deepEqual([result.allowed, result.reasonCode], [false, 'unknown_identity']);
}));

test('admin-only tools are refused for members and allowed for admins', async () => isolatedPolicy(async () => {
  const cases: Array<[string, unknown]> = [
    ['reviewCollectionPackRepair', {}],
    ['executeCollectionPackRepair', { planId: 'plan' }],
    ['manageGaryHouseholdContext', { action: 'update' }],
    ['manageGaryAccess', { action: 'invite', displayName: 'Carol' }],
  ];
  const outcomes = [];
  for (const [toolName, input] of cases) {
    const asMember = await enforceGaryAccessPolicy({ caller: member(`m-${toolName}`), toolName, input });
    const asAdmin = await enforceGaryAccessPolicy({ caller: member(`a-${toolName}`, admin), toolName, input });
    outcomes.push([toolName, asMember.reasonCode, asAdmin.reasonCode]);
  }
  assert.deepEqual(outcomes, [
    ['reviewCollectionPackRepair', 'admin_only', 'allowed'],
    ['executeCollectionPackRepair', 'admin_only', 'allowed'],
    ['manageGaryHouseholdContext', 'admin_only', 'allowed'],
    ['manageGaryAccess', 'admin_only', 'allowed'],
  ]);
  const read = await enforceGaryAccessPolicy({ caller: member(), toolName: 'manageGaryHouseholdContext', input: { action: 'get' } });
  const selfLink = await enforceGaryAccessPolicy({ caller: member('link'), toolName: 'manageGaryAccess', input: { action: 'link-code' } });
  assert.deepEqual([read.reasonCode, selfLink.reasonCode], ['allowed', 'allowed']);
}));

test('changes require the trusted chat message id', async () => isolatedPolicy(async () => {
  const result = await enforceGaryAccessPolicy({ caller: member(), toolName: 'createMediaRequest', input: { title: 'Heat' } });
  assert.deepEqual([result.allowed, result.reasonCode], [false, 'trusted_event_required']);
}));

test('repair tools are categorized as guarded repair mutations', async () => isolatedPolicy(async () => {
  const results = [];
  for (const toolName of ['refreshPlexLibrary', 'executePlexCollectionChange', 'executeMediaQualityUpgrade']) {
    const result = await enforceGaryAccessPolicy({ caller: member(`e-${toolName}`), toolName, input: {} });
    results.push([toolName, result.allowed, result.mutation, result.category]);
  }
  assert.deepEqual(results, [
    ['refreshPlexLibrary', true, true, 'repair'],
    ['executePlexCollectionChange', true, true, 'repair'],
    ['executeMediaQualityUpgrade', true, true, 'repair'],
  ]);
}));

test('replay protection blocks the same event operation', async () => isolatedPolicy(async () => {
  const call = { caller: member('msg-123'), toolName: 'createMediaRequest', input: { title: 'Heat' } };
  assert.equal((await enforceGaryAccessPolicy(call)).allowed, true);
  const duplicate = await enforceGaryAccessPolicy(call);
  assert.deepEqual([duplicate.allowed, duplicate.reasonCode], [false, 'duplicate_event_operation']);
}));

test('daily quotas count per person across channels and spare admins', async () => isolatedPolicy(async () => {
  process.env.GARY_DAILY_MUTATION_LIMIT = '1';
  const first = await enforceGaryAccessPolicy({ caller: member('one'), toolName: 'createMediaRequest', input: { title: 'Heat' } });
  const onWhatsApp: Caller = { kind: 'person', person: alice, channel: 'whatsapp', eventId: 'two' };
  const second = await enforceGaryAccessPolicy({ caller: onWhatsApp, toolName: 'createMediaRequest', input: { title: 'Arrival' } });
  const otherPerson = await enforceGaryAccessPolicy({ caller: member('three', bob), toolName: 'createMediaRequest', input: { title: 'Arrival' } });
  await enforceGaryAccessPolicy({ caller: member('four', admin), toolName: 'createMediaRequest', input: { title: 'Heat' } });
  const adminAgain = await enforceGaryAccessPolicy({ caller: member('five', admin), toolName: 'createMediaRequest', input: { title: 'Arrival' } });
  assert.deepEqual([first.reasonCode, second.reasonCode, otherPerson.reasonCode, adminAgain.reasonCode], ['allowed', 'daily_mutation_quota_reached', 'allowed', 'allowed']);
}));

test('personal list edits have their own quota and do not spend the request budget', async () => isolatedPolicy(async () => {
  process.env.GARY_DAILY_MUTATION_LIMIT = '1';
  process.env.GARY_DAILY_LIST_LIMIT = '3';
  assert.equal((await enforceGaryAccessPolicy({ caller: member('profile'), toolName: 'manageGaryProfile', input: { action: 'update' } })).allowed, true);
  for (const eventId of ['list-1', 'list-2', 'list-3']) {
    assert.equal((await enforceGaryAccessPolicy({ caller: member(eventId), toolName: 'manageGaryLists', input: { action: 'add', items: [{ title: eventId }] } })).allowed, true, eventId);
  }
  const limited = await enforceGaryAccessPolicy({ caller: member('list-4'), toolName: 'manageGaryLists', input: { action: 'add', items: [{ title: 'four' }] } });
  assert.equal(limited.reasonCode, 'daily_mutation_quota_reached');
}));

test('scheduled radar denies everything outside its exact delivery contract', async () => isolatedPolicy(async () => {
  const radar: Caller = { kind: 'radar', person: alice };
  const denied = [];
  for (const toolName of ['createMediaRequest', 'createMediaAvailabilityWatch', 'manageGaryProfile', 'inspectGaryRequestHistory', 'manageGaryLists']) {
    denied.push((await enforceGaryAccessPolicy({ caller: radar, toolName, input: {} })).reasonCode);
  }
  assert.deepEqual(denied, Array(5).fill('radar_mutation_denied'));
  assert.equal((await enforceGaryAccessPolicy({ caller: radar, toolName: 'recordMediaRadarDelivery', input: {} })).allowed, true);
}));

test('personal list changes count as mutations while viewing a list does not', async () => isolatedPolicy(async () => {
  const mutations = [];
  for (const action of ['overview', 'show', 'add', 'remove', 'rename', 'delete-list', 'publish', 'confirm-publish', 'unpublish']) {
    const result = await enforceGaryAccessPolicy({ caller: member(`e-${action}`), toolName: 'manageGaryLists', input: { action } });
    mutations.push([action, result.mutation]);
  }
  assert.deepEqual(mutations, [
    ['overview', false], ['show', false], ['add', true], ['remove', true], ['rename', true], ['delete-list', true],
    ['publish', true], ['confirm-publish', true], ['unpublish', true],
  ]);
}));

test('privacy deletion removes only the selected person policy records', async () => isolatedPolicy(async () => {
  await enforceGaryAccessPolicy({ caller: member(), toolName: 'checkPlexAvailability', input: {} });
  await enforceGaryAccessPolicy({ caller: member(undefined, bob), toolName: 'checkPlexAvailability', input: {} });
  await deleteGaryPolicyEvents('u_alice');
  assert.deepEqual([(await listGaryPolicyEvents('u_alice')).length, (await listGaryPolicyEvents('u_bob')).length], [0, 1]);
}));

test('inbound claims identify first contact and reject event replay', async () => isolatedPolicy(async () => {
  const first = await claimGaryInboundEvent({ channel: 'telegram', eventId: 'one', actorKey: 'u_alice' });
  const next = await claimGaryInboundEvent({ channel: 'web', eventId: 'two', actorKey: 'u_alice' });
  const replay = await claimGaryInboundEvent({ channel: 'web', eventId: 'two', actorKey: 'u_alice' });
  assert.deepEqual([first, next, replay], [
    { accepted: true, firstForActor: true, reasonCode: 'accepted' },
    { accepted: true, firstForActor: false, reasonCode: 'accepted' },
    { accepted: false, firstForActor: false, reasonCode: 'duplicate_event' },
  ]);
}));

test('duplicate inbound events do not consume the hourly safety budget', async () => isolatedPolicy(async () => {
  process.env.GARY_HOURLY_INBOUND_LIMIT = '1';
  const codes = [];
  for (const eventId of ['one', 'one', 'two']) codes.push((await claimGaryInboundEvent({ channel: 'telegram', eventId, actorKey: 'telegram:42' })).reasonCode);
  assert.deepEqual(codes, ['accepted', 'duplicate_event', 'hourly_inbound_quota_reached']);
}));

test('web research safety budgets are isolated by person', async () => isolatedPolicy(async () => {
  process.env.GARY_HOURLY_WEB_LIMIT = '1';
  const codes = [];
  for (const caller of [member(), member(), member(undefined, bob)]) codes.push((await enforceGaryAccessPolicy({ caller, toolName: 'webSearch', input: {} })).reasonCode);
  assert.deepEqual(codes, ['allowed', 'hourly_web_quota_reached', 'allowed']);
}));
