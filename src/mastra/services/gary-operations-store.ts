import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient, type Client } from '@libsql/client';
import { pendingIntentRequiresExplicitText } from './gary-pending-intent-policy';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gary_pending_intents (
  id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  kind TEXT NOT NULL, question TEXT NOT NULL, options_json TEXT NOT NULL,
  payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  proposal_message_id TEXT, resolution_json TEXT, expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gary_pending_one_active
  ON gary_pending_intents(thread_id) WHERE status = 'pending';
CREATE TABLE IF NOT EXISTS gary_operation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, correlation_id TEXT NOT NULL,
  resource_id TEXT, thread_id TEXT, batch_id TEXT, request_id TEXT,
  phase TEXT NOT NULL, detail_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gary_events_correlation ON gary_operation_events(correlation_id, id);
CREATE TABLE IF NOT EXISTS gary_batches (
  id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL, status TEXT NOT NULL, total INTEGER NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
  input_json TEXT NOT NULL, results_json TEXT NOT NULL DEFAULT '[]',
  next_index INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gary_escalation_queue (
  id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL, owner TEXT NOT NULL, reason TEXT NOT NULL,
  error_json TEXT NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open', disposition TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gary_whatsapp_events (
  event_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, target_message_id TEXT,
  event_type TEXT NOT NULL, event_timestamp INTEGER NOT NULL,
  payload_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gary_whatsapp_target ON gary_whatsapp_events(thread_id, target_message_id, event_timestamp);
`;

let client: Client | undefined;
let initPromise: Promise<Client> | undefined;
async function db() {
  if (client) return client;
  initPromise ??= (async () => {
    const path = `${process.env.GARY_DATA_DIR || './data'}/gary-operations.db`;
    await mkdir(dirname(path), { recursive: true });
    const next = createClient({ url: `file:${path}`, timeout: 5_000 });
    await next.executeMultiple(SCHEMA);
    const timestamp = now();
    await next.execute({
      sql: `UPDATE gary_pending_intents SET status = 'expired', updated_at = ? WHERE status = 'pending' AND expires_at <= ?`,
      args: [timestamp, timestamp],
    });
    client = next;
    return next;
  })();
  return initPromise;
}

function parse<T>(value: unknown, fallback: T): T {
  try { return JSON.parse(String(value)) as T; } catch { return fallback; }
}
const now = () => new Date().toISOString();

export type PendingOption = { key: string; label: string; aliases?: string[]; value?: unknown };
export type PendingIntent = {
  id: string; resourceId: string; threadId: string; kind: string; question: string;
  options: PendingOption[]; payload: Record<string, unknown>; status: string;
  proposalMessageId?: string; resolution?: unknown; expiresAt: string; createdAt: string; updatedAt: string;
};

function pending(row: Record<string, unknown>): PendingIntent {
  return {
    id: String(row.id), resourceId: String(row.resource_id), threadId: String(row.thread_id),
    kind: String(row.kind), question: String(row.question), options: parse(row.options_json, []),
    payload: parse(row.payload_json, {}), status: String(row.status),
    proposalMessageId: row.proposal_message_id ? String(row.proposal_message_id) : undefined,
    resolution: row.resolution_json ? parse(row.resolution_json, undefined) : undefined,
    expiresAt: String(row.expires_at), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

export async function createPendingIntent(input: {
  resourceId: string; threadId: string; kind: string; question: string; options: PendingOption[];
  payload?: Record<string, unknown>; proposalMessageId?: string; ttlMs?: number; correlationId?: string;
}) {
  if (input.options.length < 1 || input.options.length > 20) throw new Error('A pending intent needs 1-20 options');
  const database = await db();
  const timestamp = now();
  await database.execute({ sql: `UPDATE gary_pending_intents SET status = 'superseded', updated_at = ? WHERE thread_id = ? AND status = 'pending'`, args: [timestamp, input.threadId] });
  const id = randomUUID();
  await database.execute({
    sql: `INSERT INTO gary_pending_intents (id, resource_id, thread_id, kind, question, options_json, payload_json, proposal_message_id, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, input.resourceId, input.threadId, input.kind, input.question.slice(0, 2_000), JSON.stringify(input.options),
      JSON.stringify({ ...(input.payload || {}), ...(input.correlationId && { _correlationId: input.correlationId }) }), input.proposalMessageId ?? null, new Date(Date.now() + (input.ttlMs ?? 86_400_000)).toISOString(), timestamp, timestamp],
  });
  const created = (await getPendingIntent(input.threadId))!;
  await appendOperationEvent({ correlationId: input.correlationId || created.id, resourceId: input.resourceId, threadId: input.threadId, phase: 'proposal-recorded', detail: { intentId: created.id, kind: input.kind } });
  return created;
}

