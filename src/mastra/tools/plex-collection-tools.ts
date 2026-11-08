import { createTool } from '@mastra/core/tools';
import {
  executePlexCollectionChangeInputSchema, executePlexCollectionChangeOutputSchema,
  inspectPlexCollectionsInputSchema, inspectPlexCollectionsOutputSchema,
  previewPlexCollectionChangeInputSchema, previewPlexCollectionChangeOutputSchema,
  type PlexCollectionResolution,
} from '../schemas/plex-collection';
import { createPlexCollection, deletePlexCollection, listPlexCollections, resolveExactPlexLibraryItems, type PlexCollectionView } from '../services/plex-readonly-client';
import { collectionOwner, consumePlexCollectionPreview, createPlexCollectionPreview, recordCollectionOwner, recordPlexCollectionEvent, removeCollectionOwner, replaceCollectionOwner } from '../services/plex-collection-store';
import { createPendingIntent } from '../services/gary-operations-store';
import { checkMediaStatuses } from './check-media-statuses-tool';
import { callerActor } from '../channels/gary-channels';

async function ownership(ratingKey: string, actorId: string) {
  const owner = await collectionOwner(ratingKey);
  return owner === actorId ? 'caller' as const : owner ? 'other' as const : 'legacy' as const;
}
function normalize(value: string) { return value.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim(); }
export async function restoreCollectionSnapshot(recreate: () => Promise<string>) {
  try { return { restored: true as const, ratingKey: await recreate() }; } catch (error) { return { restored: false as const, error: error instanceof Error ? error.message : String(error) }; }
}
async function publicView(collection: PlexCollectionView, actorId: string) { return { ...collection, owner: await ownership(collection.ratingKey, actorId) }; }

export const inspectPlexCollectionsTool = createTool({
  id: 'inspect-plex-collections', description: 'Read current Plex movie/TV collections, exact membership, descriptions, and whether the current caller owns each Gary-managed collection. Legacy collections are owner-managed.',
  inputSchema: inspectPlexCollectionsInputSchema, outputSchema: inspectPlexCollectionsOutputSchema,
  execute: async (input, context) => {
    try {
      const { actorId } = await callerActor(context); let collections = await listPlexCollections(input.mediaType);
      if (input.title) collections = collections.filter((item) => normalize(item.title) === normalize(input.title!));
      const views = await Promise.all(collections.map((item) => publicView(item, actorId)));
      return { status: views.length ? 'ok' as const : 'not-found' as const, collections: views, summary: views.length ? `Found ${views.length} exact Plex collection${views.length === 1 ? '' : 's'}.` : 'No matching Plex collection was found.' };
    } catch (error) { return { status: 'service-unavailable' as const, collections: [], summary: `Could not inspect Plex collections: ${error instanceof Error ? error.message : String(error)}` }; }
  },
});

