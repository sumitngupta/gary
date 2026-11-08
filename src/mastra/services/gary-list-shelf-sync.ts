import {
  deleteGaryShelfCollectionLink,
  GARY_SHELF_MEDIA_TYPES,
  listGaryShelfCollectionLinks,
  listPublishedGaryLists,
  recordGaryShelfCollectionLink,
  type GaryListItem,
  type GaryShelfCollectionLink,
  type GaryShelfMediaType,
  type PublishedGaryList,
} from './gary-list-store';
import { KeyedTaskQueue } from './keyed-task-queue';
import {
  addPlexCollectionItems,
  createPlexCollection,
  deletePlexCollection,
  loadPlexShelfInventory,
  normalizeTitle,
  removePlexCollectionItem,
  updatePlexCollectionMetadata,
  type PlexShelfInventory,
} from './plex-readonly-client';

export type GaryShelfPlex = {
  loadInventory(): Promise<PlexShelfInventory>;
  createCollection(input: { title: string; summary: string; mediaType: GaryShelfMediaType; sectionKey: string; ratingKeys: string[] }): Promise<string>;
  retitleCollection(ratingKey: string, title: string, summary: string): Promise<void>;
  addItems(ratingKey: string, itemKeys: string[]): Promise<void>;
  removeItem(ratingKey: string, itemKey: string): Promise<void>;
  deleteCollection(ratingKey: string): Promise<void>;
};

export const plexShelfClient: GaryShelfPlex = {
  loadInventory: loadPlexShelfInventory,
  createCollection: createPlexCollection,
  retitleCollection: (ratingKey, title, summary) => updatePlexCollectionMetadata(ratingKey, { title, summary }),
  addItems: addPlexCollectionItems,
  removeItem: removePlexCollectionItem,
  deleteCollection: deletePlexCollection,
};

export type GaryShelfUnmatchedReason = 'not-in-library' | 'ambiguous';

export type GaryShelfResolution = {
  matched: Array<{ item: GaryListItem; mediaType: GaryShelfMediaType; ratingKey: string }>;
  unmatched: Array<{ item: GaryListItem; reason: GaryShelfUnmatchedReason }>;
};

export type GaryShelfChange = {
  listId: string;
  resourceId: string;
  title?: string;
  mediaType: GaryShelfMediaType;
  outcome: 'created' | 'updated' | 'unchanged' | 'deleted' | 'orphan-removed' | 'failed';
  ratingKey?: string;
  added: string[];
  removed: string[];
  retitled: boolean;
  error?: string;
};

export type GaryShelfSyncReceipt = {
  changes: GaryShelfChange[];
  unmatched: Array<{ listId: string; resourceId: string; title: string; year?: number; reason: GaryShelfUnmatchedReason }>;
  errors: string[];
};

export function shelfSummary(title: string) {
  return `${title}, kept with Gary.`;
}

export function resolveGaryShelfItems(items: GaryListItem[], inventory: PlexShelfInventory): GaryShelfResolution {
  const resolution: GaryShelfResolution = { matched: [], unmatched: [] };
  for (const item of items) {
    const candidates = inventory.sections
      .filter((section) => item.mediaType === 'unknown' || section.mediaType === item.mediaType)
      .flatMap((section) => section.items.map((entry) => ({ mediaType: section.mediaType, entry })));
    const matches = item.tmdbId === undefined
      ? candidates.filter(({ entry }) => normalizeTitle(entry.title) === normalizeTitle(item.title) && (item.year === undefined || entry.year === item.year))
      : candidates.filter(({ entry }) => entry.tmdbIds.includes(item.tmdbId!));
    if (matches.length === 1) resolution.matched.push({ item, mediaType: matches[0].mediaType, ratingKey: matches[0].entry.ratingKey });
    else resolution.unmatched.push({ item, reason: matches.length === 0 ? 'not-in-library' : 'ambiguous' });
  }
  return resolution;
}

