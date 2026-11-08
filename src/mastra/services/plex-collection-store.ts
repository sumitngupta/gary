import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createClient, type Client } from '@libsql/client';
import type { PlexCollectionPreviewInput, PlexCollectionResolution } from '../schemas/plex-collection';

export type StoredPlexCollectionPreview = { id: string; actorId: string; input: PlexCollectionPreviewInput; collectionRatingKey?: string; before?: unknown; available: PlexCollectionResolution[]; alreadyRequested: PlexCollectionResolution[]; missing: PlexCollectionResolution[]; ambiguous: PlexCollectionResolution[]; removed: PlexCollectionResolution[]; createdAt: string; expiresAt: string };
let client: Client | undefined; let initialized: Promise<void> | undefined;
function path() { return `${process.env.GARY_DATA_DIR || './data'}/plex-collections.db`; }
async function db() {
  if (!client) { await mkdir(dirname(path()), { recursive: true }); client = createClient({ url: `file:${path()}` }); initialized = client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS plex_collection_ownership (rating_key TEXT PRIMARY KEY, actor_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS plex_collection_previews (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT);
    CREATE TABLE IF NOT EXISTS plex_collection_events (id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at TEXT NOT NULL, preview_id TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL, before_json TEXT, after_json TEXT, rollback_json TEXT);
  `).then(() => undefined); }
  await initialized; return client;
}
export async function collectionOwner(ratingKey: string) { const row = (await (await db()).execute({ sql: 'SELECT actor_id FROM plex_collection_ownership WHERE rating_key = ?', args: [ratingKey] })).rows[0]; return row ? String(row.actor_id) : undefined; }
export async function recordCollectionOwner(ratingKey: string, actorId: string, now = new Date()) { await (await db()).execute({ sql: `INSERT INTO plex_collection_ownership VALUES (?, ?, ?, ?) ON CONFLICT(rating_key) DO UPDATE SET actor_id=excluded.actor_id, updated_at=excluded.updated_at`, args: [ratingKey, actorId, now.toISOString(), now.toISOString()] }); }
export async function replaceCollectionOwner(oldKey: string | undefined, newKey: string, actorId: string) { const database = await db(); if (oldKey) await database.execute({ sql: 'DELETE FROM plex_collection_ownership WHERE rating_key = ? AND actor_id = ?', args: [oldKey, actorId] }); await recordCollectionOwner(newKey, actorId); }
export async function removeCollectionOwner(ratingKey: string, actorId: string) { await (await db()).execute({ sql: 'DELETE FROM plex_collection_ownership WHERE rating_key = ? AND actor_id = ?', args: [ratingKey, actorId] }); }
export async function createPlexCollectionPreview(data: Omit<StoredPlexCollectionPreview, 'id' | 'createdAt' | 'expiresAt'>, now = new Date()) { const preview = { ...data, id: randomUUID(), createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString() }; await (await db()).execute({ sql: 'INSERT INTO plex_collection_previews VALUES (?, ?, ?, ?, ?, NULL)', args: [preview.id, preview.actorId, JSON.stringify(preview), preview.createdAt, preview.expiresAt] }); return preview; }
export async function consumePlexCollectionPreview(id: string, actorId: string, now = new Date()) { const database = await db(); const row = (await database.execute({ sql: 'SELECT payload_json, expires_at, consumed_at FROM plex_collection_previews WHERE id=? AND actor_id=?', args: [id, actorId] })).rows[0]; if (!row || row.consumed_at || String(row.expires_at) <= now.toISOString()) return undefined; const claimed = await database.execute({ sql: 'UPDATE plex_collection_previews SET consumed_at=? WHERE id=? AND actor_id=? AND consumed_at IS NULL', args: [now.toISOString(), id, actorId] }); return claimed.rowsAffected === 1 ? JSON.parse(String(row.payload_json)) as StoredPlexCollectionPreview : undefined; }
export async function recordPlexCollectionEvent(input: { previewId: string; actorId: string; action: string; status: string; before?: unknown; after?: unknown; rollback?: unknown }) { await (await db()).execute({ sql: 'INSERT INTO plex_collection_events (occurred_at,preview_id,actor_id,action,status,before_json,after_json,rollback_json) VALUES (?,?,?,?,?,?,?,?)', args: [new Date().toISOString(), input.previewId, input.actorId, input.action, input.status, JSON.stringify(input.before ?? null), JSON.stringify(input.after ?? null), JSON.stringify(input.rollback ?? null)] }); }
export function resetPlexCollectionStoreForTests() { client?.close(); client = undefined; initialized = undefined; }
