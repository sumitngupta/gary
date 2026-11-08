import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createClient, type Client, type InStatement, type Row, type Transaction } from '@libsql/client';

export const GARY_LIST_LIMITS = {
  listsPerUser: 20,
  itemsPerList: 200,
  nameLength: 60,
  titleLength: 200,
  noteLength: 300,
} as const;

export const GARY_LIST_MEDIA_TYPES = ['movie', 'tv', 'unknown'] as const;
export type GaryListMediaType = (typeof GARY_LIST_MEDIA_TYPES)[number];

export type GaryListItemInput = {
  title: string;
  year?: number;
  mediaType: GaryListMediaType;
  tmdbId?: number;
  note?: string;
};

export type GaryListItem = {
  id: string;
  title: string;
  year?: number;
  mediaType: GaryListMediaType;
  tmdbId?: number;
  note?: string;
  addedAt: string;
};

export type GaryListShelf = { title: string; customTitle: boolean; publishedAt: string };
export type GaryListSummary = { id: string; name: string; itemCount: number; createdAt: string; updatedAt: string; shelf?: GaryListShelf };
export type GaryList = GaryListSummary & { items: GaryListItem[] };

export type GaryListItemRef = { id: string } | { title: string; year?: number };

type Invalid = { status: 'invalid'; reason: string };
type ListNotFound = { status: 'list-not-found'; name: string };

export type AddGaryListItemsResult =
  | { status: 'ok'; list: GaryListSummary; created: boolean; added: GaryListItem[]; alreadyPresent: GaryListItem[] }
  | { status: 'list-limit'; limit: number }
  | { status: 'item-limit'; name: string; limit: number; remaining: number }
  | Invalid;

export type RemoveGaryListItemsResult =
  | { status: 'ok'; list: GaryListSummary; removed: GaryListItem[]; notFound: GaryListItemRef[]; ambiguous: { ref: GaryListItemRef; matches: GaryListItem[] }[] }
  | ListNotFound;

export type RenameGaryListResult =
  | { status: 'ok'; list: GaryListSummary; previousName: string }
  | { status: 'name-taken'; name: string }
  | ListNotFound
  | Invalid;

export type DeleteGaryListResult = { status: 'ok'; listId: string; name: string; itemCount: number; wasPublished: boolean } | ListNotFound;

export const GARY_SHELF_MEDIA_TYPES = ['movie', 'tv'] as const;
export type GaryShelfMediaType = (typeof GARY_SHELF_MEDIA_TYPES)[number];

export type PublishedGaryList = { listId: string; resourceId: string; listName: string; title: string; items: GaryListItem[] };
export type GaryShelfCollectionLink = { listId: string; resourceId: string; mediaType: GaryShelfMediaType; ratingKey: string };
export type GaryListPublishPreview = { id: string; resourceId: string; listId: string; title: string; customTitle: boolean; createdAt: string; expiresAt: string };

export type ConfirmGaryListPublishResult =
  | { status: 'ok'; listId: string; listName: string; title: string }
  | { status: 'expired' }
  | { status: 'already-published'; listName: string; title: string }
  | { status: 'title-taken'; title: string }
  | { status: 'list-not-found' };

export type UnpublishGaryListResult = { status: 'ok'; listId: string; listName: string; title: string } | { status: 'not-published'; listName: string } | ListNotFound;

