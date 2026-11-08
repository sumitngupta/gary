import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createClient, type Client } from '@libsql/client';

export type GaryDeliveryKind = 'media.available' | 'media.issue' | 'media.radar' | 'supervisor.escalation';
let client: Client | undefined;
let initPromise: Promise<Client> | undefined;

async function db() {
  if (client) return client;
  initPromise ??= (async () => {
    const path = `${process.env.GARY_DATA_DIR || './data'}/gary-notifications.db`;
    await mkdir(dirname(path), { recursive: true });
    const next = createClient({ url: `file:${path}`, timeout: 5000 });
    await next.executeMultiple(`
      CREATE TABLE IF NOT EXISTS gary_notification_deliveries (
        idempotency_key TEXT PRIMARY KEY, resource_id TEXT NOT NULL, channel TEXT NOT NULL,
        kind TEXT NOT NULL, status TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0,
        provider_message_id TEXT, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        sent_at TEXT, delivered_at TEXT, read_at TEXT, failed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_gary_delivery_owner ON gary_notification_deliveries(resource_id, created_at);
      CREATE TABLE IF NOT EXISTS gary_notification_delivery_targets (
        idempotency_key TEXT NOT NULL, target_id TEXT NOT NULL,
        PRIMARY KEY (idempotency_key, target_id)
      );
    `);
    client = next;
    return next;
  })();
  return initPromise;
}

export async function claimGaryNotificationDelivery(input: { idempotencyKey: string; resourceId: string; channel: string; kind: GaryDeliveryKind; targetIds?: string[] }) {
  const database = await db();
  const now = new Date().toISOString();
  try {
    await database.execute({
      sql: `INSERT INTO gary_notification_deliveries
        (idempotency_key,resource_id,channel,kind,status,attempt_count,created_at,updated_at)
        VALUES (?,?,?,?,'sending',1,?,?)`,
      args: [input.idempotencyKey, input.resourceId, input.channel, input.kind, now, now],
    });
    for (const targetId of input.targetIds || []) await database.execute({
      sql: 'INSERT OR IGNORE INTO gary_notification_delivery_targets (idempotency_key,target_id) VALUES (?,?)',
      args: [input.idempotencyKey, targetId],
    });
    return { claimed: true, status: 'sending' as const };
  } catch (error) {
    if (!(error instanceof Error) || !/UNIQUE constraint failed/i.test(error.message)) throw error;
    const retry = await database.execute({
      sql: `UPDATE gary_notification_deliveries SET status='sending',attempt_count=attempt_count+1,error_code=NULL,updated_at=?
        WHERE idempotency_key=? AND status='failed' AND attempt_count < 3`,
      args: [now, input.idempotencyKey],
    });
    if (retry.rowsAffected === 1) return { claimed: true, status: 'sending' as const };
    const existing = await database.execute({ sql: 'SELECT status FROM gary_notification_deliveries WHERE idempotency_key=?', args: [input.idempotencyKey] });
    return { claimed: false, status: String(existing.rows[0]?.status || 'unknown') };
  }
}

export async function completeGaryNotificationDelivery(idempotencyKey: string, providerMessageId: string) {
  const now = new Date().toISOString();
  await (await db()).execute({
    sql: `UPDATE gary_notification_deliveries SET status='sent',provider_message_id=?,sent_at=?,updated_at=? WHERE idempotency_key=? AND status='sending'`,
    args: [providerMessageId, now, now, idempotencyKey],
  });
}

export async function failGaryNotificationDelivery(idempotencyKey: string, errorCode: string) {
  const now = new Date().toISOString();
  await (await db()).execute({
    sql: `UPDATE gary_notification_deliveries SET status='failed',error_code=?,failed_at=?,updated_at=? WHERE idempotency_key=? AND status='sending'`,
    args: [errorCode.slice(0, 120), now, now, idempotencyKey],
  });
}

export async function updateGaryNotificationReceipt(providerMessageId: string, status: 'sent' | 'delivered' | 'read' | 'failed', errorCode?: string) {
  const now = new Date().toISOString();
  const database = await db();
  const delivery = await database.execute({ sql: 'SELECT idempotency_key FROM gary_notification_deliveries WHERE provider_message_id=? LIMIT 1', args: [providerMessageId] });
  const idempotencyKey = typeof delivery.rows[0]?.idempotency_key === 'string' ? delivery.rows[0].idempotency_key : undefined;
  const column = status === 'delivered' ? 'delivered_at' : status === 'read' ? 'read_at' : status === 'failed' ? 'failed_at' : 'sent_at';
  const result = await database.execute({
    sql: `UPDATE gary_notification_deliveries SET status=?,${column}=?,error_code=COALESCE(?,error_code),updated_at=? WHERE provider_message_id=?`,
    args: [status, now, errorCode?.slice(0, 120) ?? null, now, providerMessageId],
  });
  const targets = idempotencyKey ? await database.execute({
    sql: 'SELECT target_id FROM gary_notification_delivery_targets WHERE idempotency_key=?', args: [idempotencyKey],
  }) : { rows: [] };
  return { updated: result.rowsAffected, targetIds: targets.rows.map((row) => String(row.target_id)) };
}

export async function listGaryNotificationDeliveries(resourceId: string, limit = 100) {
  const result = await (await db()).execute({
    sql: 'SELECT * FROM gary_notification_deliveries WHERE resource_id=? ORDER BY created_at DESC LIMIT ?',
    args: [resourceId, Math.min(500, Math.max(1, limit))],
  });
  return result.rows;
}

export async function listGaryNotificationDeliveriesForTarget(resourceId: string, targetId: string) {
  const result = await (await db()).execute({
    sql: `SELECT d.status,d.kind,d.created_at,d.sent_at,d.delivered_at,d.read_at,d.failed_at,d.attempt_count
      FROM gary_notification_deliveries d JOIN gary_notification_delivery_targets t USING(idempotency_key)
      WHERE d.resource_id=? AND t.target_id=? ORDER BY d.created_at ASC LIMIT 100`,
    args: [resourceId, targetId],
  });
  return result.rows;
}

export async function deleteGaryNotificationDeliveries(resourceId: string) {
  const database = await db();
  await database.execute({
    sql: 'DELETE FROM gary_notification_delivery_targets WHERE idempotency_key IN (SELECT idempotency_key FROM gary_notification_deliveries WHERE resource_id=?)',
    args: [resourceId],
  });
  return (await database.execute({ sql: 'DELETE FROM gary_notification_deliveries WHERE resource_id=?', args: [resourceId] })).rowsAffected;
}

export function resetGaryNotificationDeliveryStoreForTests() { client = undefined; initPromise = undefined; }
