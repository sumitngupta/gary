import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { garyConfig, requireService } from '../config/gary-config';

type TautulliUser = { user_id: number; username: string; friendly_name?: string; keep_history?: number; is_active?: number };
type History = { user_id: number; media_type: string; title: string; grandparent_title?: string; rating_key: number; grandparent_rating_key?: number; guid?: string; year?: number; started: number; percent_complete?: number; watched_status?: number; play_duration?: number };
type Metadata = { title?: string; year?: string | number; media_type?: string; genres?: string[]; directors?: string[]; writers?: string[]; guids?: string[] };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gary_plex_links (resource_id TEXT PRIMARY KEY, tautulli_user_id INTEGER NOT NULL, tautulli_username TEXT NOT NULL, consented_at TEXT NOT NULL, last_synced_at TEXT, taste_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS gary_viewing_titles (resource_id TEXT NOT NULL, title_key TEXT NOT NULL, title TEXT NOT NULL, year INTEGER, media_type TEXT NOT NULL, guid TEXT, play_count INTEGER NOT NULL, completed_count INTEGER NOT NULL, max_percent REAL NOT NULL, last_watched_at TEXT NOT NULL, genres_json TEXT NOT NULL DEFAULT '[]', PRIMARY KEY(resource_id,title_key));
CREATE INDEX IF NOT EXISTS idx_gary_viewing_resource ON gary_viewing_titles(resource_id,last_watched_at);
`;
let client: Client | undefined;
let initPromise: Promise<Client> | undefined;
async function db() { if (client) return client; initPromise ??= (async () => { const path = `${garyConfig().dataDir}/gary-viewing.db`; await mkdir(dirname(path), { recursive: true }); const next = createClient({ url: `file:${path}`, timeout: 5000 }); await next.executeMultiple(SCHEMA); client = next; return next; })(); return initPromise; }

async function api<T>(cmd: string, params: Record<string, string | number> = {}) {
  const { url: base, apiKey: key } = requireService('tautulli');
  const url = new URL('/api/v2', base); url.searchParams.set('apikey', key); url.searchParams.set('cmd', cmd);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Tautulli returned HTTP ${response.status}`);
  const body = await response.json() as { response?: { result?: string; message?: string; data?: T } };
  if (body.response?.result !== 'success') throw new Error(body.response?.message || 'Tautulli request failed');
  return body.response.data as T;
}

export async function listTautulliUsers() {
  const users = await api<TautulliUser[]>('get_users');
  return users.filter((user) => user.user_id > 0 && user.is_active !== 0).map((user) => ({ id: user.user_id, username: user.username, name: user.friendly_name || user.username, historyEnabled: user.keep_history !== 0 }));
}

function normalizedName(value: string) { return value.toLowerCase().replace(/[^a-z0-9]/g, ''); }