const PUBLISH_PREVIEW_TTL_MS = 15 * 60_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gary_lists (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (resource_id, name_key)
);
CREATE TABLE IF NOT EXISTS gary_list_items (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES gary_lists(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  year INTEGER,
  media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv', 'unknown')),
  tmdb_id INTEGER,
  note TEXT,
  item_key TEXT NOT NULL,
  added_at TEXT NOT NULL,
  UNIQUE (list_id, item_key)
);
CREATE TABLE IF NOT EXISTS gary_list_shelves (
  list_id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  title TEXT NOT NULL,
  custom_title INTEGER NOT NULL,
  published_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gary_list_shelf_collections (
  list_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
  rating_key TEXT NOT NULL,
  PRIMARY KEY (list_id, media_type)
);
CREATE TABLE IF NOT EXISTS gary_list_publish_previews (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  list_id TEXT NOT NULL,
  title TEXT NOT NULL,
  custom_title INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
`;

let client: Client | undefined;
let initPromise: Promise<Client> | undefined;

async function db() {
  if (client) return client;
  initPromise ??= (async () => {
    const path = `${process.env.GARY_DATA_DIR || './data'}/gary-lists.db`;
    await mkdir(dirname(path), { recursive: true });
    const next = createClient({ url: `file:${path}`, timeout: 5_000 });
    await next.executeMultiple(SCHEMA);
    client = next;
    return next;
  })();
  return initPromise;
}

export function resetGaryListStoreForTests() {
  client?.close();
  client = undefined;
  initPromise = undefined;
}

function collapse(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function textKey(value: string) {
  return collapse(value).toLowerCase();
}

function itemKey(item: Pick<GaryListItemInput, 'title' | 'year' | 'mediaType'>) {
  return `${textKey(item.title)}|${item.year ?? ''}|${item.mediaType}`;
}

function newId(prefix: string) {
  return `${prefix}_${randomBytes(10).toString('hex')}`;
}

function validName(name: string): string | Invalid {
  const display = collapse(name);
  if (!display) return { status: 'invalid', reason: 'List names cannot be empty.' };
  if (display.length > GARY_LIST_LIMITS.nameLength) {
    return { status: 'invalid', reason: `List names can be at most ${GARY_LIST_LIMITS.nameLength} characters.` };
  }
  return display;
}

function toItem(row: Row): GaryListItem {
  return {
    id: String(row.id),
    title: String(row.title),
    ...(row.year === null ? {} : { year: Number(row.year) }),
    mediaType: String(row.media_type) as GaryListMediaType,
    ...(row.tmdb_id === null ? {} : { tmdbId: Number(row.tmdb_id) }),
    ...(row.note === null ? {} : { note: String(row.note) }),
    addedAt: String(row.added_at),
  };
}

function toSummary(row: Row): GaryListSummary {
  return {
    id: String(row.id),
    name: String(row.name),
    itemCount: Number(row.item_count ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(row.shelf_title === null
      ? {}
      : { shelf: { title: String(row.shelf_title), customTitle: Number(row.shelf_custom_title) === 1, publishedAt: String(row.shelf_published_at) } }),
  };
}

const SUMMARY_SELECT = `
  SELECT l.id, l.name, l.created_at, l.updated_at,
    (SELECT COUNT(*) FROM gary_list_items i WHERE i.list_id = l.id) AS item_count,
    s.title AS shelf_title, s.custom_title AS shelf_custom_title, s.published_at AS shelf_published_at
  FROM gary_lists l LEFT JOIN gary_list_shelves s ON s.list_id = l.id`;

type Executor = Pick<Client | Transaction, 'execute'>;

async function findList(executor: Executor, resourceId: string, name: string) {
  const result = await executor.execute({
    sql: `${SUMMARY_SELECT} WHERE l.resource_id = ? AND l.name_key = ?`,
    args: [resourceId, textKey(name)],
  });
  return result.rows[0] ? toSummary(result.rows[0]) : undefined;
}

async function listItems(executor: Executor, listId: string) {
  const result = await executor.execute({
    sql: 'SELECT * FROM gary_list_items WHERE list_id = ? ORDER BY added_at, rowid',
    args: [listId],
  });
  return result.rows.map(toItem);
}

async function inWriteTransaction<T>(run: (tx: Transaction) => Promise<T>) {
  const tx = await (await db()).transaction('write');
  try {
    const result = await run(tx);
    await tx.commit();
    return result;
  } finally {
    tx.close();
  }
}

function touch(listId: string, now: string): InStatement {
  return { sql: 'UPDATE gary_lists SET updated_at = ? WHERE id = ?', args: [now, listId] };
}

export async function listGaryLists(resourceId: string): Promise<GaryListSummary[]> {
  const result = await (await db()).execute({
    sql: `${SUMMARY_SELECT} WHERE l.resource_id = ? ORDER BY l.updated_at DESC, l.name_key`,
    args: [resourceId],
  });
  return result.rows.map(toSummary);
}

export async function getGaryList(resourceId: string, name: string): Promise<GaryList | undefined> {
  const database = await db();
  const list = await findList(database, resourceId, name);
  return list ? { ...list, items: await listItems(database, list.id) } : undefined;
}

export async function addGaryListItems(resourceId: string, name: string, items: GaryListItemInput[]): Promise<AddGaryListItemsResult> {
  const displayName = validName(name);
  if (typeof displayName !== 'string') return displayName;
  const candidates = new Map<string, GaryListItemInput>();
  for (const item of items) {
    const title = collapse(item.title);
    if (!title) return { status: 'invalid', reason: 'Titles cannot be empty.' };
    if (title.length > GARY_LIST_LIMITS.titleLength) {
      return { status: 'invalid', reason: `Titles can be at most ${GARY_LIST_LIMITS.titleLength} characters.` };
    }
    const note = item.note === undefined ? undefined : collapse(item.note) || undefined;
    if (note && note.length > GARY_LIST_LIMITS.noteLength) {
      return { status: 'invalid', reason: `Notes can be at most ${GARY_LIST_LIMITS.noteLength} characters.` };
    }
    const normalized = { ...item, title, note };
    const key = itemKey(normalized);
    if (!candidates.has(key)) candidates.set(key, normalized);
  }

  return inWriteTransaction(async (tx) => {
    const now = new Date().toISOString();
    let list = await findList(tx, resourceId, displayName);
    const existing = list ? await listItems(tx, list.id) : [];
    const existingByKey = new Map(existing.map((item) => [itemKey(item), item]));
    const alreadyPresent = [...candidates.keys()].flatMap((key) => existingByKey.get(key) ?? []);
    const fresh = [...candidates.entries()].filter(([key]) => !existingByKey.has(key));
    const remaining = GARY_LIST_LIMITS.itemsPerList - existing.length;
    if (fresh.length > remaining) {
      return { status: 'item-limit', name: list?.name ?? displayName, limit: GARY_LIST_LIMITS.itemsPerList, remaining };
    }

    const created = !list;
    if (!list) {
      const count = await tx.execute({ sql: 'SELECT COUNT(*) AS count FROM gary_lists WHERE resource_id = ?', args: [resourceId] });
      if (Number(count.rows[0]?.count ?? 0) >= GARY_LIST_LIMITS.listsPerUser) {
        return { status: 'list-limit', limit: GARY_LIST_LIMITS.listsPerUser };
      }
      const id = newId('gary_list');
      await tx.execute({
        sql: 'INSERT INTO gary_lists (id, resource_id, name, name_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        args: [id, resourceId, displayName, textKey(displayName), now, now],
      });
      list = { id, name: displayName, itemCount: 0, createdAt: now, updatedAt: now };
    }

    const added: GaryListItem[] = fresh.map(([, item]) => ({
      id: newId('gary_item'),
      title: item.title,
      ...(item.year === undefined ? {} : { year: item.year }),
      mediaType: item.mediaType,
      ...(item.tmdbId === undefined ? {} : { tmdbId: item.tmdbId }),
      ...(item.note === undefined ? {} : { note: item.note }),
      addedAt: now,
    }));
    for (const [index, item] of added.entries()) {
      await tx.execute({
        sql: `INSERT INTO gary_list_items (id, list_id, title, year, media_type, tmdb_id, note, item_key, added_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [item.id, list.id, item.title, item.year ?? null, item.mediaType, item.tmdbId ?? null, item.note ?? null, fresh[index][0], now],
      });
    }
    if (added.length > 0) await tx.execute(touch(list.id, now));
    const updatedAt = added.length > 0 ? now : list.updatedAt;
    return {
      status: 'ok',
      list: { ...list, itemCount: existing.length + added.length, updatedAt },
      created,
      added,
      alreadyPresent,
    };
  });
}

