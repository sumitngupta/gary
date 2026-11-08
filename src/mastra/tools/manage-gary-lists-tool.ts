import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { createPendingIntent } from '../services/gary-operations-store';
import {
  findShelfTitleCollision,
  plexShelfClient,
  resolveGaryShelfItems,
  syncGaryListShelves,
  type GaryShelfSyncReceipt,
} from '../services/gary-list-shelf-sync';
import {
  addGaryListItems,
  confirmGaryListPublish,
  createGaryListPublishPreview,
  deleteGaryList,
  GARY_LIST_LIMITS,
  GARY_LIST_MEDIA_TYPES,
  getGaryList,
  isGaryShelfTitleTaken,
  listGaryLists,
  removeGaryListItems,
  renameGaryList,
  unpublishGaryList,
  type GaryListItem,
} from '../services/gary-list-store';
import { getGaryUserProfile } from '../services/gary-user-profile-store';
import { serverName } from '../config/branding';

const listName = z.string().trim().min(1).max(GARY_LIST_LIMITS.nameLength);
const year = z.number().int().min(1870).max(2100);

const item = z.object({
  title: z.string().trim().min(1).max(GARY_LIST_LIMITS.titleLength),
  year: year.optional(),
  mediaType: z.enum(GARY_LIST_MEDIA_TYPES),
  tmdbId: z.number().int().positive().optional(),
  note: z.string().trim().max(GARY_LIST_LIMITS.noteLength).optional(),
});

const itemRef = z.union([
  z.object({ id: z.string().trim().min(1) }),
  z.object({ title: z.string().trim().min(1).max(GARY_LIST_LIMITS.titleLength), year: year.optional() }),
]);

export const manageGaryListsInputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('overview') }),
  z.object({ action: z.literal('show'), list: listName }),
  z.object({ action: z.literal('add'), list: listName.default('Watchlist'), items: z.array(item).min(1).max(25) }),
  z.object({ action: z.literal('remove'), list: listName, items: z.array(itemRef).min(1).max(25) }),
  z.object({ action: z.literal('rename'), list: listName, newName: listName }),
  z.object({ action: z.literal('delete-list'), list: listName }),
  z.object({
    action: z.literal('publish'),
    list: listName,
    shelfTitle: z.string().trim().min(1).max(100).optional(),
    displayName: z.string().trim().min(1).max(40).optional(),
  }),
  z.object({ action: z.literal('confirm-publish'), previewId: z.string().trim().min(1) }),
  z.object({ action: z.literal('unpublish'), list: listName }),
]);

const actions = manageGaryListsInputSchema.options.map((option) => option.shape.action.value);

// OpenAI rejects a tool whose JSON Schema root is not `type: "object"`, which a
// discriminated union compiles to (a bare `oneOf`). The model sees this flat
// object; execute narrows it through manageGaryListsInputSchema.
export const manageGaryListsToolInputSchema = z.object({
  action: z.enum(actions as [typeof actions[number], ...typeof actions[number][]]),
  list: z.string().optional().describe('List name. Required for every action except overview and confirm-publish; add defaults to "Watchlist".'),
  items: z.array(z.object({
    id: z.string().optional().describe('remove only: a list entry id.'),
    title: z.string().optional(),
    year: z.number().int().optional(),
    mediaType: z.enum(GARY_LIST_MEDIA_TYPES).optional().describe('Required for add.'),
    tmdbId: z.number().int().optional(),
    note: z.string().optional(),
  })).optional().describe('add and remove: 1 to 25 titles. remove takes an id or a title with optional year.'),
  newName: z.string().optional().describe('rename only.'),
  shelfTitle: z.string().optional().describe('publish only: a custom shelf title that includes the user’s name.'),
  displayName: z.string().optional().describe('publish only: the name to show when publish returned name-needed.'),
  previewId: z.string().optional().describe('confirm-publish only.'),
});

function label(item: Pick<GaryListItem, 'title' | 'year'>) {
  return item.year ? `${item.title} (${item.year})` : item.title;
}

function titles(items: Pick<GaryListItem, 'title' | 'year'>[]) {
  return items.map(label).join(', ');
}

function shelfNote(list: { shelf?: { title: string } }) {
  return list.shelf ? ` Published as the shelf "${list.shelf.title}".` : '';
}