export async function findTautulliUserMatches(name: string) {
  const query = normalizedName(name);
  if (query.length < 2) return [];
  const users = await listTautulliUsers();
  return users.map((user) => {
    const username = normalizedName(user.username); const friendly = normalizedName(user.name);
    const score = username === query || friendly === query ? 100
      : username.startsWith(query) || friendly.startsWith(query) ? 80
      : username.includes(query) || friendly.includes(query) ? 60 : 0;
    return { ...user, score };
  }).filter((user) => user.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
}

export async function connectTautulliUser(resourceId: string, username: string) {
  const users = await listTautulliUsers();
  const match = users.find((user) => user.username.toLowerCase() === username.toLowerCase() || user.name.toLowerCase() === username.toLowerCase());
  if (!match) return undefined;
  const now = new Date().toISOString(); const database = await db();
  const prior = await database.execute({ sql: 'SELECT * FROM gary_plex_links WHERE tautulli_user_id=? AND resource_id<>? LIMIT 1', args: [match.id, resourceId] });
  const old = prior.rows[0];
  if (old) {
    await database.batch([
      { sql: 'DELETE FROM gary_viewing_titles WHERE resource_id=?', args: [resourceId] },
      { sql: 'UPDATE OR REPLACE gary_viewing_titles SET resource_id=? WHERE resource_id=?', args: [resourceId, String(old.resource_id)] },
      { sql: 'DELETE FROM gary_plex_links WHERE resource_id=?', args: [String(old.resource_id)] },
      { sql: `INSERT INTO gary_plex_links(resource_id,tautulli_user_id,tautulli_username,consented_at,last_synced_at,taste_json)
        VALUES(?,?,?,?,?,?) ON CONFLICT(resource_id) DO UPDATE SET tautulli_user_id=excluded.tautulli_user_id,
        tautulli_username=excluded.tautulli_username,consented_at=excluded.consented_at,last_synced_at=excluded.last_synced_at,
        taste_json=excluded.taste_json`, args: [resourceId, match.id, match.username, now, old.last_synced_at ?? null, String(old.taste_json || '{}')] },
    ], 'write');
    const requestTaste = createClient({ url: `file:${garyConfig().dataDir}/gary-request-tastes.db`, timeout: 5000 });
    await requestTaste.execute({ sql: 'UPDATE request_taste_profiles SET resource_id=?,identity_confidence=? WHERE resource_id=? OR lower(seerr_username)=lower(?)', args: [resourceId, 'verified-plex-gary-link', String(old.resource_id), match.username] }).catch(() => undefined);
    requestTaste.close();
  } else {
    await database.execute({ sql: `INSERT INTO gary_plex_links(resource_id,tautulli_user_id,tautulli_username,consented_at,taste_json) VALUES(?,?,?,?, '{}') ON CONFLICT(resource_id) DO UPDATE SET tautulli_user_id=excluded.tautulli_user_id,tautulli_username=excluded.tautulli_username,consented_at=excluded.consented_at,last_synced_at=NULL,taste_json='{}'`, args: [resourceId, match.id, match.username, now] });
  }
  return match;
}

export async function reconcileGaryViewingProfile(resourceId: string, name: string) {
  const matches = await findTautulliUserMatches(name);
  const best = matches[0];
  if (!best) return { status: 'not-found' as const };
  if (best.score < 80 || (matches[1] && best.score <= matches[1].score)) return { status: 'ambiguous' as const };
  const connected = await connectTautulliUser(resourceId, best.username);
  if (!connected) return { status: 'not-found' as const };
  return { status: 'connected' as const, username: connected.username, viewing: await refreshViewingProfile(resourceId) };
}

export async function getViewingLink(resourceId: string) { const result = await (await db()).execute({ sql: 'SELECT * FROM gary_plex_links WHERE resource_id=?', args: [resourceId] }); return result.rows[0]; }
export async function disconnectViewingHistory(resourceId: string) { const database = await db(); const titles = await database.execute({ sql: 'DELETE FROM gary_viewing_titles WHERE resource_id=?', args: [resourceId] }); const link = await database.execute({ sql: 'DELETE FROM gary_plex_links WHERE resource_id=?', args: [resourceId] }); return titles.rowsAffected + link.rowsAffected; }

function titleKey(title: string, year?: number) { return `${title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}:${year || ''}`; }
export async function refreshViewingProfile(resourceId: string) {
  const link = await getViewingLink(resourceId); if (!link) throw new Error('No Plex viewing profile is connected');
  const data = await api<{ data: History[] }>('get_history', { user_id: Number(link.tautulli_user_id), length: 500, order_column: 'date', order_dir: 'desc' });
  const cutoff = Date.now() / 1000 - 548 * 86400;
  const groups = new Map<string, { title: string; year?: number; mediaType: string; guid?: string; ratingKey: number; events: History[] }>();
  for (const event of data.data.filter((item) => item.started >= cutoff && ['movie', 'episode'].includes(item.media_type))) {
    const title = event.media_type === 'episode' ? event.grandparent_title || event.title : event.title;
    const ratingKey = event.media_type === 'episode' ? Number(event.grandparent_rating_key) : Number(event.rating_key);
    const key = titleKey(title, event.year); const prior = groups.get(key);
    if (prior) prior.events.push(event); else groups.set(key, { title, year: event.year, mediaType: event.media_type === 'episode' ? 'tv' : 'movie', guid: event.guid, ratingKey, events: [event] });
  }
  const database = await db(); await database.execute({ sql: 'DELETE FROM gary_viewing_titles WHERE resource_id=?', args: [resourceId] });
  const genreScores = new Map<string, number>(); let completedTitles = 0; let repeatTitles = 0;
  for (const [key, item] of groups) {
    const metadata: Metadata = await api<Metadata>('get_metadata', { rating_key: item.ratingKey }).catch(() => ({}));
    const maxPercent = Math.max(...item.events.map((event) => Number(event.percent_complete || 0)));
    const completed = item.events.filter((event) => Number(event.percent_complete || 0) >= 85 || Number(event.watched_status || 0) >= 1).length;
    if (completed) completedTitles++; if (item.events.length > 1) repeatTitles++;
    const weight = completed ? 2 + Math.min(2, item.events.length - 1) : maxPercent >= 50 ? 0.5 : 0.1;
    for (const genre of (metadata.genres || []).slice(0, 12)) genreScores.set(genre, (genreScores.get(genre) || 0) + weight);
    await database.execute({ sql: 'INSERT INTO gary_viewing_titles(resource_id,title_key,title,year,media_type,guid,play_count,completed_count,max_percent,last_watched_at,genres_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)', args: [resourceId, key, item.title, item.year ?? null, item.mediaType, item.guid ?? null, item.events.length, completed, maxPercent, new Date(Math.max(...item.events.map((event) => event.started)) * 1000).toISOString(), JSON.stringify(metadata.genres || [])] });
  }
  const taste = { strongGenres: [...genreScores.entries()].sort((a,b) => b[1]-a[1]).slice(0,6).map(([name,score]) => ({ name, score: Math.round(score*10)/10 })), completedTitles, repeatTitles, titlesAnalyzed: groups.size, windowMonths: 18 };
  const now = new Date().toISOString(); await database.execute({ sql: 'UPDATE gary_plex_links SET last_synced_at=?,taste_json=? WHERE resource_id=?', args: [now, JSON.stringify(taste), resourceId] });
  return { ...taste, lastSyncedAt: now, username: String(link.tautulli_username) };
}

export async function refreshAllViewingProfiles() {
  const links = await (await db()).execute('SELECT resource_id,tautulli_username FROM gary_plex_links ORDER BY lower(tautulli_username)');
  const results = [];
  for (const link of links.rows) {
    const resourceId = String(link.resource_id);
    const username = String(link.tautulli_username);
    try {
      const viewing = await refreshViewingProfile(resourceId);
      results.push({ resourceId, username, status: 'synced' as const, viewing });
    } catch (error) {
      results.push({ resourceId, username, status: 'error' as const, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

export async function getCompactViewingProfile(resourceId: string) { const link = await getViewingLink(resourceId); if (!link) return undefined; let taste: Record<string, unknown> = {}; try { taste = JSON.parse(String(link.taste_json || '{}')); } catch {} return { connected: true, username: String(link.tautulli_username), consentedAt: String(link.consented_at), lastSyncedAt: link.last_synced_at ? String(link.last_synced_at) : undefined, ...taste }; }
export async function checkViewingTitles(resourceId: string, titles: Array<{ title: string; year?: number }>) { const database = await db(); const results = []; for (const item of titles.slice(0,20)) { const exact = await database.execute({ sql: 'SELECT title,year,media_type,play_count,completed_count,max_percent,last_watched_at FROM gary_viewing_titles WHERE resource_id=? AND title_key=?', args: [resourceId, titleKey(item.title,item.year)] }); const fuzzy = exact.rows[0] ? exact : await database.execute({ sql: 'SELECT title,year,media_type,play_count,completed_count,max_percent,last_watched_at FROM gary_viewing_titles WHERE resource_id=? AND lower(title)=lower(?) ORDER BY last_watched_at DESC LIMIT 1', args: [resourceId,item.title] }); results.push({ requested: item, watched: Boolean(fuzzy.rows[0]), ...(fuzzy.rows[0] || {}) }); } return results; }
export function resetTautulliViewingForTests() { client = undefined; initPromise = undefined; }
