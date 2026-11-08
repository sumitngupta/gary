import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { garyConfig } from '../config/gary-config';

export type GaryMessageReference = {
  threadId: string;
  messageId: string;
  actorId?: string;
  direction: 'inbound' | 'outbound';
  text: string;
  createdAt: string;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gary_message_references (
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  actor_id TEXT,
  direction TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_gary_message_references_created
  ON gary_message_references(created_at);
`;

let client: Client | undefined;
let initPromise: Promise<Client> | undefined;

async function db() {
  if (client) return client;
  initPromise ??= (async () => {
    const path = `${garyConfig().dataDir}/gary-conversation-state.db`;
    await mkdir(dirname(path), { recursive: true });
    const next = createClient({ url: `file:${path}`, timeout: 5000 });
    await next.executeMultiple(SCHEMA);
    client = next;
    return next;
  })();
  return initPromise;
}

export async function rememberGaryMessageReference(input: Omit<GaryMessageReference, 'createdAt'>) {
  const text = input.text.trim().slice(0, 4_000);
  if (!text) return;
  await (await db()).execute({
    sql: `INSERT INTO gary_message_references
      (thread_id, message_id, actor_id, direction, text, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, message_id) DO UPDATE SET
        actor_id = excluded.actor_id, direction = excluded.direction, text = excluded.text`,
    args: [input.threadId, input.messageId, input.actorId ?? null, input.direction, text, new Date().toISOString()],
  });
}

export async function getGaryMessageReference(threadId: string, messageId: string) {
  const result = await (await db()).execute({
    sql: 'SELECT * FROM gary_message_references WHERE thread_id = ? AND message_id = ?',
    args: [threadId, messageId],
  });
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    threadId: String(row.thread_id), messageId: String(row.message_id),
    actorId: row.actor_id ? String(row.actor_id) : undefined,
    direction: String(row.direction) as GaryMessageReference['direction'],
    text: String(row.text), createdAt: String(row.created_at),
  } satisfies GaryMessageReference;
}

export async function pruneGaryMessageReferences(olderThan = new Date(Date.now() - 30 * 86_400_000)) {
  const result = await (await db()).execute({
    sql: 'DELETE FROM gary_message_references WHERE created_at < ?', args: [olderThan.toISOString()],
  });
  return result.rowsAffected;
}

export async function deleteGaryMessageReferencesForActor(actorId: string) {
  const result = await (await db()).execute({
    sql: 'DELETE FROM gary_message_references WHERE actor_id = ?', args: [actorId],
  });
  return result.rowsAffected;
}

export async function deleteGaryMessageReference(threadId: string, messageId: string) {
  const result = await (await db()).execute({ sql: 'DELETE FROM gary_message_references WHERE thread_id = ? AND message_id = ?', args: [threadId, messageId] });
  return result.rowsAffected === 1;
}

export function resetGaryConversationStateStoreForTests() { client = undefined; initPromise = undefined; }