async function syncShelvesFor(resourceId: string): Promise<GaryShelfSyncReceipt> {
  try {
    return await syncGaryListShelves({ resourceId });
  } catch (error) {
    return { changes: [], unmatched: [], errors: [error instanceof Error ? error.message : String(error)] };
  }
}

function shelfSyncFailed(receipt: GaryShelfSyncReceipt, listId: string) {
  return receipt.errors.length > 0 || receipt.changes.some((change) => change.listId === listId && change.outcome === 'failed');
}

function describeShelfSync(receipt: GaryShelfSyncReceipt, listId: string) {
  const changes = receipt.changes.filter((change) => change.listId === listId);
  const library = (mediaType: 'movie' | 'tv') => (mediaType === 'tv' ? 'TV' : 'movie');
  const parts = changes.flatMap((change) => {
    switch (change.outcome) {
      case 'created': return [`Created the ${library(change.mediaType)} shelf with ${change.added.length} title(s).`];
      case 'updated': return [`Updated the ${library(change.mediaType)} shelf.`];
      case 'deleted':
      case 'orphan-removed': return [`Removed the ${library(change.mediaType)} shelf from Plex.`];
      case 'failed': return [`The ${library(change.mediaType)} shelf did not update: ${change.error}`];
      case 'unchanged': return [];
    }
  });
  parts.push(...receipt.errors);
  if (shelfSyncFailed(receipt, listId)) parts.push('Gary tries again every night.');
  const missing = receipt.unmatched.filter((entry) => entry.listId === listId);
  if (missing.length) parts.push(`Not on ${serverName()} yet, so only on the list: ${titles(missing)}.`);
  return parts.join(' ');
}