function matchesRef(item: GaryListItem, ref: GaryListItemRef) {
  if ('id' in ref) return item.id === ref.id;
  return textKey(item.title) === textKey(ref.title) && (ref.year === undefined || item.year === ref.year);
}

export async function removeGaryListItems(resourceId: string, name: string, refs: GaryListItemRef[]): Promise<RemoveGaryListItemsResult> {
  return inWriteTransaction(async (tx) => {
    const list = await findList(tx, resourceId, name);
    if (!list) return { status: 'list-not-found', name: collapse(name) };
    const items = await listItems(tx, list.id);
    const removedIds = new Set<string>();
    const notFound: GaryListItemRef[] = [];
    const ambiguous: { ref: GaryListItemRef; matches: GaryListItem[] }[] = [];
    for (const ref of refs) {
      const matches = items.filter((item) => matchesRef(item, ref));
      if (matches.length === 0) notFound.push(ref);
      else if (matches.length > 1) ambiguous.push({ ref, matches });
      else removedIds.add(matches[0].id);
    }
    const removed = items.filter((item) => removedIds.has(item.id));
    const now = new Date().toISOString();
    for (const item of removed) {
      await tx.execute({ sql: 'DELETE FROM gary_list_items WHERE id = ? AND list_id = ?', args: [item.id, list.id] });
    }
    if (removed.length > 0) await tx.execute(touch(list.id, now));
    return {
      status: 'ok',
      list: { ...list, itemCount: items.length - removed.length, updatedAt: removed.length > 0 ? now : list.updatedAt },
      removed,
      notFound,
      ambiguous,
    };
  });
}