export const previewPlexCollectionChangeTool = createTool({
  id: 'preview-plex-collection-change', description: 'Create a creator-bound immutable preview for a Plex collection create, metadata/membership update, or collection-only deletion. Resolves exact available library items and reports missing or ambiguous items. Never requests media or mutates Plex.',
  inputSchema: previewPlexCollectionChangeInputSchema, outputSchema: previewPlexCollectionChangeOutputSchema,
  execute: async (raw, context) => {
    const input = previewPlexCollectionChangeInputSchema.parse(raw); const { actorId, isAdmin } = await callerActor(context);
    try {
      const collections = await listPlexCollections(input.mediaType);
      const matches = collections.filter((item) => normalize(item.title) === normalize(input.collectionTitle));
      const existing = matches[0];
      if (matches.length > 1) return { status: 'ambiguous' as const, action: input.action, collectionTitle: input.collectionTitle, available: [], alreadyRequested: [], missing: [], ambiguous: [], removed: [], summary: 'More than one exact collection has that title; no preview was created.' };
      if (input.action === 'create' && existing) return { status: 'denied' as const, action: input.action, collectionTitle: input.collectionTitle, available: [], alreadyRequested: [], missing: [], ambiguous: [], removed: [], summary: 'A collection with that exact title already exists. Update it only if you own it.' };
      if (input.action !== 'create' && !existing) return { status: 'not-found' as const, action: input.action, collectionTitle: input.collectionTitle, available: [], alreadyRequested: [], missing: [], ambiguous: [], removed: [], summary: 'That collection was not found.' };
      if (existing) {
        const owner = await collectionOwner(existing.ratingKey);
        if (owner !== actorId && !(isAdmin && !owner)) return { status: 'denied' as const, action: input.action, collectionTitle: input.collectionTitle, available: [], alreadyRequested: [], missing: [], ambiguous: [], removed: [], summary: owner ? 'You can manage only collections you created.' : 'This legacy collection is owner-managed.' };
      }
      const resolutions = await resolveExactPlexLibraryItems([...input.add, ...input.remove]);
      const available: PlexCollectionResolution[] = []; const alreadyRequested: PlexCollectionResolution[] = []; const missing: PlexCollectionResolution[] = []; const ambiguous: PlexCollectionResolution[] = [];
      for (const result of resolutions.slice(0, input.add.length)) {
        const base = result.candidate;
        if (result.matches.length === 1) available.push({ ...base, ratingKey: result.matches[0].ratingKey, resolvedTitle: result.matches[0].title, resolvedYear: result.matches[0].year });
        else if (result.matches.length === 0) {}
        else ambiguous.push({ ...base, reason: 'More than one exact Plex item matched.' });
      }
      const unresolvedAdds = resolutions.slice(0, input.add.length).filter((result) => result.matches.length === 0);
      for (let offset = 0; offset < unresolvedAdds.length; offset += 20) {
        const chunk = unresolvedAdds.slice(offset, offset + 20);
        const statuses = await checkMediaStatuses({ titles: chunk.map((item) => ({ title: item.candidate.title, year: item.candidate.year, mediaType: item.candidate.mediaType })), requester: actorId || 'gary-user' });
        for (let index = 0; index < chunk.length; index++) {
          const candidate = chunk[index].candidate; const status = statuses.results[index];
          const resolved = { ...candidate, resolvedTitle: status?.resolvedTitle, resolvedYear: status?.resolvedYear };
          if (status?.status === 'requested' || status?.status === 'partially-available') alreadyRequested.push({ ...resolved, reason: status.summary });
          else if (status?.status === 'missing') missing.push({ ...resolved, reason: status.summary });
          else ambiguous.push({ ...resolved, reason: status?.summary || 'Could not resolve an exact title.' });
        }
      }
      const removed: PlexCollectionResolution[] = [];
      for (const result of resolutions.slice(input.add.length)) {
        const member = existing?.items.find((item) => normalize(item.title) === normalize(result.candidate.title) && (result.candidate.year === undefined || item.year === result.candidate.year));
        if (member) removed.push({ ...result.candidate, ratingKey: member.ratingKey, resolvedTitle: member.title, resolvedYear: member.year });
        else missing.push({ ...result.candidate, reason: 'Not currently a member of this collection.' });
      }
      if (ambiguous.length) return { status: 'ambiguous' as const, action: input.action, collectionTitle: input.collectionTitle, resultingTitle: input.newTitle || input.collectionTitle, available, alreadyRequested, missing, ambiguous, removed, summary: 'At least one title is ambiguous or unmatched; no preview was frozen.' };
      if (input.action === 'create' && available.length === 0) return { status: 'denied' as const, action: input.action, collectionTitle: input.collectionTitle, resultingTitle: input.newTitle || input.collectionTitle, available, alreadyRequested, missing, ambiguous, removed, summary: 'Plex cannot create an empty collection. No preview was frozen; missing and in-progress titles were not requested.' };
      const preview = await createPlexCollectionPreview({ actorId, input, collectionRatingKey: existing?.ratingKey, before: existing, available, alreadyRequested, missing, ambiguous, removed });
      const resourceId = context?.agent?.resourceId || actorId; const threadId = context?.agent?.threadId || resourceId;
      if (resourceId && threadId) await createPendingIntent({ resourceId, threadId, kind: 'plex-collection-change-approval', question: `Apply the exact ${input.action} preview for ${input.newTitle || input.collectionTitle}? Reply yes or no.`, options: [{ key: 'yes', label: `Apply ${input.action} preview`, value: { plexCollectionPreviewId: preview.id } }], payload: { plexCollectionPreviewId: preview.id }, ttlMs: 15 * 60_000, correlationId: preview.id });
      return { status: 'ready' as const, previewId: preview.id, expiresAt: preview.expiresAt, action: input.action, collectionTitle: input.collectionTitle, resultingTitle: input.newTitle || input.collectionTitle, available, alreadyRequested, missing, ambiguous, removed, summary: `Preview ready: ${available.length} available, ${alreadyRequested.length} already requested/in progress, ${missing.length} missing, and ${removed.length} removal(s). Nothing was requested. Collection changes affect no media files or request records.` };
    } catch (error) { return { status: 'service-unavailable' as const, action: input.action, collectionTitle: input.collectionTitle, available: [], alreadyRequested: [], missing: [], ambiguous: [], removed: [], summary: `Could not prepare the collection preview: ${error instanceof Error ? error.message : String(error)}` }; }
  },
});

