import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { garyConfig } from '../config/gary-config';

export const GARY_DELETE_CONFIRMATION_PHRASE = 'DELETE MY GARY DATA';

let client: Client | undefined;
let initPromise: Promise<void> | undefined;

function databasePath() {
  return `${garyConfig().dataDir}/gary-confirmations.db`;
}

async function database() {
  if (!client) {
    const path = databasePath();
    await mkdir(dirname(path), { recursive: true });
    client = createClient({ url: `file:${path}` });
    initPromise = client.executeMultiple(`
      CREATE TABLE IF NOT EXISTS gary_confirmations (
        resource_id TEXT NOT NULL,
        action TEXT NOT NULL,
        phrase TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        cancelled_at TEXT,
        PRIMARY KEY (resource_id, action)
      );
      CREATE INDEX IF NOT EXISTS idx_gary_confirmations_expiry
        ON gary_confirmations(expires_at);
    `).then(() => undefined);
  }
  await initPromise;
  return client;
}

function ttlMs() {
  return garyConfig().requests.confirmationTtlMinutes * 60_000;
}

export async function beginGaryDeletionConfirmation(resourceId: string, now = new Date()) {
  const db = await database();
  const expiresAt = new Date(now.getTime() + ttlMs());
  await db.execute({
    sql: `INSERT INTO gary_confirmations
      (resource_id, action, phrase, created_at, expires_at, consumed_at, cancelled_at)
      VALUES (?, 'delete-user-data', ?, ?, ?, NULL, NULL)
      ON CONFLICT(resource_id, action) DO UPDATE SET
        phrase = excluded.phrase,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at,
        consumed_at = NULL,
        cancelled_at = NULL`,
    args: [resourceId, GARY_DELETE_CONFIRMATION_PHRASE, now.toISOString(), expiresAt.toISOString()],
  });
  return { phrase: GARY_DELETE_CONFIRMATION_PHRASE, expiresAt: expiresAt.toISOString() };
}

export async function consumeGaryDeletionConfirmation(resourceId: string, phrase: string, now = new Date()) {
  const db = await database();
  const result = await db.execute({
    sql: `UPDATE gary_confirmations SET consumed_at = ?
      WHERE resource_id = ? AND action = 'delete-user-data' AND phrase = ?
        AND consumed_at IS NULL AND cancelled_at IS NULL AND expires_at > ?`,
    args: [now.toISOString(), resourceId, phrase.trim(), now.toISOString()],
  });
  return result.rowsAffected === 1;
}

export async function wasGaryDeletionConsumedSince(resourceId: string, since: Date) {
  const db = await database();
  const result = await db.execute({
    sql: `SELECT consumed_at FROM gary_confirmations
      WHERE resource_id = ? AND action = 'delete-user-data' AND consumed_at >= ?`,
    args: [resourceId, since.toISOString()],
  });
  return result.rows.length > 0;
}

export async function cancelGaryDeletionConfirmation(resourceId: string, now = new Date()) {
  const db = await database();
  const result = await db.execute({
    sql: `UPDATE gary_confirmations SET cancelled_at = ?
      WHERE resource_id = ? AND action = 'delete-user-data'
        AND consumed_at IS NULL AND cancelled_at IS NULL AND expires_at > ?`,
    args: [now.toISOString(), resourceId, now.toISOString()],
  });
  return result.rowsAffected === 1;
}

export function resetGaryConfirmationStoreForTests() {
  client?.close();
  client = undefined;
  initPromise = undefined;
}