export async function renameGaryList(resourceId: string, name: string, newName: string): Promise<RenameGaryListResult> {
  const displayName = validName(newName);
  if (typeof displayName !== 'string') return displayName;
  return inWriteTransaction(async (tx) => {
    const list = await findList(tx, resourceId, name);
    if (!list) return { status: 'list-not-found', name: collapse(name) };
    const collision = await findList(tx, resourceId, displayName);
    if (collision && collision.id !== list.id) return { status: 'name-taken', name: collision.name };
    const now = new Date().toISOString();
    await tx.execute({
      sql: 'UPDATE gary_lists SET name = ?, name_key = ?, updated_at = ? WHERE id = ? AND resource_id = ?',
      args: [displayName, textKey(displayName), now, list.id, resourceId],
    });
    const shelf = list.shelf && !list.shelf.customTitle
      ? { ...list.shelf, title: `${list.shelf.title.slice(0, list.shelf.title.length - list.name.length)}${displayName}` }
      : list.shelf;
    if (shelf && shelf !== list.shelf) {
      await tx.execute({ sql: 'UPDATE gary_list_shelves SET title = ? WHERE list_id = ? AND resource_id = ?', args: [shelf.title, list.id, resourceId] });
    }
    return { status: 'ok', list: { ...list, name: displayName, updatedAt: now, shelf }, previousName: list.name };
  });
}

export async function deleteGaryList(resourceId: string, name: string): Promise<DeleteGaryListResult> {
  return inWriteTransaction(async (tx) => {
    const list = await findList(tx, resourceId, name);
    if (!list) return { status: 'list-not-found', name: collapse(name) };
    await tx.execute({ sql: 'DELETE FROM gary_list_items WHERE list_id = ?', args: [list.id] });
    await tx.execute({ sql: 'DELETE FROM gary_list_shelves WHERE list_id = ?', args: [list.id] });
    await tx.execute({ sql: 'DELETE FROM gary_list_publish_previews WHERE list_id = ?', args: [list.id] });
    await tx.execute({ sql: 'DELETE FROM gary_lists WHERE id = ? AND resource_id = ?', args: [list.id, resourceId] });
    return { status: 'ok', listId: list.id, name: list.name, itemCount: list.itemCount, wasPublished: Boolean(list.shelf) };
  });
}

export async function exportGaryListsForResource(resourceId: string): Promise<GaryList[]> {
  const database = await db();
  const lists = await listGaryLists(resourceId);
  return Promise.all(lists.map(async (list) => ({ ...list, items: await listItems(database, list.id) })));
}

export async function deleteGaryListsForResource(resourceId: string): Promise<{ lists: number; items: number; shelves: number }> {
  return inWriteTransaction(async (tx) => {
    const ownedLists = 'SELECT id FROM gary_lists WHERE resource_id = ?';
    const items = await tx.execute({ sql: `DELETE FROM gary_list_items WHERE list_id IN (${ownedLists})`, args: [resourceId] });
    const shelves = await tx.execute({ sql: 'DELETE FROM gary_list_shelves WHERE resource_id = ?', args: [resourceId] });
    await tx.execute({ sql: 'DELETE FROM gary_list_publish_previews WHERE resource_id = ?', args: [resourceId] });
    const lists = await tx.execute({ sql: 'DELETE FROM gary_lists WHERE resource_id = ?', args: [resourceId] });
    return { lists: lists.rowsAffected, items: items.rowsAffected, shelves: shelves.rowsAffected };
  });
}

async function shelfTitleTaken(executor: Executor, title: string) {
  const shelves = await executor.execute('SELECT title FROM gary_list_shelves');
  return shelves.rows.some((row) => textKey(String(row.title)) === textKey(title));
}

export async function isGaryShelfTitleTaken(title: string) {
  return shelfTitleTaken(await db(), title);
}