export const executePlexCollectionChangeTool = createTool({
  id: 'execute-plex-collection-change', description: 'Apply exactly one creator-bound, single-use, conversationally approved Plex collection preview. Never requests, deletes, or changes media files or request records.',
  inputSchema: executePlexCollectionChangeInputSchema, outputSchema: executePlexCollectionChangeOutputSchema,
  execute: async ({ previewId }, context) => {
    const { actorId } = await callerActor(context); const preview = await consumePlexCollectionPreview(previewId, actorId);
    if (!preview) return { status: 'expired' as const, summary: 'That preview expired, was already used, or belongs to another user.' };
    const input = preview.input; const before = preview.before as PlexCollectionView | undefined;
    try {
      if (input.action === 'delete') {
        if (!preview.collectionRatingKey) throw new Error('The frozen collection no longer has an exact Plex key.');
        await deletePlexCollection(preview.collectionRatingKey); await removeCollectionOwner(preview.collectionRatingKey, actorId);
        await recordPlexCollectionEvent({ previewId, actorId, action: input.action, status: 'deleted', before, rollback: before });
        return { status: 'deleted' as const, summary: `Deleted the ${input.collectionTitle} collection only. Media files and request records were unchanged.`, rollback: 'The audit receipt retains the exact prior membership and metadata for owner recovery.' };
      }
      const currentKeys = before?.items.map((item) => item.ratingKey) || [];
      const removedKeys = new Set(preview.removed.map((item) => item.ratingKey).filter(Boolean));
      const ratingKeys = [...new Set([...currentKeys.filter((key) => !removedKeys.has(key)), ...preview.available.map((item) => item.ratingKey).filter((key): key is string => Boolean(key))])];
      if (!ratingKeys.length) throw new Error('Plex cannot create an empty collection.');
      if (preview.collectionRatingKey) await deletePlexCollection(preview.collectionRatingKey);
      const sectionKey = before?.sectionKey || preview.available[0]?.ratingKey && (await resolveExactPlexLibraryItems([preview.available[0]]) )[0]?.matches[0]?.sectionKey;
      if (!sectionKey) throw new Error('No exact Plex library section was resolved.');
      const newKey = await createPlexCollection({ title: input.newTitle || input.collectionTitle, summary: input.description ?? before?.summary, mediaType: input.mediaType, sectionKey, ratingKeys });
      await replaceCollectionOwner(preview.collectionRatingKey, newKey, actorId);
      const after = (await listPlexCollections(input.mediaType)).find((item) => item.ratingKey === newKey);
      if (!after) throw new Error('Plex did not verify the resulting collection.');
      await recordPlexCollectionEvent({ previewId, actorId, action: input.action, status: input.action === 'create' ? 'created' : 'updated', before, after, rollback: before });
      return { status: input.action === 'create' ? 'created' as const : 'updated' as const, collection: await publicView(after, actorId), summary: `${input.action === 'create' ? 'Created' : 'Updated'} ${after.title} with ${after.items.length} available title(s). ${preview.missing.length} missing title(s) were not requested. Media files and request records were unchanged.`, rollback: before ? 'The audit receipt retains the exact prior membership and metadata for owner recovery.' : 'Deleting this newly created collection restores the prior absent state.' };
    } catch (error) {
      const restore = before && preview.collectionRatingKey && !(await listPlexCollections(input.mediaType)).some((item) => item.ratingKey === preview.collectionRatingKey)
        ? await restoreCollectionSnapshot(async () => { const key = await createPlexCollection({ title: before.title, summary: before.summary, mediaType: before.mediaType, sectionKey: before.sectionKey, ratingKeys: before.items.map((item) => item.ratingKey) }); await recordCollectionOwner(key, actorId); return key; })
        : undefined;
      await recordPlexCollectionEvent({ previewId, actorId, action: input.action, status: restore && !restore.restored ? 'failed_restore_failed' : 'failed', before, after: restore ? { restore } : undefined, rollback: before });
      const rollback = !before ? undefined
        : !restore ? 'The original collection is still in Plex.'
        : restore.restored ? 'The original collection was restored from the frozen snapshot.'
        : `Restoring the original collection also failed (${restore.error}). The audit receipt keeps the prior membership for manual recovery.`;
      return { status: 'failed' as const, summary: `The collection change failed: ${error instanceof Error ? error.message : String(error)}`, rollback };
    }
  },
});
