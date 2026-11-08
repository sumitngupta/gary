import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { garyConfig } from '../config/gary-config';

export type StoredCollectionPackFile = {
  path: string;
  folderName?: string;
  releaseGroup?: string;
  quality: unknown;
  languages: unknown[];
  indexerFlags: number;
  downloadId?: string;
  size: number;
  title: string;
  year?: number;
  tmdbId: number;
  lookup: Record<string, unknown>;
};

export type CollectionPackPlan = {
  id: string;
  actorId: string;
  targetTitle: string;
  targetTmdbId?: number;
  files: StoredCollectionPackFile[];
  createdAt: string;
  expiresAt: string;
};

let client: Client | undefined;
let initialized: Promise<void> | undefined;
function path() { return `${garyConfig().dataDir}/collection-pack-repairs.db`; }
async function db() {
  if (!client) {
    await mkdir(dirname(path()), { recursive: true });
    client = createClient({ url: `file:${path()}` });
    initialized = client.executeMultiple(`CREATE TABLE IF NOT EXISTS collection_pack_plans (
      id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, target_title TEXT NOT NULL, target_tmdb_id INTEGER,
      files_json TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT);
      CREATE TABLE IF NOT EXISTS collection_pack_target_repairs (
      repair_key TEXT PRIMARY KEY, status TEXT NOT NULL, command_id INTEGER, detail_json TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`).then(() => undefined);
  }
  await initialized;
  return client;
}

function fromRow(row: Record<string, unknown>): CollectionPackPlan {
  return {
    id: String(row.id), actorId: String(row.actor_id), targetTitle: String(row.target_title),
    targetTmdbId: row.target_tmdb_id == null ? undefined : Number(row.target_tmdb_id),
    files: JSON.parse(String(row.files_json)) as StoredCollectionPackFile[],
    createdAt: String(row.created_at), expiresAt: String(row.expires_at),
  };
}

export async function createCollectionPackPlan(input: Omit<CollectionPackPlan, 'id' | 'createdAt' | 'expiresAt'>, now = new Date()) {
  const id = randomUUID();
  const expiresAt = new Date(now.getTime() + 6 * 60 * 60_000).toISOString();
  await (await db()).execute({
    sql: 'INSERT INTO collection_pack_plans VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
    args: [id, input.actorId, input.targetTitle, input.targetTmdbId ?? null, JSON.stringify(input.files), now.toISOString(), expiresAt],
  });
  return { id, expiresAt };
}

export async function getCollectionPackPlan(id: string, actorId: string, now = new Date()) {
  const result = await (await db()).execute({ sql: 'SELECT * FROM collection_pack_plans WHERE id = ? AND actor_id = ? AND consumed_at IS NULL AND expires_at > ?', args: [id, actorId, now.toISOString()] });
  return result.rows[0] ? fromRow(result.rows[0] as Record<string, unknown>) : undefined;
}

export async function getLatestCollectionPackPlan(actorId: string, now = new Date()) {
  const result = await (await db()).execute({ sql: 'SELECT * FROM collection_pack_plans WHERE actor_id = ? AND consumed_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1', args: [actorId, now.toISOString()] });
  return result.rows[0] ? fromRow(result.rows[0] as Record<string, unknown>) : undefined;
}

export async function consumeCollectionPackPlan(id: string, actorId: string, now = new Date()) {
  const plan = await getCollectionPackPlan(id, actorId, now);
  if (!plan) return undefined;
  const result = await (await db()).execute({ sql: 'UPDATE collection_pack_plans SET consumed_at = ? WHERE id = ? AND actor_id = ? AND consumed_at IS NULL', args: [now.toISOString(), id, actorId] });
  return result.rowsAffected === 1 ? plan : undefined;
}

export async function claimCollectionPackTargetRepair(repairKey: string, detail: unknown, now = new Date()) {
  try {
    await (await db()).execute({ sql: 'INSERT INTO collection_pack_target_repairs VALUES (?, ?, NULL, ?, ?, ?)', args: [repairKey, 'claimed', JSON.stringify(detail), now.toISOString(), now.toISOString()] });
    return true;
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      const retry = await (await db()).execute({ sql: "UPDATE collection_pack_target_repairs SET status = 'claimed', detail_json = ?, updated_at = ? WHERE repair_key = ? AND status = 'failed'", args: [JSON.stringify(detail), now.toISOString(), repairKey] });
      return retry.rowsAffected === 1;
    }
    throw error;
  }
}

export async function recordCollectionPackTargetRepair(repairKey: string, status: string, commandId?: number, detail?: unknown) {
  await (await db()).execute({ sql: 'UPDATE collection_pack_target_repairs SET status = ?, command_id = ?, detail_json = ?, updated_at = ? WHERE repair_key = ?', args: [status, commandId ?? null, JSON.stringify(detail ?? {}), new Date().toISOString(), repairKey] });
}

export function resetCollectionPackRepairStoreForTests() { client?.close(); client = undefined; initialized = undefined; }