function intentCorrelation(intent: PendingIntent) { return typeof intent.payload._correlationId === 'string' ? intent.payload._correlationId : intent.id; }

export async function getPendingIntent(threadId: string) {
  await (await db()).execute({ sql: `UPDATE gary_pending_intents SET status = 'expired', updated_at = ? WHERE thread_id = ? AND status = 'pending' AND expires_at <= ?`, args: [now(), threadId, now()] });
  const result = await (await db()).execute({ sql: `SELECT * FROM gary_pending_intents WHERE thread_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`, args: [threadId] });
  return result.rows[0] ? pending(result.rows[0] as Record<string, unknown>) : undefined;
}

export async function getPendingIntentForResource(resourceId: string) {
  const result = await (await db()).execute({
    sql: `SELECT * FROM gary_pending_intents
      WHERE resource_id = ? AND status = 'pending' AND expires_at > ?
      ORDER BY created_at DESC LIMIT 2`,
    args: [resourceId, now()],
  });
  if (result.rows.length !== 1) return undefined;
  return pending(result.rows[0] as Record<string, unknown>);
}

export async function attachPendingIntentProposalMessage(threadId: string, messageId: string, text: string) {
  const intent = await getPendingIntent(threadId);
  if (!intent || intent.proposalMessageId) return false;
  const questionWords = normalized(intent.question).split(' ').filter((word) => word.length > 3);
  const candidate = normalized(text);
  if (questionWords.length && questionWords.filter((word) => candidate.includes(word)).length < Math.min(2, questionWords.length)) return false;
  const result = await (await db()).execute({ sql: `UPDATE gary_pending_intents SET proposal_message_id = ?, updated_at = ? WHERE id = ? AND status = 'pending' AND proposal_message_id IS NULL`, args: [messageId, now(), intent.id] });
  if (result.rowsAffected) await appendOperationEvent({ correlationId: intentCorrelation(intent), resourceId: intent.resourceId, threadId, phase: 'proposal-delivered', detail: { proposalMessageId: messageId, intentId: intent.id } });
  return result.rowsAffected === 1;
}

export async function invalidatePendingIntentForMessage(threadId: string, messageId: string, reason: 'deleted' | 'superseded' = 'deleted') {
  const intent = await getPendingIntent(threadId);
  if (!intent || intent.proposalMessageId !== messageId) return false;
  await (await db()).execute({ sql: `UPDATE gary_pending_intents SET status = ?, updated_at = ? WHERE id = ?`, args: [reason, now(), intent.id] });
  await appendOperationEvent({ correlationId: intentCorrelation(intent), resourceId: intent.resourceId, threadId, phase: `proposal-${reason}`, detail: { proposalMessageId: messageId, intentId: intent.id } });
  return true;
}

function normalized(value: string) { return value.trim().toLocaleLowerCase().replace(/[.!?]+$/g, '').replace(/\s+/g, ' '); }
const ROUTINE_QUALIFIED_APPROVAL_KINDS = new Set(['batch-request-approval', 'tv-season-scope']);