export const manageGaryListsTool = createTool({
  id: 'manage-gary-lists',
  description: [
    'Create and manage the current user’s own lists of movies and shows, such as a watchlist, "maybe later", or "for movie night".',
    'Use it when the user asks to keep a list, add something to their watchlist, save a title for later, see a list, remove titles, rename a list, or delete a list.',
    `Adding to a list only remembers the title; it never requests, searches for, or downloads anything in ${serverName()}.`,
    'Lists are private. Each user has separate lists, and this tool cannot see or change anyone else’s lists.',
    `Only when the user asks to share or publish a list, use publish: it shows a preview of a Plex Collections shelf named with the user’s name (for example "Alice’s Watchlist") that everyone on ${serverName()} can see.`,
    'Show that preview and wait for the user’s yes before calling confirm-publish with its previewId. unpublish takes the shelf down and keeps the list.',
    'If publish returns name-needed, ask what name to show on the shelf and call publish again with displayName.',
    'If no list is named for an add, use "Watchlist".',
  ].join(' '),
  inputSchema: manageGaryListsToolInputSchema,
  outputSchema: z.object({ status: z.string(), summary: z.string(), data: z.record(z.string(), z.unknown()).optional() }),
  execute: async (rawInput, context) => {
    const resourceId = context.agent?.resourceId;
    if (!resourceId) return { status: 'service-unavailable', summary: 'The current user context is unavailable.' };
    const withoutNulls = (value: unknown): unknown => Array.isArray(value)
      ? value.map(withoutNulls)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null).map(([k, v]) => [k, withoutNulls(v)]))
        : value;
    const parsed = manageGaryListsInputSchema.safeParse(withoutNulls(rawInput));
    if (!parsed.success) {
      return { status: 'invalid', summary: `That list request is incomplete: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ')}.` };
    }
    const input = parsed.data;

    switch (input.action) {
      case 'overview': {
        const lists = await listGaryLists(resourceId);
        return {
          status: 'ok',
          summary: lists.length
            ? `You have ${lists.length} list(s): ${lists.map((list) => `${list.name} (${list.itemCount}${list.shelf ? `, published as "${list.shelf.title}"` : ''})`).join(', ')}.`
            : 'You do not have any lists yet.',
          data: { lists: lists.map(({ name, itemCount, updatedAt, shelf }) => ({ name, itemCount, updatedAt, shelfTitle: shelf?.title })) },
        };
      }
      case 'show': {
        const list = await getGaryList(resourceId, input.list);
        if (!list) return { status: 'list-not-found', summary: `You do not have a list called "${input.list}".` };
        return {
          status: 'ok',
          summary: (list.items.length ? `${list.name} has ${list.items.length} title(s): ${titles(list.items)}.` : `${list.name} is empty.`) + shelfNote(list),
          data: { name: list.name, items: list.items, shelfTitle: list.shelf?.title },
        };
      }
      case 'add': {
        const result = await addGaryListItems(resourceId, input.list, input.items);
        if (result.status === 'invalid') return { status: 'invalid', summary: result.reason };
        if (result.status === 'list-limit') {
          return { status: 'list-limit', summary: `You already have ${result.limit} lists, the most Gary keeps. Delete or reuse one first.` };
        }
        if (result.status === 'item-limit') {
          return {
            status: 'item-limit',
            summary: `${result.name} can hold ${result.limit} titles and has room for ${result.remaining} more. Remove some titles or use another list.`,
          };
        }
        const parts = [
          result.added.length ? `Added ${titles(result.added)} to ${result.list.name}.` : '',
          result.alreadyPresent.length ? `Already on ${result.list.name}: ${titles(result.alreadyPresent)}.` : '',
        ];
        return {
          status: 'ok',
          summary: parts.filter(Boolean).join(' '),
          data: { name: result.list.name, created: result.created, itemCount: result.list.itemCount, added: result.added, alreadyPresent: result.alreadyPresent },
        };
      }
      case 'remove': {
        const result = await removeGaryListItems(resourceId, input.list, input.items);
        if (result.status === 'list-not-found') return { status: 'list-not-found', summary: `You do not have a list called "${input.list}".` };
        const parts = [
          result.removed.length ? `Removed ${titles(result.removed)} from ${result.list.name}.` : '',
          result.notFound.length ? `Not on ${result.list.name}: ${result.notFound.map((ref) => ('id' in ref ? ref.id : label(ref))).join(', ')}.` : '',
          ...result.ambiguous.map(({ matches }) => `More than one match, so nothing was removed for: ${titles(matches)}. Say which year.`),
        ];
        return {
          status: 'ok',
          summary: parts.filter(Boolean).join(' '),
          data: { name: result.list.name, itemCount: result.list.itemCount, removed: result.removed, notFound: result.notFound, ambiguous: result.ambiguous },
        };
      }
      case 'rename': {
        const result = await renameGaryList(resourceId, input.list, input.newName);
        if (result.status === 'invalid') return { status: 'invalid', summary: result.reason };
        if (result.status === 'list-not-found') return { status: 'list-not-found', summary: `You do not have a list called "${input.list}".` };
        if (result.status === 'name-taken') return { status: 'name-taken', summary: `You already have a list called "${result.name}".` };
        const renamed = `Renamed ${result.previousName} to ${result.list.name}.`;
        if (!result.list.shelf) return { status: 'ok', summary: renamed, data: { name: result.list.name } };
        const receipt = await syncShelvesFor(resourceId);
        return {
          status: 'ok',
          summary: [renamed, `The shelf is now "${result.list.shelf.title}".`, describeShelfSync(receipt, result.list.id)].filter(Boolean).join(' '),
          data: { name: result.list.name, shelfTitle: result.list.shelf.title, shelfSync: receipt },
        };
      }
      case 'delete-list': {
        const result = await deleteGaryList(resourceId, input.list);
        if (result.status === 'list-not-found') return { status: 'list-not-found', summary: `You do not have a list called "${input.list}".` };
        const deleted = `Deleted ${result.name} and its ${result.itemCount} title(s).`;
        if (!result.wasPublished) return { status: 'ok', summary: deleted, data: { name: result.name, itemCount: result.itemCount } };
        const receipt = await syncShelvesFor(resourceId);
        return {
          status: 'ok',
          summary: `${deleted} ${shelfSyncFailed(receipt, result.listId) ? 'Plex did not take the shelf down yet; Gary tries again every night.' : 'Its shelf is gone from Plex.'}`,
          data: { name: result.name, itemCount: result.itemCount, shelfSync: receipt },
        };
      }
      case 'publish': {
        const list = await getGaryList(resourceId, input.list);
        if (!list) return { status: 'list-not-found', summary: `You do not have a list called "${input.list}".` };
        if (list.shelf) {
          return { status: 'already-published', summary: `${list.name} is already published as "${list.shelf.title}".`, data: { shelfTitle: list.shelf.title } };
        }
        const ownerName = input.displayName ?? (await getGaryUserProfile(resourceId))?.preferredName?.trim();
        if (!ownerName) {
          return { status: 'name-needed', summary: 'A published shelf shows your name. Ask what name to show, then publish again with displayName.' };
        }
        if (input.shelfTitle && !input.shelfTitle.toLowerCase().includes(ownerName.toLowerCase())) {
          return { status: 'invalid', summary: `A shelf title must include your name, ${ownerName}.` };
        }
        const title = input.shelfTitle ?? `${ownerName}'s ${list.name}`;
        let inventory;
        try {
          inventory = await plexShelfClient.loadInventory();
        } catch (error) {
          return { status: 'service-unavailable', summary: `Could not read Plex to prepare the shelf: ${error instanceof Error ? error.message : String(error)}` };
        }
        const collision = findShelfTitleCollision(inventory, title);
        if (collision || await isGaryShelfTitleTaken(title)) {
          return { status: 'title-taken', summary: `There is already a Plex collection called "${collision?.title ?? title}". Choose a different shelf title.` };
        }
        const resolution = resolveGaryShelfItems(list.items, inventory);
        const preview = await createGaryListPublishPreview({ resourceId, listId: list.id, title, customTitle: input.shelfTitle !== undefined });
        await createPendingIntent({
          resourceId,
          threadId: context.agent?.threadId || resourceId,
          kind: 'gary-list-publish-approval',
          question: `Publish ${list.name} as the shelf "${title}" for everyone on ${serverName()}? Reply yes or no.`,
          options: [{ key: 'yes', label: `Publish "${title}"`, value: { garyListPublishPreviewId: preview.id } }],
          payload: { garyListPublishPreviewId: preview.id },
          ttlMs: 15 * 60_000,
          correlationId: preview.id,
        });
        const onShelf = resolution.matched.map((match) => match.item);
        const notYet = resolution.unmatched.map((entry) => entry.item);
        return {
          status: 'ready',
          summary: [
            `Ready to publish ${list.name} as "${title}".`,
            `Everyone on ${serverName()} will see this shelf, with your name on it, in the Plex Collections tab.`,
            onShelf.length ? `On the shelf now: ${titles(onShelf)}.` : `Nothing on this list is on ${serverName()} yet, so the shelf appears once something is.`,
            notYet.length ? `Not on ${serverName()} yet, so only on the list: ${titles(notYet)}. Nothing gets requested.` : '',
            'Publish it?',
          ].filter(Boolean).join(' '),
          data: { previewId: preview.id, expiresAt: preview.expiresAt, shelfTitle: title, onShelf: onShelf.map(label), notInLibrary: notYet.map(label) },
        };
      }
      case 'confirm-publish': {
        const result = await confirmGaryListPublish(resourceId, input.previewId);
        if (result.status === 'expired') return { status: 'expired', summary: 'That publish preview expired, was already used, or belongs to someone else. Ask to publish again.' };
        if (result.status === 'list-not-found') return { status: 'list-not-found', summary: 'That list no longer exists.' };
        if (result.status === 'already-published') return { status: 'already-published', summary: `${result.listName} is already published as "${result.title}".` };
        if (result.status === 'title-taken') return { status: 'title-taken', summary: `Another shelf is already called "${result.title}". Choose a different shelf title.` };
        const receipt = await syncShelvesFor(resourceId);
        return {
          status: 'published',
          summary: [`Published ${result.listName} as "${result.title}". Everyone on ${serverName()} can see it in Plex Collections.`, describeShelfSync(receipt, result.listId)].filter(Boolean).join(' '),
          data: { name: result.listName, shelfTitle: result.title, shelfSync: receipt },
        };
      }
      case 'unpublish': {
        const result = await unpublishGaryList(resourceId, input.list);
        if (result.status === 'list-not-found') return { status: 'list-not-found', summary: `You do not have a list called "${input.list}".` };
        if (result.status === 'not-published') return { status: 'not-published', summary: `${result.listName} is not published. It is private.` };
        const receipt = await syncShelvesFor(resourceId);
        return {
          status: 'ok',
          summary: `${result.listName} is private again. ${shelfSyncFailed(receipt, result.listId) ? `Plex did not take "${result.title}" down yet; Gary tries again every night.` : `"${result.title}" is gone from Plex.`}`,
          data: { name: result.listName, shelfSync: receipt },
        };
      }
    }
  },
});