export function findShelfTitleCollision(inventory: PlexShelfInventory, title: string, options: { sectionKey?: string; ownKey?: string } = {}) {
  const sectionKeys = new Set(options.sectionKey ? [options.sectionKey] : inventory.sections.map((section) => section.key));
  return inventory.collections.find((collection) => sectionKeys.has(collection.sectionKey)
    && collection.ratingKey !== options.ownKey
    && normalizeTitle(collection.title) === normalizeTitle(title));
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function reconcileLibrary(
  plex: GaryShelfPlex,
  inventory: PlexShelfInventory,
  shelf: PublishedGaryList,
  mediaType: GaryShelfMediaType,
  desired: string[],
  link: GaryShelfCollectionLink | undefined,
): Promise<GaryShelfChange | undefined> {
  const base = { listId: shelf.listId, resourceId: shelf.resourceId, title: shelf.title, mediaType, added: [], removed: [], retitled: false };
  const existing = link && inventory.collections.find((collection) => collection.ratingKey === link.ratingKey);

  if (desired.length === 0) {
    if (!link) return undefined;
    if (existing) await plex.deleteCollection(existing.ratingKey);
    await deleteGaryShelfCollectionLink(link);
    return { ...base, outcome: 'deleted', ratingKey: link.ratingKey };
  }

  const section = inventory.sections.find((candidate) => candidate.mediaType === mediaType)!;
  const collision = findShelfTitleCollision(inventory, shelf.title, { sectionKey: section.key, ownKey: existing?.ratingKey });
  if (!existing) {
    if (collision) return { ...base, outcome: 'failed', error: `A Plex collection called "${collision.title}" already exists.` };
    const ratingKey = await plex.createCollection({ title: shelf.title, summary: shelfSummary(shelf.title), mediaType, sectionKey: section.key, ratingKeys: desired });
    await recordGaryShelfCollectionLink({ listId: shelf.listId, resourceId: shelf.resourceId, mediaType, ratingKey });
    inventory.collections.push({ ratingKey, title: shelf.title, sectionKey: section.key, itemKeys: desired });
    return { ...base, outcome: 'created', ratingKey, added: desired };
  }

  const retitled = existing.title !== shelf.title;
  if (retitled && collision) {
    return { ...base, outcome: 'failed', ratingKey: existing.ratingKey, error: `A Plex collection called "${collision.title}" already exists.` };
  }
  const current = new Set(existing.itemKeys);
  const wanted = new Set(desired);
  const added = desired.filter((key) => !current.has(key));
  const removed = existing.itemKeys.filter((key) => !wanted.has(key));
  if (retitled) await plex.retitleCollection(existing.ratingKey, shelf.title, shelfSummary(shelf.title));
  if (added.length) await plex.addItems(existing.ratingKey, added);
  for (const key of removed) await plex.removeItem(existing.ratingKey, key);
  const changed = retitled || added.length > 0 || removed.length > 0;
  return { ...base, outcome: changed ? 'updated' : 'unchanged', ratingKey: existing.ratingKey, added, removed, retitled };
}

async function reconcile(plex: GaryShelfPlex, resourceId: string | undefined): Promise<GaryShelfSyncReceipt> {
  const receipt: GaryShelfSyncReceipt = { changes: [], unmatched: [], errors: [] };
  const [shelves, links] = await Promise.all([listPublishedGaryLists(resourceId), listGaryShelfCollectionLinks(resourceId)]);
  if (shelves.length === 0 && links.length === 0) return receipt;

  let inventory: PlexShelfInventory;
  try {
    inventory = await plex.loadInventory();
  } catch (error) {
    receipt.errors.push(`Could not read Plex: ${message(error)}`);
    return receipt;
  }

  const linkFor = (listId: string, mediaType: GaryShelfMediaType) =>
    links.find((link) => link.listId === listId && link.mediaType === mediaType);

  for (const shelf of shelves) {
    const resolution = resolveGaryShelfItems(shelf.items, inventory);
    for (const { item, reason } of resolution.unmatched) {
      receipt.unmatched.push({ listId: shelf.listId, resourceId: shelf.resourceId, title: item.title, ...(item.year === undefined ? {} : { year: item.year }), reason });
    }
    for (const mediaType of GARY_SHELF_MEDIA_TYPES) {
      const desired = [...new Set(resolution.matched.filter((match) => match.mediaType === mediaType).map((match) => match.ratingKey))];
      try {
        const change = await reconcileLibrary(plex, inventory, shelf, mediaType, desired, linkFor(shelf.listId, mediaType));
        if (change) receipt.changes.push(change);
      } catch (error) {
        receipt.changes.push({ listId: shelf.listId, resourceId: shelf.resourceId, title: shelf.title, mediaType, outcome: 'failed', added: [], removed: [], retitled: false, error: message(error) });
      }
    }
  }

  const published = new Set(shelves.map((shelf) => shelf.listId));
  for (const link of links.filter((candidate) => !published.has(candidate.listId))) {
    const existing = inventory.collections.find((collection) => collection.ratingKey === link.ratingKey);
    const base = { listId: link.listId, resourceId: link.resourceId, title: existing?.title, mediaType: link.mediaType, ratingKey: link.ratingKey, added: [], removed: [], retitled: false };
    try {
      if (existing) await plex.deleteCollection(existing.ratingKey);
      await deleteGaryShelfCollectionLink(link);
      receipt.changes.push({ ...base, outcome: 'orphan-removed' });
    } catch (error) {
      receipt.changes.push({ ...base, outcome: 'failed', error: message(error) });
    }
  }
  return receipt;
}

const queue = new KeyedTaskQueue();

export function syncGaryListShelves(options: { resourceId?: string; plex?: GaryShelfPlex } = {}) {
  return queue.run('gary-list-shelves', () => reconcile(options.plex ?? plexShelfClient, options.resourceId));
}
