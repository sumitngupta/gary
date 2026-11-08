import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { garyConfig } from '../config/gary-config';

export type GaryOnboardingState = 'new' | 'introduced' | 'profile-started' | 'settled' | 'skipped';

export type GaryUserProfile = {
  resourceId: string;
  preferredName?: string;
  likes: string[];
  dislikes: string[];
  contentBoundaries: string[];
  onboardingState: GaryOnboardingState;
  recommendationDemoAt?: string;
  plexPersonalizationConsent: 'unknown' | 'granted' | 'declined';
  createdAt: string;
  updatedAt: string;
};

export type GaryPreferenceOperation = {
  action: 'add' | 'remove' | 'replace' | 'clear';
  field: 'likes' | 'dislikes' | 'contentBoundaries' | 'profile';
  values?: string[];
  replacementValues?: string[];
};

export function isGaryOnboardingGreeting(text: string) {
  return /^(?:hi|hello|hey|yo|hiya|howdy|good (?:morning|afternoon|evening))[!. ]*$/i.test(text.trim());
}

export function extractGaryOnboardingName(text: string) {
  const trimmed = text.trim();
  const explicit = trimmed.match(/^(?:my name is|call me|i(?:'m| am))\s+([\p{L}][\p{L}' -]{0,59})[.!]?$/iu)?.[1]?.trim();
  if (explicit) return explicit;
  if (!/^[\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'-]*){0,2}$/u.test(trimmed)) return undefined;
  if (/^(?:hi|hello|hey|yo|thanks|thank you|yes|no|okay|ok|sure|skip)$/i.test(trimmed)) return undefined;
  return trimmed;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gary_user_profiles (
  resource_id TEXT PRIMARY KEY,
  preferred_name TEXT,
  likes_json TEXT NOT NULL DEFAULT '[]',
  dislikes_json TEXT NOT NULL DEFAULT '[]',
  content_boundaries_json TEXT NOT NULL DEFAULT '[]',
  onboarding_state TEXT NOT NULL DEFAULT 'new',
  recommendation_demo_at TEXT,
  plex_personalization_consent TEXT NOT NULL DEFAULT 'unknown',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gary_supervisor_escalations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id TEXT NOT NULL,
  requester_name TEXT,
  summary TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  dedupe_key TEXT NOT NULL,
  whatsapp_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gary_preference_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id TEXT NOT NULL,
  source_message_id TEXT,
  operation_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gary_preference_event_source
  ON gary_preference_events(resource_id, source_message_id)
  WHERE source_message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_gary_open_escalation_dedupe
  ON gary_supervisor_escalations(resource_id, dedupe_key)
  WHERE status = 'open';
`;

let client: Client | undefined;
let initPromise: Promise<Client> | undefined;

async function db() {
  if (client) return client;
  initPromise ??= (async () => {
    const path = `${garyConfig().dataDir}/gary-profiles.db`;
    await mkdir(dirname(path), { recursive: true });
    const next = createClient({ url: `file:${path}`, timeout: 5000 });
    await next.executeMultiple(SCHEMA);
    client = next;
    return next;
  })();
  return initPromise;
}

function list(value: unknown) {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 30) : [];
  } catch { return []; }
}

function profile(row: Record<string, unknown>): GaryUserProfile {
  return {
    resourceId: String(row.resource_id),
    preferredName: row.preferred_name ? String(row.preferred_name) : undefined,
    likes: list(row.likes_json),
    dislikes: list(row.dislikes_json),
    contentBoundaries: list(row.content_boundaries_json),
    onboardingState: String(row.onboarding_state) as GaryOnboardingState,
    recommendationDemoAt: row.recommendation_demo_at ? String(row.recommendation_demo_at) : undefined,
    plexPersonalizationConsent: String(row.plex_personalization_consent) as GaryUserProfile['plexPersonalizationConsent'],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function getGaryUserProfile(resourceId: string) {
  const result = await (await db()).execute({ sql: 'SELECT * FROM gary_user_profiles WHERE resource_id = ?', args: [resourceId] });
  return result.rows[0] ? profile(result.rows[0] as Record<string, unknown>) : undefined;
}

export async function ensureGaryUserProfile(resourceId: string, state: GaryOnboardingState = 'new') {
  const now = new Date().toISOString();
  await (await db()).execute({
    sql: `INSERT INTO gary_user_profiles (resource_id, onboarding_state, created_at, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(resource_id) DO NOTHING`,
    args: [resourceId, state, now, now],
  });
  return (await getGaryUserProfile(resourceId))!;
}

export async function updateGaryUserProfile(resourceId: string, update: Partial<Pick<GaryUserProfile,
  'preferredName' | 'likes' | 'dislikes' | 'contentBoundaries' | 'onboardingState' | 'recommendationDemoAt' | 'plexPersonalizationConsent'>>) {
  const current = await ensureGaryUserProfile(resourceId);
  const next = { ...current, ...update, updatedAt: new Date().toISOString() };
  await (await db()).execute({
    sql: `UPDATE gary_user_profiles SET preferred_name = ?, likes_json = ?, dislikes_json = ?, content_boundaries_json = ?,
      onboarding_state = ?, recommendation_demo_at = ?, plex_personalization_consent = ?, updated_at = ? WHERE resource_id = ?`,
    args: [next.preferredName ?? null, JSON.stringify(next.likes), JSON.stringify(next.dislikes), JSON.stringify(next.contentBoundaries),
      next.onboardingState, next.recommendationDemoAt ?? null, next.plexPersonalizationConsent, next.updatedAt, resourceId],
  });
  return (await getGaryUserProfile(resourceId))!;
}

function preferenceItems(value: string) {
  return value.split(/,|\band\b/i)
    .map((item) => item.trim().replace(/^(?:that|the)\s+/i, '').replace(/[.!]+$/, ''))
    .filter(Boolean);
}

export function extractExplicitGaryPreferenceOperation(text: string): GaryPreferenceOperation | undefined {
  const normalized = text.trim();
  if (/^(?:please\s+)?(?:forget|clear|delete)\s+(?:everything\s+(?:you\s+know\s+)?about\s+my\s+(?:taste|preferences)|all\s+(?:of\s+)?my\s+(?:taste|preferences)|my\s+(?:taste|preferences))\.?$/i.test(normalized)) {
    return { action: 'clear', field: 'profile' };
  }
  const boundary = normalized.match(/^(?:please\s+)?(?:remember\s+(?:that\s+)?)?(?:never\s+recommend|avoid recommending)\s+(.+)$/i)?.[1];
  if (boundary) return { action: 'add', field: 'contentBoundaries', values: preferenceItems(boundary) };

  const remove = normalized.match(/^(?:please\s+)?(?:remove|forget)\s+(.+?)\s+from\s+my\s+(likes|dislikes|preferences|content boundaries|boundaries)\.?$/i);
  if (remove) return { action: 'remove', field: remove[2].toLowerCase() === 'dislikes' ? 'dislikes' : /boundar/i.test(remove[2]) ? 'contentBoundaries' : 'likes', values: preferenceItems(remove[1]) };
  const replace = normalized.match(/^(?:please\s+)?replace\s+(.+?)\s+with\s+(.+?)\s+in\s+my\s+(likes|dislikes|preferences|content boundaries|boundaries)\.?$/i);
  if (replace) return {
    action: 'replace', field: replace[3].toLowerCase() === 'dislikes' ? 'dislikes' : /boundar/i.test(replace[3]) ? 'contentBoundaries' : 'likes',
    values: preferenceItems(replace[1]), replacementValues: preferenceItems(replace[2]),
  };

  const addCommand = normalized.match(/^(?:please\s+)?add\s+(.+?)\s+to\s+my\s+(likes|dislikes|preferences|content boundaries|boundaries)\.?$/i);
  if (addCommand) return { action: 'add', field: addCommand[2].toLowerCase() === 'dislikes' ? 'dislikes' : /boundar/i.test(addCommand[2]) ? 'contentBoundaries' : 'likes', values: preferenceItems(addCommand[1]) };

  const dislikes = normalized.match(/^(?:please\s+)?(?:remember\s+(?:that\s+)?)?i\s+(?:(?:generally|usually)\s+)?(?:do\s+not\s+like|don't\s+like|dislike|hate|cannot stand|can't stand)\s+(.+)$/i);
  if (dislikes && /^(?:please\s+)?remember\b|\b(?:generally|usually|dislike|hate|cannot stand|can't stand)\b/i.test(normalized)) {
    return { action: 'add', field: 'dislikes', values: preferenceItems(dislikes[1]) };
  }
  const likes = normalized.match(/^(?:please\s+)?(?:remember\s+(?:that\s+)?)?i\s+(?:(?:generally|usually)\s+)?(?:like|love|enjoy)\s+(.+)$/i)?.[1]
    || normalized.match(/^i\s+also\s+(?:like|love|enjoy)\s+(.+)$/i)?.[1]
    || normalized.match(/^(?:the\s+)?genres?\s+i\s+(?:like|love|enjoy)\s+(?:include|are)\s*:?\s*(.+)$/i)?.[1]
    || normalized.match(/^my\s+favou?rite\s+(?:genres?|movies?|shows?)\s+(?:include|are)\s*:?\s*(.+)$/i)?.[1];
  if (likes && !/^(?:this|that|it|this (?:movie|show|one)|that (?:movie|show|one))\.?$/i.test(likes.trim())
    && (/^(?:please\s+)?remember\b|\b(?:also|generally|usually)\b/i.test(normalized) || /^(?:the\s+)?genres?|^my\s+favou?rite/i.test(normalized))) {
    return { action: 'add', field: 'likes', values: preferenceItems(likes) };
  }
  return undefined;
}

export function extractExplicitGaryPreferenceUpdate(text: string) {
  const operation = extractExplicitGaryPreferenceOperation(text);
  if (!operation || operation.action !== 'add' || operation.field === 'profile') return undefined;
  return { likes: operation.field === 'likes' ? operation.values || [] : [], dislikes: operation.field === 'dislikes' ? operation.values || [] : [] };
}

export async function persistExplicitGaryPreferences(resourceId: string, text: string, sourceMessageId?: string) {
  const operation = extractExplicitGaryPreferenceOperation(text);
  if (!operation) return undefined;
  const database = await db();
  if (sourceMessageId) {
    const prior = await database.execute({ sql: 'SELECT 1 FROM gary_preference_events WHERE resource_id = ? AND source_message_id = ? LIMIT 1', args: [resourceId, sourceMessageId] });
    if (prior.rows.length) return undefined;
  }
  const existing = await ensureGaryUserProfile(resourceId, 'profile-started');
  const update: Partial<Pick<GaryUserProfile, 'likes' | 'dislikes' | 'contentBoundaries' | 'onboardingState'>> = { onboardingState: 'profile-started' };
  if (operation.action === 'clear') {
    update.likes = []; update.dislikes = []; update.contentBoundaries = [];
  } else {
    const field = operation.field;
    if (field === 'profile') return undefined;
    const current = existing[field];
    const remove = new Set(operation.values || []);
    const retained = current.filter((item) => !remove.has(item));
    update[field] = operation.action === 'add'
      ? [...new Set([...current, ...(operation.values || [])])].slice(0, 30)
      : operation.action === 'replace'
        ? [...new Set([...retained, ...(operation.replacementValues || [])])].slice(0, 30)
        : retained;
  }
  const profile = await updateGaryUserProfile(resourceId, update);
  try {
    await database.execute({ sql: 'INSERT INTO gary_preference_events (resource_id, source_message_id, operation_json, created_at) VALUES (?, ?, ?, ?)', args: [resourceId, sourceMessageId ?? null, JSON.stringify(operation), new Date().toISOString()] });
  } catch (error) {
    if (sourceMessageId && error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) return undefined;
    throw error;
  }
  return { operation, profile };
}

export async function deleteGaryUserProfile(resourceId: string) {
  const database = await db();
  const profiles = await database.execute({ sql: 'DELETE FROM gary_user_profiles WHERE resource_id = ?', args: [resourceId] });
  await database.execute({ sql: 'DELETE FROM gary_preference_events WHERE resource_id = ?', args: [resourceId] });
  const escalations = await database.execute({ sql: 'DELETE FROM gary_supervisor_escalations WHERE resource_id = ?', args: [resourceId] });
  return profiles.rowsAffected + escalations.rowsAffected;
}

export async function createGaryEscalation(input: { resourceId: string; requesterName?: string; summary: string; reason: string; dedupeKey: string }) {
  const now = new Date().toISOString();
  try {
    const result = await (await db()).execute({
      sql: `INSERT INTO gary_supervisor_escalations (resource_id, requester_name, summary, reason, dedupe_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [input.resourceId, input.requesterName ?? null, input.summary, input.reason, input.dedupeKey, now, now],
    });
    return { created: true, id: Number(result.lastInsertRowid) };
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      const result = await (await db()).execute({ sql: `SELECT id, whatsapp_message_id FROM gary_supervisor_escalations WHERE resource_id = ? AND dedupe_key = ? AND status = 'open' ORDER BY id DESC LIMIT 1`, args: [input.resourceId, input.dedupeKey] });
      const row = result.rows[0];
      return { created: false, id: row ? Number(row.id) : undefined, delivered: Boolean(row?.whatsapp_message_id) };
    }
    throw error;
  }
}

export async function markGaryEscalationDelivered(id: number, messageId: string) {
  await (await db()).execute({ sql: 'UPDATE gary_supervisor_escalations SET whatsapp_message_id = ?, updated_at = ? WHERE id = ?', args: [messageId, new Date().toISOString(), id] });
}

export async function dispositionGaryEscalation(id: number, status: 'resolved' | 'dismissed') {
  const result = await (await db()).execute({
    sql: "UPDATE gary_supervisor_escalations SET status = ?, updated_at = ? WHERE id = ? AND status = 'open'",
    args: [status, new Date().toISOString(), id],
  });
  return result.rowsAffected === 1;
}

export function resetGaryUserProfileStoreForTests() { client = undefined; initPromise = undefined; }