export async function createGaryListPublishPreview(
  input: { resourceId: string; listId: string; title: string; customTitle: boolean },
  now = new Date(),
): Promise<GaryListPublishPreview> {
  const preview = {
    ...input,
    id: newId('gary_shelf_preview'),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PUBLISH_PREVIEW_TTL_MS).toISOString(),
  };
  await (await db()).execute({
    sql: `INSERT INTO gary_list_publish_previews (id, resource_id, list_id, title, custom_title, created_at, expires_at, consumed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    args: [preview.id, preview.resourceId, preview.listId, preview.title, preview.customTitle ? 1 : 0, preview.createdAt, preview.expiresAt],
  });
  return preview;
}

export async function confirmGaryListPublish(resourceId: string, previewId: string, now = new Date()): Promise<ConfirmGaryListPublishResult> {
  return inWriteTransaction(async (tx) => {
    const timestamp = now.toISOString();
    const claimed = await tx.execute({
      sql: `UPDATE gary_list_publish_previews SET consumed_at = ?
        WHERE id = ? AND resource_id = ? AND consumed_at IS NULL AND expires_at > ?
        RETURNING list_id, title, custom_title`,
      args: [timestamp, previewId, resourceId, timestamp],
    });
    const preview = claimed.rows[0];
    if (!preview) return { status: 'expired' };
    const title = String(preview.title);
    const customTitle = Number(preview.custom_title) === 1;
    const row = (await tx.execute({ sql: `${SUMMARY_SELECT} WHERE l.id = ? AND l.resource_id = ?`, args: [String(preview.list_id), resourceId] })).rows[0];
    if (!row) return { status: 'list-not-found' };
    const list = toSummary(row);
    if (list.shelf) return { status: 'already-published', listName: list.name, title: list.shelf.title };
    if (!customTitle && !title.endsWith(`'s ${list.name}`)) return { status: 'expired' };
    if (await shelfTitleTaken(tx, title)) return { status: 'title-taken', title };
    await tx.execute({
      sql: 'INSERT INTO gary_list_shelves (list_id, resource_id, title, custom_title, published_at) VALUES (?, ?, ?, ?, ?)',
      args: [list.id, resourceId, title, customTitle ? 1 : 0, timestamp],
    });
    return { status: 'ok', listId: list.id, listName: list.name, title };
  });
}

export async function unpublishGaryList(resourceId: string, name: string): Promise<UnpublishGaryListResult> {
  return inWriteTransaction(async (tx) => {
    const list = await findList(tx, resourceId, name);
    if (!list) return { status: 'list-not-found', name: collapse(name) };
    if (!list.shelf) return { status: 'not-published', listName: list.name };
    await tx.execute({ sql: 'DELETE FROM gary_list_shelves WHERE list_id = ? AND resource_id = ?', args: [list.id, resourceId] });
    return { status: 'ok', listId: list.id, listName: list.name, title: list.shelf.title };
  });
}

function byResource(resourceId: string | undefined, column: string) {
  return resourceId === undefined ? { where: '', args: [] } : { where: `WHERE ${column} = ?`, args: [resourceId] };
}

export async function listPublishedGaryLists(resourceId?: string): Promise<PublishedGaryList[]> {
  const database = await db();
  const filter = byResource(resourceId, 's.resource_id');
  const result = await database.execute({
    sql: `SELECT s.list_id, s.resource_id, s.title, l.name FROM gary_list_shelves s JOIN gary_lists l ON l.id = s.list_id
      ${filter.where} ORDER BY s.published_at, s.list_id`,
    args: filter.args,
  });
  return Promise.all(result.rows.map(async (row) => ({
    listId: String(row.list_id),
    resourceId: String(row.resource_id),
    listName: String(row.name),
    title: String(row.title),
    items: await listItems(database, String(row.list_id)),
  })));
}

export async function listGaryShelfCollectionLinks(resourceId?: string): Promise<GaryShelfCollectionLink[]> {
  const filter = byResource(resourceId, 'resource_id');
  const result = await (await db()).execute({
    sql: `SELECT * FROM gary_list_shelf_collections ${filter.where} ORDER BY list_id, media_type`,
    args: filter.args,
  });
  return result.rows.map((row) => ({
    listId: String(row.list_id),
    resourceId: String(row.resource_id),
    mediaType: String(row.media_type) as GaryShelfMediaType,
    ratingKey: String(row.rating_key),
  }));
}

export async function recordGaryShelfCollectionLink(link: GaryShelfCollectionLink) {
  await (await db()).execute({
    sql: `INSERT INTO gary_list_shelf_collections (list_id, resource_id, media_type, rating_key) VALUES (?, ?, ?, ?)
      ON CONFLICT (list_id, media_type) DO UPDATE SET rating_key = excluded.rating_key`,
    args: [link.listId, link.resourceId, link.mediaType, link.ratingKey],
  });
}

export async function deleteGaryShelfCollectionLink(link: Pick<GaryShelfCollectionLink, 'listId' | 'mediaType'>) {
  await (await db()).execute({ sql: 'DELETE FROM gary_list_shelf_collections WHERE list_id = ? AND media_type = ?', args: [link.listId, link.mediaType] });
}
