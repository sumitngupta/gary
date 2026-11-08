import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { enroll, ensureOwner, identify, issueCode, resetPeopleStoreForTests, resourceIdFor } from './people';

async function isolated(t: TestContext, env: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'gary-people-'));
  const prior = { ...process.env };
  Object.assign(process.env, { GARY_DATA_DIR: dir, ...env });
  resetPeopleStoreForTests();
  t.after(async () => {
    process.env = prior;
    resetPeopleStoreForTests();
    await rm(dir, { recursive: true, force: true });
  });
}

test('an invite code links exactly one identity and a second use is rejected', async (t) => {
  await isolated(t);
  const { code } = await issueCode({ kind: 'new-user', displayName: 'Alice', role: 'member' });
  const first = await enroll({ channel: 'telegram', externalId: '1001' }, { kind: 'code', text: `hi gary ${code.toLowerCase()}` });
  assert.equal(first.status, 'linked');
  assert.deepEqual(first.status === 'linked' && [first.person.displayName, first.person.role, first.newUser], ['Alice', 'member', true]);
  const replay = await enroll({ channel: 'telegram', externalId: '2002' }, { kind: 'code', text: code });
  assert.deepEqual(replay, { status: 'refused', reason: 'invalid_or_used' });
  assert.equal(await identify({ channel: 'telegram', externalId: '2002' }), undefined);
});

test('messages without a valid code are refused', async (t) => {
  await isolated(t);
  const key = { channel: 'web' as const, externalId: 'browser' };
  assert.deepEqual(await enroll(key, { kind: 'code', text: 'hello there' }), { status: 'refused', reason: 'no_code' });
  assert.deepEqual(await enroll(key, { kind: 'code', text: 'GARY-000000000000' }), { status: 'refused', reason: 'invalid_or_used' });
});

test('a link code follows one person across channels while two people stay separate', async (t) => {
  await isolated(t);
  const alice = await enroll({ channel: 'telegram', externalId: '1001' }, { kind: 'code', text: (await issueCode({ kind: 'new-user', displayName: 'Alice', role: 'member' })).code });
  const bob = await enroll({ channel: 'web', externalId: 'bob-browser' }, { kind: 'code', text: (await issueCode({ kind: 'new-user', displayName: 'Bob', role: 'member' })).code });
  assert.ok(alice.status === 'linked' && bob.status === 'linked');
  const link = await issueCode({ kind: 'existing-user', userId: alice.person.id });
  const aliceOnWhatsApp = await enroll({ channel: 'whatsapp', externalId: '15550001' }, { kind: 'code', text: link.code });
  assert.ok(aliceOnWhatsApp.status === 'linked');
  assert.equal(aliceOnWhatsApp.newUser, false);
  const resources = await Promise.all([
    identify({ channel: 'telegram', externalId: '1001' }),
    identify({ channel: 'whatsapp', externalId: '15550001' }),
    identify({ channel: 'web', externalId: 'bob-browser' }),
  ]).then((people) => people.map((person) => resourceIdFor(person!.id)));
  assert.equal(resources[0], resources[1]);
  assert.notEqual(resources[0], resources[2]);
  assert.match(resources[2], /^gary-user:u_[0-9a-f]{16}$/);
});

test('first boot prints one live admin code until an admin identity is linked', async (t) => {
  await isolated(t, { GARY_ADMIN_NAME: 'Dana' });
  const first = await ensureOwner();
  const second = await ensureOwner();
  assert.match(first.bootstrapCode!, /^GARY-[0-9A-F]{12}$/);
  assert.notEqual(first.bootstrapCode, second.bootstrapCode);
  assert.deepEqual(await enroll({ channel: 'telegram', externalId: '1' }, { kind: 'code', text: first.bootstrapCode! }), { status: 'refused', reason: 'invalid_or_used' });
  const owner = await enroll({ channel: 'telegram', externalId: '1' }, { kind: 'code', text: second.bootstrapCode! });
  assert.deepEqual(owner.status === 'linked' && [owner.person.displayName, owner.person.role], ['Dana', 'admin']);
  assert.deepEqual(await ensureOwner(), {});
});

test('the admin password signs a browser in as the owner and nothing else', async (t) => {
  await isolated(t, { GARY_ADMIN_PASSWORD: 'correct horse' });
  assert.deepEqual(await enroll({ channel: 'web', externalId: 'b1' }, { kind: 'owner-password', password: 'wrong' }), { status: 'refused', reason: 'bad_password' });
  const signedIn = await enroll({ channel: 'web', externalId: 'b1' }, { kind: 'owner-password', password: 'correct horse' });
  assert.deepEqual(signedIn.status === 'linked' && signedIn.person.role, 'admin');
});

test('a web sign-in stops identifying the browser after 30 days and is pruned at boot', async (t) => {
  await isolated(t, { GARY_ADMIN_PASSWORD: 'correct horse' });
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') });
  const browser = { channel: 'web' as const, externalId: 'b1' };
  const phone = { channel: 'telegram' as const, externalId: '1001' };
  await enroll(browser, { kind: 'owner-password', password: 'correct horse' });
  await enroll(phone, { kind: 'code', text: (await issueCode({ kind: 'new-user', displayName: 'Alice', role: 'member' })).code });
  t.mock.timers.setTime(Date.parse('2026-01-30T23:00:00Z'));
  assert.deepEqual([(await identify(browser))?.role, (await identify(phone))?.displayName], ['admin', 'Alice']);
  t.mock.timers.setTime(Date.parse('2026-01-31T00:00:01Z'));
  assert.deepEqual([await identify(browser), (await identify(phone))?.displayName], [undefined, 'Alice']);
  assert.match((await ensureOwner()).bootstrapCode ?? '', /^GARY-[0-9A-F]{12}$/);
});
