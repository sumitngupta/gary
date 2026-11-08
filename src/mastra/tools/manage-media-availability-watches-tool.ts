import { createTool } from '@mastra/core/tools';
import {
  mediaAvailabilityWatchManagementInputSchema,
  mediaAvailabilityWatchManagementOutputSchema,
  type MediaAvailabilityWatchManagementOutput,
} from '../schemas/media-availability-watch';
import {
  cancelMediaAvailabilityWatches,
  listMediaAvailabilityWatches,
} from '../services/media-availability-watch-store';
import { serverName } from '../config/branding';

function watchLabel(watch: { title: string; year?: number; seasonNumber?: number }) {
  const year = watch.year ? ` (${watch.year})` : '';
  const season = watch.seasonNumber !== undefined ? ` season ${watch.seasonNumber}` : '';
  return `${watch.title}${year}${season}`;
}

export const manageMediaAvailabilityWatchesTool = createTool({
  id: 'manage-media-availability-watches',
  description:
    `List or cancel ${serverName()} availability notification watches for the current chat. Does not request, search, download, or modify media services.`,
  inputSchema: mediaAvailabilityWatchManagementInputSchema,
  outputSchema: mediaAvailabilityWatchManagementOutputSchema,
  execute: async (input, context): Promise<MediaAvailabilityWatchManagementOutput> => {
    const request = mediaAvailabilityWatchManagementInputSchema.parse(input);
    const resourceId = context.agent?.resourceId || request.resourceId;
    const threadId = context.agent?.threadId || request.threadId;

    try {
      if (request.action === 'cancel') {
        const cancelled = await cancelMediaAvailabilityWatches({
          watchId: request.watchId,
          title: request.title,
          resourceId,
          threadId,
        });

        if (cancelled.length === 0) {
          return {
            status: 'not-found',
            watches: [],
            summary: request.title
              ? `I do not have an active ${serverName()} availability watch for ${request.title} in this chat.`
              : `I did not find a matching active ${serverName()} availability watch in this chat.`,
          };
        }

        return {
          status: 'cancelled',
          watches: cancelled,
          summary: `Cancelled ${cancelled.length === 1 ? `${serverName()} availability watch` : `${cancelled.length} ${serverName()} availability watches`}: ${cancelled.map(watchLabel).join(', ')}.`,
        };
      }

      const all = await listMediaAvailabilityWatches('active');
      const watches = all.filter((watch) =>
        (!resourceId || watch.resourceId === resourceId)
        && (!threadId || watch.threadId === threadId),
      );

      if (watches.length === 0) {
        return {
          status: 'listed',
          watches: [],
          summary: `There are no active ${serverName()} availability watches for this chat.`,
        };
      }

      return {
        status: 'listed',
        watches,
        summary: `Active ${serverName()} availability watches: ${watches.map(watchLabel).join(', ')}.`,
      };
    } catch (error) {
      return {
        status: 'service-unavailable',
        watches: [],
        summary: `I could not manage ${serverName()} availability watches right now: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});
