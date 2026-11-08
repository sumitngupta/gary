import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  deleteGaryMessageReferencesForActor,
  deleteGaryMessageReference,
  getGaryMessageReference,
  pruneGaryMessageReferences,
  rememberGaryMessageReference,
  resetGaryConversationStateStoreForTests,
} from './gary-conversation-state-store';

test('message references survive cache loss and remain thread and actor scoped', async () => {
  const previous = process.env.GARY_DATA_DIR;
  const path = await mkdtemp(join(tmpdir(), 'gary-conversation-state-'));
  process.env.GARY_DATA_DIR = path;
  resetGaryConversationStateStoreForTests();
  try {
    await rememberGaryMessageReference({
      threadId: 'thread-a', messageId: 'wamid.1', actorId: '+15550001',
      direction: 'inbound', text: 'Should I request Heat (1995)?',
    });
    await rememberGaryMessageReference({
      threadId: 'thread-a', messageId: 'wamid.bot-old', actorId: 'gary',
      direction: 'outbound', text: 'A: inspect Heat. B: request Thief.',
    });
    await rememberGaryMessageReference({
      threadId: 'thread-a', messageId: 'wamid.media', actorId: '+15550001',
      direction: 'inbound', text: '[WhatsApp image] Which movie is this?',
    });
    resetGaryConversationStateStoreForTests();
    assert.equal((await getGaryMessageReference('thread-a', 'wamid.1'))?.text, 'Should I request Heat (1995)?');
    assert.equal((await getGaryMessageReference('thread-a', 'wamid.bot-old'))?.direction, 'outbound');
    assert.equal((await getGaryMessageReference('thread-a', 'wamid.media'))?.text, '[WhatsApp image] Which movie is this?');
    assert.equal(await getGaryMessageReference('thread-b', 'wamid.1'), undefined);
    assert.equal(await getGaryMessageReference('thread-a', 'wamid.missing'), undefined);
    assert.equal(await deleteGaryMessageReference('thread-a', 'wamid.1'), true);
    assert.equal(await getGaryMessageReference('thread-a', 'wamid.1'), undefined);
    await rememberGaryMessageReference({ threadId: 'thread-a', messageId: 'wamid.2', actorId: '+15550001', direction: 'inbound', text: 'another' });
    assert.equal(await deleteGaryMessageReferencesForActor('+15550001'), 2);
    assert.equal(await getGaryMessageReference('thread-a', 'wamid.1'), undefined);
    assert.equal(await pruneGaryMessageReferences(new Date(Date.now() + 1_000)), 1);
    assert.equal(await getGaryMessageReference('thread-a', 'wamid.bot-old'), undefined);
  } finally {
    resetGaryConversationStateStoreForTests();
    if (previous === undefined) delete process.env.GARY_DATA_DIR;
    else process.env.GARY_DATA_DIR = previous;
    await rm(path, { recursive: true, force: true });
  }
});
