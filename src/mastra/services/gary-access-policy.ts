import { createHash, randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createClient, type Client } from '@libsql/client';

export type GaryPolicyContext = {
  toolName: string;
  input: unknown;
  resourceId?: string;
  threadId?: string;
  channel?: string;
  actorId?: string;
  eventId?: string;
};

export type GaryPolicyDecision = {
  allowed: boolean;
  reason: string;
  reasonCode: string;
  channel: string;
  actorId?: string;
  mutation: boolean;
  category: 'read' | 'web' | 'schedule' | 'request' | 'repair' | 'watch' | 'list';
};

const MUTATING_ACTIONS: Record<string, Set<string> | true> = {
  createMediaRequest: true,
  createMediaRequestBatch: true,
  triggerArrMediaFreshSearch: true,
  refreshPlexLibrary: true,
  createMediaAvailabilityWatch: true,
  manageMediaAvailabilityWatches: new Set(['cancel']),
  manageMediaRadarSubscriptions: new Set(['create', 'update', 'pause', 'resume', 'run', 'cancel']),
  recordMediaRadarDelivery: true,
  manageGaryPrivacy: new Set(['delete']),
  manageGaryProfile: new Set(['update', 'skip-onboarding', 'mark-recommendations-shown']),
  manageGaryLists: new Set(['add', 'remove', 'rename', 'delete-list', 'publish', 'confirm-publish', 'unpublish']),
  manageGaryHouseholdContext: new Set(['update']),
  escalateToGarySupervisor: true,
  manageGaryViewingProfile: new Set(['connect', 'refresh', 'disconnect']),
  executeMediaQualityUpgrade: true,
  executeCollectionPackRepair: true,
  executePlexCollectionChange: true,
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gary_policy_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL,
  channel TEXT NOT NULL,
  actor_id TEXT,
  event_id TEXT,
  operation_key TEXT,
  tool_name TEXT NOT NULL,
  category TEXT NOT NULL,
  mutation INTEGER NOT NULL,
  allowed INTEGER NOT NULL,
  reason TEXT NOT NULL,
  reason_code TEXT NOT NULL DEFAULT 'legacy'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gary_policy_replay
  ON gary_policy_events(channel, actor_id, event_id, operation_key)
  WHERE event_id IS NOT NULL AND operation_key IS NOT NULL AND mutation = 1 AND allowed = 1;
CREATE INDEX IF NOT EXISTS idx_gary_policy_quota
  ON gary_policy_events(channel, actor_id, category, occurred_at);
CREATE TABLE IF NOT EXISTS gary_inbound_events (
  channel TEXT NOT NULL,
  event_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (channel, event_id)
);
CREATE TABLE IF NOT EXISTS gary_whatsapp_enrollments (
  id TEXT PRIMARY KEY,
  invitee_name TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  claimed_at TEXT,
  claimed_actor_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gary_authorized_actors (
  actor_id TEXT PRIMARY KEY,
  enrollment_id TEXT NOT NULL,
  authorized_at TEXT NOT NULL
);
`;

let client: Client | undefined;
let initPromise: Promise<Client> | undefined;

function dataDir() {
  return process.env.GARY_DATA_DIR || './data';
}

async function db() {
  if (client) return client;
  initPromise ??= (async () => {
    const path = `${dataDir()}/gary-policy.db`;
    await mkdir(dirname(path), { recursive: true });
    const next = createClient({ url: `file:${path}`, timeout: 5000 });
    await next.executeMultiple(SCHEMA);
    const columns = await next.execute('PRAGMA table_info(gary_policy_events)');
    if (!columns.rows.some((row) => row.name === 'reason_code')) {
      await next.execute("ALTER TABLE gary_policy_events ADD COLUMN reason_code TEXT NOT NULL DEFAULT 'legacy'");
    }
    client = next;
    return next;
  })();
  return initPromise;
}

function flag(name: string, fallback: boolean) {
  const value = process.env[name];
  return value === undefined ? fallback : value === 'true';
}

function csv(name: string) {
  return new Set((process.env[name] || '').split(',').map((value) => value.trim()).filter(Boolean));
}

function normalizeWhatsAppActor(value: string) {
  const digits = value.replace(/\D/g, '');
  return digits ? `+${digits}` : value;
}

function enrollmentCodeHash(code: string) {
  return createHash('sha256').update(code.trim().toUpperCase()).digest('hex');
}

export async function createGaryWhatsAppEnrollment(input: { name: string; email: string; ttlHours?: number }) {
  const database = await db();
  const code = `GARY-${randomBytes(6).toString('hex').toUpperCase()}`;
  const id = `gary_enroll_${randomBytes(12).toString('hex')}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + Math.max(1, input.ttlHours ?? 72) * 3_600_000);
  await database.execute({
    sql: `INSERT INTO gary_whatsapp_enrollments
      (id, invitee_name, email_hash, code_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      input.name.trim(),
      createHash('sha256').update(input.email.trim().toLowerCase()).digest('hex'),
      enrollmentCodeHash(code),
      expiresAt.toISOString(),
      now.toISOString(),
    ],
  });
  return { id, code, expiresAt: expiresAt.toISOString() };
}

export async function isGaryWhatsAppActorAuthorized(actorId: string) {
  const normalized = normalizeWhatsAppActor(actorId);
  if ([...csv('GARY_WHATSAPP_ALLOWED_USERS')].map(normalizeWhatsAppActor).includes(normalized)) return true;
  const result = await (await db()).execute({
    sql: 'SELECT 1 FROM gary_authorized_actors WHERE actor_id = ? LIMIT 1',
    args: [normalized],
  });
  return result.rows.length > 0;
}

export async function claimGaryWhatsAppEnrollment(actorId: string, message: string) {
  const match = message.toUpperCase().match(/\bGARY-[A-F0-9]{12}\b/);
  if (!match) return { accepted: false, reasonCode: 'code_missing' as const };
  const database = await db();
  const normalized = normalizeWhatsAppActor(actorId);
  const existing = await database.execute({
    sql: 'SELECT enrollment_id FROM gary_authorized_actors WHERE actor_id = ? LIMIT 1',
    args: [normalized],
  });
  if (existing.rows.length) return { accepted: true, reasonCode: 'already_authorized' as const };

  const now = new Date().toISOString();
  const enrollment = await database.execute({
    sql: `SELECT id, invitee_name FROM gary_whatsapp_enrollments
      WHERE code_hash = ? AND claimed_at IS NULL AND expires_at > ? LIMIT 1`,
    args: [enrollmentCodeHash(match[0]), now],
  });
  const row = enrollment.rows[0];
  if (!row) return { accepted: false, reasonCode: 'code_invalid_or_expired' as const };

  const claimed = await database.execute({
    sql: `UPDATE gary_whatsapp_enrollments SET claimed_at = ?, claimed_actor_id = ?
      WHERE id = ? AND claimed_at IS NULL AND expires_at > ?`,
    args: [now, normalized, String(row.id), now],
  });
  if (claimed.rowsAffected !== 1) return { accepted: false, reasonCode: 'code_already_claimed' as const };
  await database.execute({
    sql: 'INSERT INTO gary_authorized_actors (actor_id, enrollment_id, authorized_at) VALUES (?, ?, ?)',
    args: [normalized, String(row.id), now],
  });
  return { accepted: true, reasonCode: 'enrolled' as const, preferredName: String(row.invitee_name) };
}

function inputAction(input: unknown) {
  if (!input || typeof input !== 'object') return undefined;
  const action = (input as Record<string, unknown>).action;
  return typeof action === 'string' ? action : undefined;
}

function isMutation(toolName: string, input: unknown) {
  const rule = MUTATING_ACTIONS[toolName];
  return rule === true || (rule instanceof Set && rule.has(inputAction(input) || ''));
}

function category(toolName: string): GaryPolicyDecision['category'] {
  if (toolName === 'webSearch' || toolName === 'webFetch' || toolName === 'extractLinkedVisualList') return 'web';
  if (toolName === 'manageMediaRadarSubscriptions' || toolName === 'recordMediaRadarDelivery') return 'schedule';
  if (toolName === 'createMediaRequest' || toolName === 'createMediaRequestBatch') return 'request';
  if (toolName === 'triggerArrMediaFreshSearch' || toolName === 'refreshPlexLibrary' || toolName === 'executeMediaQualityUpgrade' || toolName === 'executeCollectionPackRepair' || toolName === 'executePlexCollectionChange') return 'repair';
  if (toolName.includes('AvailabilityWatch')) return 'watch';
  if (toolName === 'manageGaryLists') return 'list';
  return 'read';
}

function inferChannel(context: GaryPolicyContext) {
  if (context.channel) return context.channel.toLowerCase();
  const id = context.resourceId || context.threadId || '';
  return id.includes(':') ? id.split(':', 1)[0].toLowerCase() : 'internal';
}

function inferActor(context: GaryPolicyContext, channel: string) {
  if (context.actorId) return context.actorId;
  if (context.resourceId?.startsWith(`${channel}:`)) return context.resourceId.slice(channel.length + 1);
  return undefined;
}

function operationKey(toolName: string, input: unknown) {
  return createHash('sha256').update(`${toolName}:${JSON.stringify(input)}`).digest('hex').slice(0, 24);
}

function quotaFor(categoryName: GaryPolicyDecision['category']) {
  const specific = process.env[`GARY_WHATSAPP_DAILY_${categoryName.toUpperCase()}_LIMIT`];
  // List edits are cheap personal bookkeeping, so they get a roomier default
  // than mutations that touch the media server or other people.
  const fallback = categoryName === 'list' ? '100' : process.env.GARY_WHATSAPP_DAILY_MUTATION_LIMIT || '10';
  const parsed = Number(specific || fallback);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10;
}

function hourlyWebQuota() {
  const parsed = Number(process.env.GARY_WHATSAPP_HOURLY_WEB_LIMIT || '100');
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 100;
}

export async function enforceGaryAccessPolicy(context: GaryPolicyContext): Promise<GaryPolicyDecision> {
  const channel = inferChannel(context);
  const actorId = inferActor(context, channel);
  const mutation = isMutation(context.toolName, context.input);
  const categoryName = category(context.toolName);
  let allowed = true;
  let reason = 'non-WhatsApp channel uses existing policy';
  let reasonCode = 'non_whatsapp_allowed';

  const scheduledRadar = context.threadId?.startsWith('gary-radar:') === true;
  const radarTools = new Set(['webSearch', 'webFetch', 'checkMediaStatuses', 'planMediaRadar', 'recordMediaRadarDelivery']);
  if (scheduledRadar && !radarTools.has(context.toolName)) {
    allowed = false;
    reason = 'Scheduled recommendation radar is read-only except for its exact delivery record';
    reasonCode = 'radar_mutation_denied';
  }

  if (allowed && channel === 'whatsapp') {
    const normalizedActorId = actorId ? normalizeWhatsAppActor(actorId) : undefined;
    const actorAuthorized = normalizedActorId
      ? await isGaryWhatsAppActorAuthorized(normalizedActorId)
      : false;
    if (!flag('GARY_WHATSAPP_ENABLED', false)) {
      allowed = false; reason = 'WhatsApp access is disabled'; reasonCode = 'whatsapp_disabled';
    } else if (!normalizedActorId || !actorAuthorized) {
      allowed = false; reason = 'WhatsApp actor is not allowlisted'; reasonCode = 'actor_not_allowlisted';
    } else if (mutation && !flag('GARY_WHATSAPP_MUTATIONS_ENABLED', false)) {
      allowed = false; reason = 'WhatsApp mutations are disabled'; reasonCode = 'mutations_disabled';
    } else if (categoryName === 'web' && !flag('GARY_WHATSAPP_WEB_ENABLED', true)) {
      allowed = false; reason = 'WhatsApp web research is disabled'; reasonCode = 'web_disabled';
    } else if (categoryName === 'schedule' && !flag('GARY_WHATSAPP_SCHEDULING_ENABLED', false)) {
      allowed = false; reason = 'WhatsApp scheduling is disabled'; reasonCode = 'scheduling_disabled';
    } else if (mutation && !context.eventId && !(scheduledRadar && context.toolName === 'recordMediaRadarDelivery')) {
      allowed = false; reason = 'A trusted WhatsApp event id is required for mutations'; reasonCode = 'trusted_event_required';
    } else {
      reason = 'WhatsApp actor and operation are allowed'; reasonCode = 'allowed';
    }
  }

  const database = await db();
  if (allowed && channel === 'whatsapp' && mutation && actorId) {
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const count = await database.execute({
      sql: 'SELECT COUNT(*) AS count FROM gary_policy_events WHERE channel = ? AND actor_id = ? AND category = ? AND mutation = 1 AND allowed = 1 AND occurred_at >= ?',
      args: [channel, actorId, categoryName, since],
    });
    if (Number(count.rows[0]?.count || 0) >= quotaFor(categoryName)) {
      allowed = false; reason = `Daily ${categoryName} quota reached`; reasonCode = 'daily_mutation_quota_reached';
    }
  }

  if (allowed && channel === 'whatsapp' && categoryName === 'web' && actorId) {
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const count = await database.execute({
      sql: 'SELECT COUNT(*) AS count FROM gary_policy_events WHERE channel = ? AND actor_id = ? AND category = ? AND allowed = 1 AND occurred_at >= ?',
      args: [channel, actorId, 'web', since],
    });
    if (Number(count.rows[0]?.count || 0) >= hourlyWebQuota()) {
      allowed = false; reason = 'Hourly web research safety limit reached'; reasonCode = 'hourly_web_quota_reached';
    }
  }

  const decision: GaryPolicyDecision = { allowed, reason, reasonCode, channel, actorId, mutation, category: categoryName };
  try {
    await database.execute({
      sql: 'INSERT INTO gary_policy_events (occurred_at, channel, actor_id, event_id, operation_key, tool_name, category, mutation, allowed, reason, reason_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      args: [new Date().toISOString(), channel, actorId ?? null, context.eventId ?? null, mutation ? operationKey(context.toolName, context.input) : null, context.toolName, categoryName, mutation ? 1 : 0, allowed ? 1 : 0, reason, reasonCode],
    });
  } catch (error) {
    if (mutation && error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      return { ...decision, allowed: false, reason: 'Duplicate WhatsApp event operation blocked', reasonCode: 'duplicate_event_operation' };
    }
    throw error;
  }

  return decision;
}

export async function listGaryPolicyEvents(actorId: string, limit = 100) {
  const result = await (await db()).execute({
    sql: 'SELECT occurred_at, channel, actor_id, event_id, tool_name, category, mutation, allowed, reason, reason_code FROM gary_policy_events WHERE actor_id = ? ORDER BY id DESC LIMIT ?',
    args: [actorId, Math.min(500, Math.max(1, limit))],
  });
  return result.rows;
}

export async function deleteGaryPolicyEvents(actorId: string) {
  const database = await db();
  const policy = await database.execute({ sql: 'DELETE FROM gary_policy_events WHERE actor_id = ?', args: [actorId] });
  const inbound = await database.execute({ sql: 'DELETE FROM gary_inbound_events WHERE actor_id = ?', args: [actorId] });
  const normalized = normalizeWhatsAppActor(actorId);
  const authorization = await database.execute({ sql: 'DELETE FROM gary_authorized_actors WHERE actor_id = ?', args: [normalized] });
  const enrollments = await database.execute({ sql: 'DELETE FROM gary_whatsapp_enrollments WHERE claimed_actor_id = ?', args: [normalized] });
  return {
    policyEvents: policy.rowsAffected,
    inboundEvents: inbound.rowsAffected,
    authorizationRecords: authorization.rowsAffected + enrollments.rowsAffected,
  };
}

function hourlyInboundQuota() {
  const parsed = Number(process.env.GARY_WHATSAPP_HOURLY_INBOUND_LIMIT || '120');
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 120;
}

export async function claimGaryInboundEvent(channel: string, eventId: string, actorId: string) {
  const database = await db();
  const replay = await database.execute({
    sql: 'SELECT COUNT(*) AS count FROM gary_inbound_events WHERE channel = ? AND event_id = ?',
    args: [channel, eventId],
  });
  if (Number(replay.rows[0]?.count || 0) > 0) {
    return { accepted: false, firstForActor: false, reasonCode: 'duplicate_event' as const };
  }
  const prior = await database.execute({
    sql: 'SELECT COUNT(*) AS count FROM gary_inbound_events WHERE channel = ? AND actor_id = ?',
    args: [channel, actorId],
  });
  const firstForActor = Number(prior.rows[0]?.count || 0) === 0;
  if (channel === 'whatsapp') {
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const recent = await database.execute({
      sql: 'SELECT COUNT(*) AS count FROM gary_inbound_events WHERE channel = ? AND actor_id = ? AND received_at >= ?',
      args: [channel, actorId, since],
    });
    if (Number(recent.rows[0]?.count || 0) >= hourlyInboundQuota()) {
      return { accepted: false, firstForActor, reasonCode: 'hourly_inbound_quota_reached' as const };
    }
  }
  try {
    await database.execute({
      sql: 'INSERT INTO gary_inbound_events (channel, event_id, actor_id, received_at) VALUES (?, ?, ?, ?)',
      args: [channel, eventId, actorId, new Date().toISOString()],
    });
    return { accepted: true, firstForActor, reasonCode: 'accepted' as const };
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) return { accepted: false, firstForActor: false, reasonCode: 'duplicate_event' as const };
    throw error;
  }
}

export async function getGaryPolicyHealth() {
  const database = await db();
  const since = new Date(Date.now() - 3_600_000).toISOString();
  const [denials, inbound] = await Promise.all([
    database.execute({
      sql: 'SELECT reason_code, COUNT(*) AS count FROM gary_policy_events WHERE allowed = 0 AND occurred_at >= ? GROUP BY reason_code',
      args: [since],
    }),
    database.execute({
      sql: 'SELECT COUNT(*) AS count FROM gary_inbound_events WHERE received_at >= ?',
      args: [since],
    }),
  ]);
  return {
    globalConcurrency: positiveIntegerEnv('GARY_WHATSAPP_GLOBAL_CONCURRENCY', 3),
    hourlyInboundLimit: positiveIntegerEnv('GARY_WHATSAPP_HOURLY_INBOUND_LIMIT', 120),
    hourlyWebLimit: positiveIntegerEnv('GARY_WHATSAPP_HOURLY_WEB_LIMIT', 100),
    inboundEventsLastHour: Number(inbound.rows[0]?.count || 0),
    denialsLastHour: Object.fromEntries(denials.rows.map((row) => [String(row.reason_code), Number(row.count || 0)])),
  };
}

function positiveIntegerEnv(name: string, fallback: number) {
  const value = Number(process.env[name] || fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function resetGaryPolicyClientForTests() {
  client = undefined;
  initPromise = undefined;
}
