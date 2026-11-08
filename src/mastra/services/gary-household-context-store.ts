import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { garyConfig } from '../config/gary-config';

export type GaryHouseholdContext = { viewerAges: number[]; sharedLikes: string[]; contentBoundaries: string[]; intensityPolicy: string; updatedAt?: string };
let client: Client | undefined; let initPromise: Promise<Client> | undefined;
async function db() {
  if (client) return client;
  initPromise ??= (async () => { const path = `${garyConfig().dataDir}/gary-household-context.db`; await mkdir(dirname(path), { recursive: true }); const next = createClient({ url: `file:${path}`, timeout: 5_000 }); await next.execute(`CREATE TABLE IF NOT EXISTS gary_household_context (id INTEGER PRIMARY KEY CHECK(id=1), viewer_ages_json TEXT NOT NULL, shared_likes_json TEXT NOT NULL, boundaries_json TEXT NOT NULL, intensity_policy TEXT NOT NULL, updated_at TEXT NOT NULL)`); client = next; return next; })();
  return initPromise;
}
const parse = <T>(value: unknown, fallback: T) => { try { return JSON.parse(String(value)) as T; } catch { return fallback; } };
export async function getGaryHouseholdContext(): Promise<GaryHouseholdContext> {
  const result = await (await db()).execute('SELECT * FROM gary_household_context WHERE id=1'); const row = result.rows[0];
  return row ? { viewerAges: parse(row.viewer_ages_json, []), sharedLikes: parse(row.shared_likes_json, []), contentBoundaries: parse(row.boundaries_json, []), intensityPolicy: String(row.intensity_policy), updatedAt: String(row.updated_at) }
    : { viewerAges: [], sharedLikes: [], contentBoundaries: [], intensityPolicy: 'Describe material intensity or content concerns honestly; never infer age-safety without evidence.' };
}
export async function updateGaryHouseholdContext(update: Partial<Omit<GaryHouseholdContext, 'updatedAt'>>) {
  const current = await getGaryHouseholdContext(); const next = { ...current, ...update, updatedAt: new Date().toISOString() };
  await (await db()).execute({ sql: `INSERT INTO gary_household_context(id,viewer_ages_json,shared_likes_json,boundaries_json,intensity_policy,updated_at) VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET viewer_ages_json=excluded.viewer_ages_json,shared_likes_json=excluded.shared_likes_json,boundaries_json=excluded.boundaries_json,intensity_policy=excluded.intensity_policy,updated_at=excluded.updated_at`, args: [JSON.stringify([...new Set(next.viewerAges)].sort((a,b)=>a-b).slice(0,20)), JSON.stringify([...new Set(next.sharedLikes)].slice(0,30)), JSON.stringify([...new Set(next.contentBoundaries)].slice(0,30)), next.intensityPolicy.slice(0,500), next.updatedAt] });
  return getGaryHouseholdContext();
}
export function resetGaryHouseholdContextStoreForTests() { client = undefined; initPromise = undefined; }
