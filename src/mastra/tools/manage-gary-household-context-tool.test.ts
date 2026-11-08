import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { enroll, ensureOwner, issueCode, resetPeopleStoreForTests } from '../channels/people';
import { resetGaryHouseholdContextStoreForTests } from '../services/gary-household-context-store';
import { manageGaryHouseholdContextTool } from './manage-gary-household-context-tool';

function telegramContext(userId: string) {
  return { requestContext: { get: (key: string) => (key === 'channel' ? { platform: 'telegram', userId, messageId: 'm1' } : undefined) } } as never;
}

test('canonical household details are shown only to an admin', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gary-household-'));
  const prior = { ...process.env };
  process.env.GARY_DATA_DIR = dir;
  resetPeopleStoreForTests(); resetGaryHouseholdContextStoreForTests();
  t.after(async () => {
    process.env = prior;
    resetPeopleStoreForTests(); resetGaryHouseholdContextStoreForTests();
    await rm(dir, { recursive: true, force: true });
  });
  const { bootstrapCode } = await ensureOwner();
  await enroll({ channel: 'telegram', externalId: '1' }, { kind: 'code', text: bootstrapCode! });
  await enroll({ channel: 'telegram', externalId: '2' }, { kind: 'code', text: (await issueCode({ kind: 'new-user', displayName: 'Bob', role: 'member' })).code });
  const asMember = await manageGaryHouseholdContextTool.execute!({ action: 'get' }, telegramContext('2'));
  const asAdmin = await manageGaryHouseholdContextTool.execute!({ action: 'get' }, telegramContext('1'));
  assert.deepEqual(asMember, { status: 'ok', summary: 'Household safety boundaries are applied automatically; private household details are admin-only.' });
  assert.equal((asAdmin as { summary: string }).summary, 'Loaded canonical household recommendation context.');
});
