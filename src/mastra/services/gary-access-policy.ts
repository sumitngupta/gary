import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createClient, type Client } from '@libsql/client';
import { garyConfig } from '../config/gary-config';
import type { ChannelName, GaryUser } from '../channels/people';

/** Who is calling a tool. `undefined` (no identified person) is always denied. */
export type Caller =
  | { kind: 'person'; person: GaryUser; channel: ChannelName; eventId?: string }
  | { kind: 'radar'; person: GaryUser };

export type GaryPolicyDecision = {
  allowed: boolean;
  reason: string;
  reasonCode: string;
  userId?: string;
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
  manageGaryAccess: new Set(['invite', 'link-code']),
  escalateToGarySupervisor: true,
  manageGaryViewingProfile: new Set(['connect', 'refresh', 'disconnect']),
  executeMediaQualityUpgrade: true,
  executeCollectionPackRepair: true,
  executePlexCollectionChange: true,
};

const ADMIN_ONLY: Record<string, Set<string> | true> = {
  reviewCollectionPackRepair: true,
  executeCollectionPackRepair: true,
  manageGaryHouseholdContext: new Set(['update']),
  manageGaryAccess: new Set(['invite']),
};

const RADAR_TOOLS = new Set(['webSearch', 'webFetch', 'checkMediaStatuses', 'planMediaRadar', 'recordMediaRadarDelivery']);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gary_policy_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL,
  channel TEXT NOT NULL,
  user_id TEXT,
  event_id TEXT,
  operation_key TEXT,
  tool_name TEXT NOT NULL,
  category TEXT NOT NULL,
  mutation INTEGER NOT NULL,
  allowed INTEGER NOT NULL,
  reason TEXT NOT NULL,
  reason_code TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gary_policy_replay
  ON gary_policy_events(user_id, event_id, operation_key)
  WHERE event_id IS NOT NULL AND operation_key IS NOT NULL AND mutation = 1 AND allowed = 1;
CREATE INDEX IF NOT EXISTS idx_gary_policy_quota
  ON gary_policy_events(user_id, category, occurred_at);
