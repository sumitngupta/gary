import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { deleteGaryPolicyEvents, listGaryPolicyEvents } from '../services/gary-access-policy';
import { deleteMediaAvailabilityWatchesForResource, listMediaAvailabilityWatches } from '../services/media-availability-watch-store';
import { deleteMediaRadarSubscriptionsForResource, listMediaRadarSubscriptions } from '../services/media-radar-subscription-store';
import {
  beginGaryDeletionConfirmation,
  cancelGaryDeletionConfirmation,
  consumeGaryDeletionConfirmation,
  GARY_DELETE_CONFIRMATION_PHRASE,
} from '../services/gary-confirmation-store';
import { deleteGaryUserProfile, getGaryUserProfile } from '../services/gary-user-profile-store';
import { disconnectViewingHistory, getCompactViewingProfile } from '../services/tautulli-viewing-profile';
import { deleteGaryNotificationDeliveries, listGaryNotificationDeliveries } from '../services/gary-notification-delivery-store';
import { deleteGaryMessageReferencesForActor } from '../services/gary-conversation-state-store';
import { deleteGaryOperationsForResource } from '../services/gary-operations-store';
import { deleteGaryListsForResource, exportGaryListsForResource } from '../services/gary-list-store';
import { syncGaryListShelves } from '../services/gary-list-shelf-sync';
import { adminName, serverName } from '../config/branding';
import { forgetPerson, userIdFromResource } from '../channels/people';

