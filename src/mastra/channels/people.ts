import { createHash, randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createClient, type Client } from '@libsql/client';
import { garyConfig } from '../config/gary-config';
import { secretMatches } from '../config/secret-compare';

export const CHANNEL_NAMES = ['web', 'telegram', 'whatsapp'] as const;
export type ChannelName = (typeof CHANNEL_NAMES)[number];

export type GaryUser = { id: string; displayName: string; role: 'admin' | 'member'; createdAt: string };
export type ChannelIdentity = { channel: ChannelName; externalId: string; userId: GaryUser['id'] };
export type IdentityKey = Pick<ChannelIdentity, 'channel' | 'externalId'>;
export type ResourceId = `gary-user:${string}`;

/** What a code does when redeemed. A code never names a channel; it links whichever identity redeems it. */
export type CodeTarget =
  | { kind: 'new-user'; displayName: string; role: GaryUser['role'] }
  | { kind: 'existing-user'; userId: GaryUser['id'] };

export type Credential =
  | { kind: 'code'; text: string }
  | { kind: 'owner-password'; password: string };

export type EnrollOutcome =
  | { status: 'linked'; person: GaryUser; newUser: boolean }
  | { status: 'refused'; reason: 'no_code' | 'invalid_or_used' | 'bad_password' };

