import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { escalateToGarySupervisorTool } from './escalate-to-gary-supervisor-tool';
import { resetGaryUserProfileStoreForTests } from '../services/gary-user-profile-store';
import { resetGaryOperationsStoreForTests } from '../services/gary-operations-store';

test('escalation receipts distinguish recorded, sent and duplicate delivery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gary-escalation-smoke-'));
  const env = { ...process.env }; const originalFetch = globalThis.fetch;
  process.env.GARY_DATA_DIR = dir; process.env.GARY_ADMIN_WHATSAPP = '15550001';
  delete process.env.GARY_WHATSAPP_ACCESS_TOKEN; delete process.env.GARY_WHATSAPP_PHONE_NUMBER_ID;
  resetGaryUserProfileStoreForTests(); resetGaryOperationsStoreForTests();
  let sends = 0;
  globalThis.fetch = async () => { sends++; return Response.json({ messages: [{ id: 'fixture-message' }] }); };
  const context = { agent: { resourceId: 'fixture:user', threadId: 'fixture-chat' } } as any;
  const exec = escalateToGarySupervisorTool.execute!;
  const input = { summary: 'Please support music requests.', reason: 'Music acquisition is unsupported.', userConsented: true as const };
  try {
    assert.equal((await exec(input, context) as any).status, 'recorded');
    const retry: any = await exec(input, context);
    assert.equal(retry.status, 'recorded');
    assert.match(retry.summary, /has not been confirmed/);
    assert.equal(sends, 0);
    process.env.GARY_WHATSAPP_ACCESS_TOKEN = 'fixture'; process.env.GARY_WHATSAPP_PHONE_NUMBER_ID = 'fixture';
    const other = { ...input, summary: 'Please support audiobook requests.' };
    assert.equal((await exec(other, context) as any).status, 'sent');
    assert.equal((await exec(other, context) as any).status, 'already-open');
    assert.equal(sends, 1);
  } finally {
    globalThis.fetch = originalFetch; resetGaryUserProfileStoreForTests(); resetGaryOperationsStoreForTests(); process.env = env;
    await rm(dir, { recursive: true, force: true });
  }
});
