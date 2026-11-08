import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { escalateToGarySupervisorTool } from './escalate-to-gary-supervisor-tool';
import { resetGaryUserProfileStoreForTests } from '../services/gary-user-profile-store';
import { resetGaryOperationsStoreForTests } from '../services/gary-operations-store';
import { enroll, ensureOwner, resetPeopleStoreForTests } from '../channels/people';

test('escalation receipts distinguish recorded, sent and duplicate delivery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gary-escalation-smoke-'));
  const env = { ...process.env }; const originalFetch = globalThis.fetch;
  process.env.GARY_DATA_DIR = dir; process.env.GARY_READ_ONLY = 'false';
  delete process.env.TELEGRAM_BOT_TOKEN;
  resetGaryUserProfileStoreForTests(); resetGaryOperationsStoreForTests(); resetPeopleStoreForTests();
  await enroll({ channel: 'telegram', externalId: '1' }, { kind: 'code', text: (await ensureOwner()).bootstrapCode! });
  let sends = 0;
  const sent: string[] = [];
  globalThis.fetch = async (_url, init) => {
    sends++; sent.push(JSON.parse(String(init?.body)).text);
    return Response.json({ ok: true, result: { message_id: 5, date: 0, chat: { id: 1, type: 'private' }, text: 'x' } });
  };
  const context = { agent: { resourceId: 'fixture:user', threadId: 'fixture-chat' } } as any;
  const exec = escalateToGarySupervisorTool.execute!;
  const input = { summary: 'Please support music requests.', reason: 'Music acquisition is unsupported.', userConsented: true as const };
  try {
    assert.equal((await exec(input, context) as any).status, 'recorded');
    const retry: any = await exec(input, context);
    assert.equal(retry.status, 'recorded');
    assert.match(retry.summary, /has not been confirmed/);
    assert.equal(sends, 0);
    process.env.TELEGRAM_BOT_TOKEN = 'fixture';
    const other = { ...input, summary: 'Please support audiobook requests.' };
    assert.equal((await exec(other, context) as any).status, 'sent');
    assert.equal((await exec(other, context) as any).status, 'already-open');
    assert.equal(sends, 1);
    assert.deepEqual(sent, ['Gary escalation from a Gary user: Please support audiobook requests.\n\nWhy Gary escalated: Music acquisition is unsupported.\nReference: 2']);
  } finally {
    globalThis.fetch = originalFetch; resetGaryUserProfileStoreForTests(); resetGaryOperationsStoreForTests(); resetPeopleStoreForTests(); process.env = env;
    await rm(dir, { recursive: true, force: true });
  }
});