/** A web sign-in lives as long as its cookie. Chat-app identities never expire. */
export const WEB_SESSION_DAYS = 30;
const RESOURCE_PREFIX = 'gary-user:';
const LIVE_IDENTITY = '(i.expires_at IS NULL OR i.expires_at > ?)';
const CODE_PATTERN = /\bGARY-[A-F0-9]{12}\b/;

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS gary_users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gary_channel_identities (
  channel TEXT NOT NULL,
  external_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES gary_users(id) ON DELETE CASCADE,
  linked_at TEXT NOT NULL,
  expires_at TEXT,
  PRIMARY KEY (channel, external_id)
);
CREATE INDEX IF NOT EXISTS idx_gary_identities_user ON gary_channel_identities(user_id);
CREATE TABLE IF NOT EXISTS gary_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT REFERENCES gary_users(id) ON DELETE CASCADE,
  display_name TEXT,
  role TEXT CHECK (role IN ('admin', 'member')),
  bootstrap INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  redeemed_at TEXT,
  CHECK ((user_id IS NULL) = (display_name IS NOT NULL AND role IS NOT NULL))
);
`;

let client: Client | undefined;
let ready: Promise<Client> | undefined;

async function db() {
  if (client) return client;
  ready ??= (async () => {
    const dir = garyConfig().dataDir;
    await mkdir(dir, { recursive: true });
    const next = createClient({ url: `file:${dir}/gary-people.db`, timeout: 5000 });
    await next.executeMultiple(SCHEMA);
    client = next;
    return next;
  })();
  return ready;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const newId = () => `u_${randomBytes(8).toString('hex')}`;

function personFromRow(row: Record<string, unknown>): GaryUser {
  return { id: String(row.id), displayName: String(row.display_name), role: row.role === 'admin' ? 'admin' : 'member', createdAt: String(row.created_at) };
}

export function resourceIdFor(userId: GaryUser['id']): ResourceId {
  return `${RESOURCE_PREFIX}${userId}`;
}

export function userIdFromResource(resourceId: string | undefined) {
  return resourceId?.startsWith(RESOURCE_PREFIX) ? resourceId.slice(RESOURCE_PREFIX.length) : undefined;
}

/** A web session token never leaves the cookie; its hash is the browser's identity. */
export function webSubject(sessionToken: string) {
  return sha256(`web-session:${sessionToken}`);
}

export async function getPerson(userId: string): Promise<GaryUser | undefined> {
  const row = (await (await db()).execute({ sql: 'SELECT * FROM gary_users WHERE id = ?', args: [userId] })).rows[0];
  return row ? personFromRow(row) : undefined;
}

export async function personForResource(resourceId: string | undefined) {
  const userId = userIdFromResource(resourceId);
  return userId ? getPerson(userId) : undefined;
}

export async function identify(key: IdentityKey): Promise<GaryUser | undefined> {
  const row = (await (await db()).execute({
    sql: `SELECT u.* FROM gary_channel_identities i JOIN gary_users u ON u.id = i.user_id WHERE i.channel = ? AND i.external_id = ? AND ${LIVE_IDENTITY}`,
    args: [key.channel, key.externalId, new Date().toISOString()],
  })).rows[0];
  return row ? personFromRow(row) : undefined;
}

export async function linkedIdentities(userId: GaryUser['id']): Promise<ChannelIdentity[]> {
  const result = await (await db()).execute({
    sql: `SELECT channel, external_id, user_id FROM gary_channel_identities i WHERE user_id = ? AND ${LIVE_IDENTITY} ORDER BY linked_at`,
    args: [userId, new Date().toISOString()],
  });
  return result.rows.map((row) => ({ channel: String(row.channel) as ChannelName, externalId: String(row.external_id), userId: String(row.user_id) }));
}

export async function admins(): Promise<GaryUser[]> {
  const result = await (await db()).execute("SELECT * FROM gary_users WHERE role = 'admin' ORDER BY created_at");
  return result.rows.map(personFromRow);
}

export async function issueCode(target: CodeTarget, ttlHours = 72) {
  return insertCode(target, ttlHours, false);
}

async function insertCode(target: CodeTarget, ttlHours: number, bootstrap: boolean) {
  const code = `GARY-${randomBytes(6).toString('hex').toUpperCase()}`;
  const expiresAt = new Date(Date.now() + Math.max(1, ttlHours) * 3_600_000).toISOString();
  await (await db()).execute({
    sql: 'INSERT INTO gary_codes (code_hash, user_id, display_name, role, bootstrap, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    args: target.kind === 'existing-user'
      ? [sha256(code), target.userId, null, null, bootstrap ? 1 : 0, expiresAt]
      : [sha256(code), null, target.displayName.trim(), target.role, 0, expiresAt],
  });
  return { code, expiresAt };
}

function identityExpiry(key: IdentityKey) {
  return key.channel === 'web' ? new Date(Date.now() + WEB_SESSION_DAYS * 86_400_000).toISOString() : null;
}

/**
 * Links (channel, externalId) to a person. An identity that is already linked
 * returns that person without spending a code. A code links exactly one
 * identity: the claim and both inserts commit together or not at all.
 */
export async function enroll(key: IdentityKey, credential: Credential): Promise<EnrollOutcome> {
  const existing = await identify(key);
  if (existing) return { status: 'linked', person: existing, newUser: false };
  if (credential.kind === 'owner-password') {
    if (!secretMatches(credential.password, garyConfig().web.adminPassword)) return { status: 'refused', reason: 'bad_password' };
    const owner = (await admins())[0] ?? (await ensureOwner(), (await admins())[0]);
    await (await db()).execute({
      sql: 'INSERT INTO gary_channel_identities (channel, external_id, user_id, linked_at, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      args: [key.channel, key.externalId, owner.id, new Date().toISOString(), identityExpiry(key)],
    });
    return { status: 'linked', person: owner, newUser: false };
  }
  const code = credential.text.toUpperCase().match(CODE_PATTERN)?.[0];
  if (!code) return { status: 'refused', reason: 'no_code' };
  const now = new Date().toISOString();
  const tx = await (await db()).transaction('write');
  try {
    const row = (await tx.execute({
      sql: `UPDATE gary_codes SET redeemed_at = ? WHERE code_hash = ? AND redeemed_at IS NULL AND expires_at > ?
        RETURNING user_id, display_name, role`,
      args: [now, sha256(code), now],
    })).rows[0];
    if (!row) {
      await tx.rollback();
      return { status: 'refused', reason: 'invalid_or_used' };
    }
    const newUser = row.user_id === null;
    const userId = newUser ? newId() : String(row.user_id);
    if (newUser) {
      await tx.execute({
        sql: 'INSERT INTO gary_users (id, display_name, role, created_at) VALUES (?, ?, ?, ?)',
        args: [userId, String(row.display_name), String(row.role), now],
      });
    }
    await tx.execute({
      sql: 'INSERT INTO gary_channel_identities (channel, external_id, user_id, linked_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      args: [key.channel, key.externalId, userId, now, identityExpiry(key)],
    });
    await tx.commit();
    return { status: 'linked', person: (await getPerson(userId))!, newUser };
  } finally {
    tx.close();
  }
}

export async function unlink(key: IdentityKey) {
  await (await db()).execute({ sql: 'DELETE FROM gary_channel_identities WHERE channel = ? AND external_id = ?', args: [key.channel, key.externalId] });
}

/**
 * Boot step. Drops expired web sign-ins, then creates the owner admin on first boot. While no admin has a
 * linked identity it replaces any unredeemed bootstrap code with a fresh one
 * for the caller to print, so every boot converges on exactly one live code.
 */
export async function ensureOwner(): Promise<{ bootstrapCode?: string }> {
  const database = await db();
  await database.execute({ sql: 'DELETE FROM gary_channel_identities WHERE expires_at <= ?', args: [new Date().toISOString()] });
  let [owner] = await admins();
  if (!owner) {
    const id = newId();
    await database.execute({
      sql: "INSERT INTO gary_users (id, display_name, role, created_at) VALUES (?, ?, 'admin', ?)",
      args: [id, garyConfig().adminName, new Date().toISOString()],
    });
    owner = (await getPerson(id))!;
  }
  const linked = await database.execute("SELECT 1 FROM gary_channel_identities i JOIN gary_users u ON u.id = i.user_id WHERE u.role = 'admin' LIMIT 1");
  if (linked.rows.length) return {};
  await database.execute('DELETE FROM gary_codes WHERE bootstrap = 1 AND redeemed_at IS NULL');
  const { code } = await insertCode({ kind: 'existing-user', userId: owner.id }, 24, true);
  return { bootstrapCode: code };
}

export function resetPeopleStoreForTests() {
  client?.close();
  client = undefined;
  ready = undefined;
}