function qualifiedPositiveAnswer(answer: string, intent: PendingIntent) {
  if (intent.options.length !== 1 || !ROUTINE_QUALIFIED_APPROVAL_KINDS.has(intent.kind)) return false;
  if (!/^(?:yes(?: please)?|yep|yeah|sure|ok(?:ay)?|go ahead|do it|that works|sounds good|i(?:'m| am) good with (?:it|that|those|them))\b/i.test(answer)) return false;
  return !/\b(?:do not|don't|dont|no longer|not anymore|cancel|stop|never mind|nevermind)\b/i.test(answer);
}

function numberedScopeMatch(answer: string, intent: PendingIntent) {
  if (intent.options.length < 2 || !/(?:batch|movie|media).*(?:scope|choice)|(?:scope|choice).*(?:batch|movie|media)/i.test(intent.kind)) return undefined;
  const requestedCount = answer.match(/\b(?:all|essential|best)?\s*(\d{1,2})\b/i)?.[1];
  if (!requestedCount) return undefined;
  const matches = intent.options.filter((option) => new RegExp(`\\b${requestedCount}\\b`).test(`${option.key} ${option.label} ${(option.aliases || []).join(' ')}`));
  return matches.length === 1 ? matches[0] : undefined;
}

function embeddedRoutineScopeMatch(answer: string, intent: PendingIntent) {
  if (!/(?:batch|movie|media).*(?:scope|choice)|(?:scope|choice).*(?:batch|movie|media)/i.test(intent.kind)) return undefined;
  if (/\b(?:do not|don't|dont|cancel|stop|never mind|nevermind|not all)\b/i.test(answer)) return undefined;
  const requestOptions = intent.options.filter((option) => {
    const value = option.value;
    return value && typeof value === 'object' && 'intendedAction' in value && value.intendedAction === 'request';
  });
  const matches = requestOptions.filter((option) => {
    const phrases = [option.key, option.label, ...(option.aliases || [])]
      .map(normalized)
      .filter((phrase) => phrase.length >= 3);
    return phrases.some((phrase) => new RegExp(`(?:^|\\b)${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|\\b)`, 'i').test(answer));
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function tvSeasonScopeMatch(answer: string, intent: PendingIntent) {
  if (intent.kind !== 'tv-season-scope') return undefined;
  if (/\b(?:all|every(?:thing| season)?)\b/i.test(answer)) {
    return intent.options.find((option) => option.value && typeof option.value === 'object' && 'seasons' in option.value && option.value.seasons === 'all');
  }
  if (!/\bseasons?\b/i.test(answer) && !/\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:,|&|and|through|to|-)\s*(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i.test(answer)) return undefined;
  const seasonNumbers = new Map([
    ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5],
    ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10],
  ]);
  const requested = [...new Set(
    [...answer.matchAll(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/gi)]
      .map((match) => /^\d+$/.test(match[1]) ? Number(match[1]) : seasonNumbers.get(match[1].toLowerCase()))
      .filter((season): season is number => season !== undefined),
  )].sort((a, b) => a - b);
  if (!requested.length) return undefined;
  return intent.options.find((option) => {
    const value = option.value;
    if (!value || typeof value !== 'object' || !('seasons' in value) || !Array.isArray(value.seasons)) return false;
    const seasons = [...new Set(value.seasons.filter((season): season is number => typeof season === 'number'))].sort((a, b) => a - b);
    return seasons.length === requested.length && seasons.every((season, index) => season === requested[index]);
  });
}

export function bindShortAnswer(text: string, intent: PendingIntent) {
  const answer = normalized(text);
  if (!answer) return { status: 'not-short' as const };
  const positive = new Set(['yes', 'yes please', 'y', 'yep', 'yeah', 'sure', 'ok', 'okay', 'okay please', 'go ahead', 'sounds good', 'do it', 'please', '👍', '✅']);
  const negative = new Set(['no', 'n', 'nope', 'cancel', 'never mind', 'nevermind', '👎', '❌']);
  if (positive.has(answer) && intent.options.length === 1) return { status: 'resolved' as const, option: intent.options[0] };
  if (qualifiedPositiveAnswer(answer, intent)) return { status: 'resolved' as const, option: intent.options[0] };
  if (negative.has(answer)) return { status: 'declined' as const };
  const seasonScope = tvSeasonScopeMatch(answer, intent);
  if (seasonScope) return { status: 'resolved' as const, option: seasonScope };
  const numberedScope = numberedScopeMatch(answer, intent);
  if (numberedScope) return { status: 'resolved' as const, option: numberedScope };
  const embeddedScope = embeddedRoutineScopeMatch(answer, intent);
  if (embeddedScope) return { status: 'resolved' as const, option: embeddedScope };
  if (answer.split(' ').length > 8) return { status: 'not-short' as const };
  const allAliases = (option: PendingOption) => [option.key, option.label, ...(option.aliases || [])].map(normalized);
  const approvalSubject = answer
    .replace(/^(?:i\s+)?(?:approve|request|get)\s+(?:the\s+)?/i, '')
    .replace(/^(?:please\s+)?(?:go ahead (?:with\s+)?)?(?:and\s+)?/i, '')
    .trim();
  let matches = intent.options.filter((option) => allAliases(option).includes(answer));
  if (!matches.length && approvalSubject && approvalSubject !== answer) {
    matches = intent.options.filter((option) => allAliases(option).includes(approvalSubject));
  }
  if (!matches.length && intent.kind === 'batch-request-approval' && /^(?:them|these|all|the batch|those)$/.test(approvalSubject)) {
    matches = intent.options.filter((option) => /approve|request/i.test(`${option.key} ${option.label}`));
  }
  if (matches.length === 1) return { status: 'resolved' as const, option: matches[0] };
  if (['both', 'all', 'these', 'the rest', 'rest'].includes(answer)) {
    return intent.options.length > 1 ? { status: 'resolved-many' as const, options: intent.options } : { status: 'resolved' as const, option: intent.options[0] };
  }
  const clarification = pendingIntentRequiresExplicitText(intent)
    ? `I still have this pending: ${intent.question} Please send an explicit text reply choosing ${intent.options.map((option) => option.label).join(' or ')}.`
    : `I still have this pending: ${intent.question} I couldn't confidently tell which you meant. You can answer naturally with ${intent.options.map((option) => option.label).join(' or ')}.`;
  return {
    status: 'ambiguous' as const,
    clarification,
  };
}

export async function resolvePendingIntent(threadId: string, answer: string, targetMessageId?: string, source: 'message' | 'quoted-reply' | 'reaction' = 'message') {
  const intent = await getPendingIntent(threadId);
  if (!intent) return { status: 'none' as const };
  if (targetMessageId && intent.proposalMessageId !== targetMessageId) {
    return { status: 'target-mismatch' as const, intent, clarification: 'That reply or reaction does not target the currently pending question, so I did not use it as approval.' };
  }
  if (source === 'reaction' && pendingIntentRequiresExplicitText(intent)) {
    await appendOperationEvent({ correlationId: intentCorrelation(intent), resourceId: intent.resourceId, threadId, phase: 'reaction-acknowledged-sensitive', detail: { targetMessageId, intentId: intent.id } });
    return { status: 'acknowledgement-only' as const, intent, clarification: 'Please send an explicit text reply to approve this sensitive action.' };
  }
  const binding = bindShortAnswer(answer, intent);
  if (binding.status === 'resolved' || binding.status === 'resolved-many' || binding.status === 'declined') {
    await (await db()).execute({ sql: `UPDATE gary_pending_intents SET status = ?, resolution_json = ?, updated_at = ? WHERE id = ?`,
      args: [binding.status === 'declined' ? 'declined' : 'resolved', JSON.stringify(binding), now(), intent.id] });
    await appendOperationEvent({ correlationId: intentCorrelation(intent), resourceId: intent.resourceId, threadId, phase: binding.status === 'declined' ? 'proposal-declined' : 'proposal-approved', detail: { binding: binding.status, targetMessageId, intentId: intent.id } });
    if (binding.status !== 'declined' && intent.kind === 'batch-request-approval') {
      const selected = binding.status === 'resolved' ? [binding.option] : binding.options;
      for (const option of selected) {
        const value = option.value;
        const batchId = typeof value === 'string'
          ? value
          : value && typeof value === 'object' && 'batchId' in value && typeof value.batchId === 'string'
            ? value.batchId
            : undefined;
        if (!batchId) continue;
        const batch = await getOperationBatch(batchId);
        if (!batch || batch.resourceId !== intent.resourceId || batch.threadId !== intent.threadId) continue;
        const approved = await (await db()).execute({
          sql: `UPDATE gary_batches SET status = 'approved', updated_at = ? WHERE id = ? AND status = 'ready-for-approval'`,
          args: [now(), batchId],
        });
        if (approved.rowsAffected) await appendOperationEvent({
          correlationId: batch.correlationId, resourceId: batch.resourceId, threadId: batch.threadId,
          batchId, phase: 'batch-approved', detail: { intentId: intent.id, source },
        });
      }
    }
  }
  return { ...binding, intent };
}

export async function resolvePendingIntentForResource(resourceId: string, answer: string) {
  const intent = await getPendingIntentForResource(resourceId);
  if (!intent) return { status: 'none' as const };
  return resolvePendingIntent(intent.threadId, answer);
}

export function pendingIntentExecutionInstruction(resolution: Awaited<ReturnType<typeof resolvePendingIntent>>) {
  if (resolution.status !== 'resolved') return undefined;
  const value = resolution.option.value;
  if (resolution.intent.kind === 'supervisor-escalation' && value && typeof value === 'object'
    && 'summary' in value && typeof value.summary === 'string' && 'reason' in value && typeof value.reason === 'string') {
    return `Deterministic authorized supervisor escalation: call escalateToGarySupervisor now with ${JSON.stringify({ summary: value.summary, reason: value.reason, userConsented: true })}. Report the tool's delivery receipt; do not merely acknowledge or ask again.`;
  }
  if (value && typeof value === 'object' && 'intendedAction' in value && value.intendedAction === 'request' && 'titles' in value && Array.isArray(value.titles) && value.titles.length >= 2) {
    const requester = typeof resolution.intent.payload.requester === 'string' ? resolution.intent.payload.requester : 'admin';
    return `Deterministic authorized media scope: call planMediaRequestBatch now with ${JSON.stringify({ titles: value.titles, requester, completeSetConfirmed: true, authorization: 'explicit-request' })}, then immediately call createMediaRequestBatch with the returned batch ID. This exact scope selection is already authorization; do not ask for approval again.`;
  }
  if (value && typeof value === 'object' && 'intendedAction' in value && value.intendedAction === 'request' && 'title' in value && typeof value.title === 'string') {
    return `Deterministic authorized exact-title selection: call createMediaRequest now with exactly ${JSON.stringify(value)}. The user's clarification selected the title and carries the original request authorization; do not ask for confirmation again.`;
  }
  if (resolution.intent.kind === 'tv-season-scope') {
    return value && typeof value === 'object'
      ? `Deterministic selected TV season scope: call createMediaRequest now with exactly ${JSON.stringify(value)}. The season choice is already bound; do not ask for confirmation or scope again.`
      : undefined;
  }
  if (resolution.intent.kind === 'collection-pack-import-approval') {
    const planId = value && typeof value === 'object' && 'collectionPackPlanId' in value && typeof value.collectionPackPlanId === 'string'
      ? value.collectionPackPlanId
      : undefined;
    return planId
      ? `Deterministic approved collection-pack execution: call executeCollectionPackRepair now with planId ${planId}. Do not rebuild the plan, search for sibling titles, or ask for approval again.`
      : undefined;
  }
  if (resolution.intent.kind === 'plex-collection-change-approval') {
    const previewId = value && typeof value === 'object' && 'plexCollectionPreviewId' in value && typeof value.plexCollectionPreviewId === 'string'
      ? value.plexCollectionPreviewId : undefined;
    return previewId ? `Deterministic approved Plex collection execution: call executePlexCollectionChange now with previewId ${previewId}. Do not rebuild or alter the preview, request missing titles, or ask for approval again.` : undefined;
  }
  if (resolution.intent.kind === 'gary-list-publish-approval') {
    const previewId = value && typeof value === 'object' && 'garyListPublishPreviewId' in value && typeof value.garyListPublishPreviewId === 'string'
      ? value.garyListPublishPreviewId : undefined;
    return previewId ? `Deterministic approved list publish: call manageGaryLists now with ${JSON.stringify({ action: 'confirm-publish', previewId })}. Do not change the shelf title, rebuild the preview, or ask for approval again.` : undefined;
  }
  if (resolution.intent.kind !== 'batch-request-approval') return undefined;
  const batchId = typeof value === 'string'
    ? value
    : value && typeof value === 'object' && 'batchId' in value && typeof value.batchId === 'string'
      ? value.batchId
      : undefined;
  if (!batchId) return undefined;
  return `Deterministic approved-batch execution: call createMediaRequestBatch now with batchId ${batchId}. Do not call planMediaRequestBatch, do not create a replacement preview, and do not ask for approval again.`;
}

export async function appendOperationEvent(input: { correlationId: string; phase: string; resourceId?: string; threadId?: string; batchId?: string; requestId?: string; detail?: unknown }) {
  await (await db()).execute({ sql: `INSERT INTO gary_operation_events (correlation_id, resource_id, thread_id, batch_id, request_id, phase, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [input.correlationId, input.resourceId ?? null, input.threadId ?? null, input.batchId ?? null, input.requestId ?? null, input.phase, JSON.stringify(input.detail ?? {}), now()] });
}

export async function getOperationTimeline(correlationId: string) {
  const result = await (await db()).execute({ sql: `SELECT * FROM gary_operation_events WHERE correlation_id = ? ORDER BY id`, args: [correlationId] });
  return result.rows.map((row) => ({ phase: String(row.phase), detail: parse(row.detail_json, {}), createdAt: String(row.created_at), batchId: row.batch_id ? String(row.batch_id) : undefined, requestId: row.request_id ? String(row.request_id) : undefined }));
}

export async function createOperationBatch(input: { resourceId: string; threadId: string; requests: unknown[]; correlationId?: string }) {
  const id = randomUUID(); const correlationId = input.correlationId || randomUUID(); const timestamp = now();
  await (await db()).execute({ sql: `INSERT INTO gary_batches (id, resource_id, thread_id, correlation_id, status, total, input_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'planned', ?, ?, ?, ?)`,
    args: [id, input.resourceId, input.threadId, correlationId, input.requests.length, JSON.stringify(input.requests), timestamp, timestamp] });
  await appendOperationEvent({ correlationId, resourceId: input.resourceId, threadId: input.threadId, batchId: id, phase: 'batch-planned', detail: { total: input.requests.length } });
  return { id, correlationId };
}

export async function getOperationBatch(id: string) {
  const result = await (await db()).execute({ sql: 'SELECT * FROM gary_batches WHERE id = ?', args: [id] });
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return { id: String(row.id), resourceId: String(row.resource_id), threadId: String(row.thread_id), correlationId: String(row.correlation_id), status: String(row.status), total: Number(row.total), completed: Number(row.completed), failed: Number(row.failed), nextIndex: Number(row.next_index), requests: parse<unknown[]>(row.input_json, []), results: parse<unknown[]>(row.results_json, []) };
}

export async function checkpointOperationBatch(id: string, update: { status: string; nextIndex: number; results: unknown[]; failed: number }) {
  await (await db()).execute({ sql: `UPDATE gary_batches SET status = ?, next_index = ?, completed = ?, failed = ?, results_json = ?, updated_at = ? WHERE id = ?`,
    args: [update.status, update.nextIndex, update.results.length - update.failed, update.failed, JSON.stringify(update.results), now(), id] });
}

export async function enqueueGaryEscalation(input: { resourceId: string; threadId: string; correlationId: string; owner?: string; reason: string; error?: unknown }) {
  const id = randomUUID(); const timestamp = now();
  await (await db()).execute({ sql: `INSERT INTO gary_escalation_queue (id, resource_id, thread_id, correlation_id, owner, reason, error_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, input.resourceId, input.threadId, input.correlationId, input.owner || 'admin', input.reason, JSON.stringify(input.error ?? {}), timestamp, timestamp] });
  await appendOperationEvent({ correlationId: input.correlationId, resourceId: input.resourceId, threadId: input.threadId, phase: 'escalated', detail: { escalationId: id, reason: input.reason } });
  return id;
}

export async function recordGaryEscalationDelivery(id: string, delivery: { status: 'sent' | 'failed' | 'unavailable'; messageId?: string; error?: string }) {
  const database = await db();
  const existing = await database.execute({ sql: 'SELECT correlation_id, resource_id, thread_id, error_json FROM gary_escalation_queue WHERE id = ?', args: [id] });
  const row = existing.rows[0] as Record<string, unknown> | undefined;
  if (!row) return false;
  const detail = { ...parse<Record<string, unknown>>(row.error_json, {}), delivery: { status: delivery.status, messageId: delivery.messageId, error: delivery.error?.slice(0, 500), at: now() } };
  await database.execute({ sql: 'UPDATE gary_escalation_queue SET error_json = ?, updated_at = ? WHERE id = ?', args: [JSON.stringify(detail), now(), id] });
  await appendOperationEvent({ correlationId: String(row.correlation_id), resourceId: String(row.resource_id), threadId: String(row.thread_id), phase: `escalation-delivery-${delivery.status}`, detail: { escalationId: id, messageId: delivery.messageId, error: delivery.error?.slice(0, 500) } });
  return true;
}

export async function listGaryEscalationQueue(input: { status?: string; owner?: string; limit?: number } = {}) {
  const clauses: string[] = []; const args: Array<string | number> = [];
  if (input.status) { clauses.push('status = ?'); args.push(input.status); }
  if (input.owner) { clauses.push('owner = ?'); args.push(input.owner); }
  args.push(Math.min(Math.max(input.limit || 50, 1), 200));
  const result = await (await db()).execute({ sql: `SELECT * FROM gary_escalation_queue ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`, args });
  return result.rows.map((row) => ({ id: String(row.id), resourceId: String(row.resource_id), threadId: String(row.thread_id), correlationId: String(row.correlation_id), owner: String(row.owner), reason: String(row.reason), error: parse(row.error_json, {}), retryCount: Number(row.retry_count), status: String(row.status), disposition: row.disposition ? String(row.disposition) : undefined, createdAt: String(row.created_at), updatedAt: String(row.updated_at) }));
}

export async function dispositionGaryEscalation(id: string, input: { status: 'acknowledged' | 'resolved' | 'dismissed' | 'retrying'; disposition?: string }) {
  const result = await (await db()).execute({ sql: `UPDATE gary_escalation_queue SET status = ?, disposition = ?, retry_count = retry_count + ?, updated_at = ? WHERE id = ?`, args: [input.status, input.disposition?.slice(0, 1_000) ?? null, input.status === 'retrying' ? 1 : 0, now(), id] });
  return result.rowsAffected === 1;
}

export async function recordWhatsAppEvent(input: { eventId: string; threadId: string; targetMessageId?: string; eventType: 'message' | 'edit' | 'delete' | 'reaction-add' | 'reaction-remove'; timestamp: number; payload?: unknown }) {
  const database = await db();
  const duplicate = await database.execute({ sql: 'SELECT event_id FROM gary_whatsapp_events WHERE event_id = ?', args: [input.eventId] });
  if (duplicate.rows.length) return { accepted: false, reason: 'duplicate' as const };
  if (input.targetMessageId) {
    const latest = await database.execute({ sql: `SELECT event_timestamp, event_type FROM gary_whatsapp_events WHERE thread_id = ? AND target_message_id = ? ORDER BY event_timestamp DESC LIMIT 1`, args: [input.threadId, input.targetMessageId] });
    const row = latest.rows[0];
    if (row && Number(row.event_timestamp) >= input.timestamp) return { accepted: false, reason: 'stale' as const };
    if (row && String(row.event_type) === 'delete' && input.eventType !== 'delete') return { accepted: false, reason: 'target-deleted' as const };
  }
  await database.execute({ sql: `INSERT INTO gary_whatsapp_events (event_id, thread_id, target_message_id, event_type, event_timestamp, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [input.eventId, input.threadId, input.targetMessageId ?? null, input.eventType, input.timestamp, JSON.stringify(input.payload ?? {}), now()] });
  return { accepted: true };
}

export async function deleteGaryOperationsForResource(resourceId: string) {
  const database = await db(); let count = 0;
  for (const table of ['gary_pending_intents', 'gary_operation_events', 'gary_batches', 'gary_escalation_queue']) {
    count += (await database.execute({ sql: `DELETE FROM ${table} WHERE resource_id = ?`, args: [resourceId] })).rowsAffected;
  }
  return count;
}

export function resetGaryOperationsStoreForTests() { client = undefined; initPromise = undefined; }