CREATE TABLE IF NOT EXISTS gary_inbound_events (
  channel TEXT NOT NULL,
  event_id TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (channel, event_id)
);
CREATE INDEX IF NOT EXISTS idx_gary_inbound_actor ON gary_inbound_events(actor_key, received_at);
`;

let client: Client | undefined;
let initPromise: Promise<Client> | undefined;

async function db() {
  if (client) return client;
  initPromise ??= (async () => {
    const dir = garyConfig().dataDir;
    await mkdir(dir, { recursive: true });
    const next = createClient({ url: `file:${dir}/gary-policy.db`, timeout: 5000 });
    await next.executeMultiple(SCHEMA);
    client = next;
    return next;
  })();
  return initPromise;
}

function matches(rule: Set<string> | true | undefined, input: unknown) {
  if (rule === true) return true;
  const action = input && typeof input === 'object' ? (input as Record<string, unknown>).action : undefined;
  return rule instanceof Set && typeof action === 'string' && rule.has(action);
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

function operationKey(toolName: string, input: unknown) {
  return createHash('sha256').update(`${toolName}:${JSON.stringify(input)}`).digest('hex').slice(0, 24);
}

async function countSince(userId: string, categoryName: string, sinceMs: number, mutationsOnly: boolean) {
  const result = await (await db()).execute({
    sql: `SELECT COUNT(*) AS count FROM gary_policy_events
      WHERE user_id = ? AND category = ? AND allowed = 1 AND occurred_at >= ?${mutationsOnly ? ' AND mutation = 1' : ''}`,
    args: [userId, categoryName, new Date(Date.now() - sinceMs).toISOString()],
  });
  return Number(result.rows[0]?.count || 0);
}

async function decide(caller: Caller | undefined, toolName: string, input: unknown, mutation: boolean, categoryName: GaryPolicyDecision['category']) {
  const deny = (reasonCode: string, reason: string) => ({ allowed: false, reasonCode, reason });
  if (!caller) return deny('unknown_identity', 'Only people enrolled with Gary can use its tools');
  if (caller.kind === 'radar') {
    return RADAR_TOOLS.has(toolName)
      ? { allowed: true, reasonCode: 'allowed', reason: 'Scheduled radar delivery tool' }
      : deny('radar_mutation_denied', 'Scheduled recommendation radar is read-only except for its exact delivery record');
  }
  if (matches(ADMIN_ONLY[toolName], input) && caller.person.role !== 'admin') {
    return deny('admin_only', `Only an admin can use ${toolName} for that`);
  }
  if (mutation && !caller.eventId) return deny('trusted_event_required', 'A trusted chat message id is required for changes');
  if (caller.person.role === 'admin') return { allowed: true, reasonCode: 'allowed', reason: 'Admin' };
  const { policy } = garyConfig();
  if (mutation) {
    const limit = categoryName === 'list' ? policy.dailyListLimit : policy.dailyMutationLimit;
    if (await countSince(caller.person.id, categoryName, 86_400_000, true) >= limit) return deny('daily_mutation_quota_reached', `Daily ${categoryName} quota reached`);
  }
  if (categoryName === 'web' && await countSince(caller.person.id, 'web', 3_600_000, false) >= policy.hourlyWebLimit) {
    return deny('hourly_web_quota_reached', 'Hourly web research safety limit reached');
  }
  return { allowed: true, reasonCode: 'allowed', reason: 'Member operation is within quota' };
}

export async function enforceGaryAccessPolicy(input: { caller: Caller | undefined; toolName: string; input: unknown }): Promise<GaryPolicyDecision> {
  const { caller, toolName } = input;
  const mutation = matches(MUTATING_ACTIONS[toolName], input.input);
  const categoryName = category(toolName);
  const verdict = await decide(caller, toolName, input.input, mutation, categoryName);
  const eventId = caller?.kind === 'person' ? caller.eventId : undefined;
  const decision: GaryPolicyDecision = { ...verdict, userId: caller?.person.id, mutation, category: categoryName };
  try {
    await (await db()).execute({
      sql: 'INSERT INTO gary_policy_events (occurred_at, channel, user_id, event_id, operation_key, tool_name, category, mutation, allowed, reason, reason_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      args: [new Date().toISOString(), caller?.kind === 'person' ? caller.channel : caller?.kind ?? 'unknown', caller?.person.id ?? null, eventId ?? null, mutation ? operationKey(toolName, input.input) : null, toolName, categoryName, mutation ? 1 : 0, verdict.allowed ? 1 : 0, verdict.reason, verdict.reasonCode],
    });
  } catch (error) {
    if (mutation && error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      return { ...decision, allowed: false, reason: 'Duplicate chat event operation blocked', reasonCode: 'duplicate_event_operation' };
    }
    throw error;
  }
  return decision;
}

/**
 * Records one inbound chat event. `actorKey` is the user id for known people
 * and `channel:externalId` for unknown senders, so enrollment attempts are
 * rate limited too.
 */
export async function claimGaryInboundEvent(input: { channel: string; eventId: string; actorKey: string }) {
  const database = await db();
  const replay = await database.execute({ sql: 'SELECT 1 FROM gary_inbound_events WHERE channel = ? AND event_id = ?', args: [input.channel, input.eventId] });
  if (replay.rows.length) return { accepted: false, firstForActor: false, reasonCode: 'duplicate_event' as const };
  const prior = await database.execute({ sql: 'SELECT received_at FROM gary_inbound_events WHERE actor_key = ? ORDER BY received_at DESC LIMIT ?', args: [input.actorKey, garyConfig().policy.hourlyInboundLimit] });
  const firstForActor = prior.rows.length === 0;
  const since = new Date(Date.now() - 3_600_000).toISOString();
  if (prior.rows.filter((row) => String(row.received_at) >= since).length >= garyConfig().policy.hourlyInboundLimit) {
    return { accepted: false, firstForActor, reasonCode: 'hourly_inbound_quota_reached' as const };
  }
  try {
    await database.execute({
      sql: 'INSERT INTO gary_inbound_events (channel, event_id, actor_key, received_at) VALUES (?, ?, ?, ?)',
      args: [input.channel, input.eventId, input.actorKey, new Date().toISOString()],
    });
    return { accepted: true, firstForActor, reasonCode: 'accepted' as const };
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) return { accepted: false, firstForActor: false, reasonCode: 'duplicate_event' as const };
    throw error;
  }
}

export async function listGaryPolicyEvents(userId: string, limit = 100) {
  const result = await (await db()).execute({
    sql: 'SELECT occurred_at, channel, user_id, event_id, tool_name, category, mutation, allowed, reason, reason_code FROM gary_policy_events WHERE user_id = ? ORDER BY id DESC LIMIT ?',
    args: [userId, Math.min(500, Math.max(1, limit))],
  });
  return result.rows;
}

export async function deleteGaryPolicyEvents(userId: string) {
  const database = await db();
  const policy = await database.execute({ sql: 'DELETE FROM gary_policy_events WHERE user_id = ?', args: [userId] });
  const inbound = await database.execute({ sql: 'DELETE FROM gary_inbound_events WHERE actor_key = ?', args: [userId] });
  return { policyEvents: policy.rowsAffected, inboundEvents: inbound.rowsAffected };
}

export function resetGaryPolicyClientForTests() {
  client?.close();
  client = undefined;
  initPromise = undefined;
}
