import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createClient, type Client } from '@libsql/client';
import type { MediaQualityUpgradeItem } from '../schemas/media-quality-upgrade';

let client: Client | undefined;
let initialized: Promise<void> | undefined;
function path() { return `${process.env.GARY_DATA_DIR || './data'}/media-quality-upgrades.db`; }
async function db() {
  if (!client) {
    await mkdir(dirname(path()), { recursive: true });
    client = createClient({ url: `file:${path()}` });
    initialized = client.executeMultiple(`CREATE TABLE IF NOT EXISTS media_quality_upgrade_plans (
      id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, items_json TEXT NOT NULL, created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL, consumed_at TEXT);
      CREATE TABLE IF NOT EXISTS media_quality_upgrade_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at TEXT NOT NULL, plan_id TEXT NOT NULL,
      actor_id TEXT NOT NULL, status TEXT NOT NULL, started_json TEXT NOT NULL, failed_json TEXT NOT NULL);`).then(() => undefined);
  }
  await initialized;
  return client;
}
export async function createMediaQualityUpgradePlan(actorId: string, items: MediaQualityUpgradeItem[], now = new Date()) {
  const id = randomUUID(); const expiresAt = new Date(now.getTime() + 30 * 60_000);
  await (await db()).execute({ sql: 'INSERT INTO media_quality_upgrade_plans VALUES (?, ?, ?, ?, ?, NULL)', args: [id, actorId, JSON.stringify(items), now.toISOString(), expiresAt.toISOString()] });
  return { id, expiresAt: expiresAt.toISOString() };
}
export async function consumeMediaQualityUpgradePlan(id: string, actorId: string, now = new Date()) {
  const database = await db();
  const found = await database.execute({ sql: 'SELECT items_json, expires_at, consumed_at FROM media_quality_upgrade_plans WHERE id = ? AND actor_id = ?', args: [id, actorId] });
  const row = found.rows[0];
  if (!row || row.consumed_at || String(row.expires_at) <= now.toISOString()) return undefined;
  const consumed = await database.execute({ sql: 'UPDATE media_quality_upgrade_plans SET consumed_at = ? WHERE id = ? AND actor_id = ? AND consumed_at IS NULL', args: [now.toISOString(), id, actorId] });
  return consumed.rowsAffected === 1 ? JSON.parse(String(row.items_json)) as MediaQualityUpgradeItem[] : undefined;
}
export async function recordMediaQualityUpgrade(input: { planId: string; actorId: string; status: string; started: MediaQualityUpgradeItem[]; failed: Array<MediaQualityUpgradeItem & { error: string }> }) {
  const occurredAt = new Date().toISOString();
  await (await db()).execute({ sql: 'INSERT INTO media_quality_upgrade_events (occurred_at, plan_id, actor_id, status, started_json, failed_json) VALUES (?, ?, ?, ?, ?, ?)', args: [occurredAt, input.planId, input.actorId, input.status, JSON.stringify(input.started), JSON.stringify(input.failed)] });
  await appendFile(`${process.env.GARY_DATA_DIR || './data'}/media-quality-upgrades.jsonl`, `${JSON.stringify({ occurredAt, ...input })}\n`, 'utf8');
}
export function resetMediaQualityUpgradeStoreForTests() { client?.close(); client = undefined; initialized = undefined; }