export const manageGaryPrivacyTool = createTool({
  id: 'manage-gary-privacy',
  description: 'Export a bounded summary of the current user’s Gary data or permanently delete that user’s Gary conversations, lists, watches, subscriptions, policy records, and linked chats and browsers.',
  inputSchema: z.object({ action: z.enum(['export', 'delete', 'cancel-delete']), confirmDelete: z.boolean().default(false) }),
  outputSchema: z.object({ status: z.string(), summary: z.string(), data: z.record(z.string(), z.unknown()).optional() }),
  execute: async (input, context) => {
    const resourceId = context.agent?.resourceId;
    if (!resourceId || !context.mastra) return { status: 'service-unavailable', summary: 'The current user context is unavailable.' };
    const actorId = resourceId.includes(':') ? resourceId.slice(resourceId.indexOf(':') + 1) : resourceId;
    if (input.action === 'cancel-delete') {
      const cancelled = await cancelGaryDeletionConfirmation(resourceId);
      return {
        status: cancelled ? 'cancelled' : 'nothing-pending',
        summary: cancelled ? 'Cancelled the pending Gary data deletion.' : 'There is no active Gary data deletion to cancel.',
      };
    }
    const [watches, subscriptions, policyEvents, userProfile, viewingProfile, notificationDeliveries, lists] = await Promise.all([
      listMediaAvailabilityWatches(),
      listMediaRadarSubscriptions({ resourceId, includeCancelled: true }),
      listGaryPolicyEvents(actorId, 100),
      getGaryUserProfile(resourceId),
      getCompactViewingProfile(resourceId),
      listGaryNotificationDeliveries(resourceId),
      exportGaryListsForResource(resourceId),
    ]);
    const ownedWatches = watches.filter((watch) => watch.resourceId === resourceId);
    const memory = await context.mastra.getAgent('gary').getMemory({ requestContext: context.requestContext });
    const threads = memory ? await memory.listThreads({ filter: { resourceId }, perPage: false }) : { threads: [] };
    if (input.action === 'export') {
      return {
        status: 'exported',
        summary: `Gary has ${threads.threads.length} conversation(s), ${lists.length} list(s), ${ownedWatches.length} availability watch record(s), ${subscriptions.length} radar record(s), a ${userProfile ? 'saved' : 'blank'} preference profile, and ${policyEvents.length} recent policy event(s) for this user.`,
        data: {
          resourceId,
          conversations: threads.threads.map((thread) => ({ id: thread.id, title: thread.title, createdAt: thread.createdAt, updatedAt: thread.updatedAt })),
          lists: lists.map(({ name, createdAt, updatedAt, shelf, items }) => ({
            name,
            createdAt,
            updatedAt,
            published: Boolean(shelf),
            ...(shelf ? { shelfTitle: shelf.title, publishedAt: shelf.publishedAt } : {}),
            items: items.map(({ title, year, mediaType, note, addedAt }) => ({ title, year, mediaType, note, addedAt })),
          })),
          watches: ownedWatches.map(({ id, title, year, mediaType, seasonNumber, status, createdAt }) => ({ id, title, year, mediaType, seasonNumber, status, createdAt })),
          subscriptions: subscriptions.map(({ id, name, theme, cron, timezone, status, consentedAt, createdAt }) => ({ id, name, theme, cron, timezone, status, consentedAt, createdAt })),
          recentPolicyEvents: policyEvents,
          profile: userProfile,
          viewingProfile,
          notificationDeliveries,
        },
      };
    }
    if (!input.confirmDelete) {
      const confirmation = await beginGaryDeletionConfirmation(resourceId);
      return {
        status: 'confirmation-required',
        summary: `This permanently deletes your Gary conversations, lists, availability watches, recurring radars and their schedules, and Gary policy/event history. Any list you published to Plex comes down too. It also disconnects every chat app and browser linked to you, so you will need a new invite code from ${adminName()} to use Gary again. It does not delete media from ${serverName()}. To continue within 15 minutes, reply exactly: ${confirmation.phrase}. You can also say cancel deletion.`,
      };
    }
    const confirmed = await consumeGaryDeletionConfirmation(resourceId, GARY_DELETE_CONFIRMATION_PHRASE);
    if (!confirmed) {
      return {
        status: 'confirmation-required',
        summary: `No active deletion confirmation was found. Ask to delete your Gary data first, then reply exactly: ${GARY_DELETE_CONFIRMATION_PHRASE}.`,
      };
    }
    for (const subscription of subscriptions) {
      await context.mastra.schedules.delete(subscription.scheduleId).catch(() => undefined);
    }
    for (const thread of threads.threads) await memory?.deleteThread(thread.id);
    const [deletedWatches, deletedSubscriptions, deletedPolicy, deletedProfileRecords, deletedViewingRecords, deletedNotificationDeliveries, deletedMessageReferences, deletedOperations, deletedLists] = await Promise.all([
      deleteMediaAvailabilityWatchesForResource(resourceId),
      deleteMediaRadarSubscriptionsForResource(resourceId),
      deleteGaryPolicyEvents(actorId),
      deleteGaryUserProfile(resourceId),
      disconnectViewingHistory(resourceId),
      deleteGaryNotificationDeliveries(resourceId),
      deleteGaryMessageReferencesForActor(actorId),
      deleteGaryOperationsForResource(resourceId),
      deleteGaryListsForResource(resourceId),
    ]);
    const userId = userIdFromResource(resourceId);
    const deletedIdentities = userId ? await forgetPerson(userId) : 0;
    const shelfSync = await syncGaryListShelves({ resourceId }).catch((error: unknown) => ({ changes: [], errors: [String(error)] }));
    const shelvesPending = shelfSync.errors.length > 0 || shelfSync.changes.some((change) => change.outcome === 'failed');
    const shelfNote = deletedLists.shelves === 0 && shelfSync.changes.length === 0 ? ''
      : shelvesPending ? ' Plex did not take your published shelves down yet; Gary tries again every night.' : ' Your published shelves are gone from Plex.';
    return { status: 'deleted', summary: `Deleted ${threads.threads.length} conversation(s), ${deletedLists.lists} list(s) with ${deletedLists.items} title(s), ${deletedWatches} watch record(s), ${deletedSubscriptions} radar record(s), ${deletedProfileRecords} profile/escalation record(s), ${deletedViewingRecords} viewing-profile record(s), ${deletedNotificationDeliveries} notification delivery record(s), ${deletedMessageReferences} message reference(s), ${deletedOperations} pending operation record(s), ${deletedPolicy.policyEvents + deletedPolicy.inboundEvents} policy/event record(s), and ${deletedIdentities} linked chat(s) or browser(s) for this user.${shelfNote}` };
  },
});
