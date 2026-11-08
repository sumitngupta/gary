import { createTool } from '@mastra/core/tools';
import { mediaRequestInputSchema, mediaRequestPlanSchema } from '../schemas/media-request';
import type { MediaRequestPlan } from '../schemas/media-request';
import { serverName } from '../config/branding';

export const planMediaRequestTool = createTool({
  id: 'plan-media-request',
  description:
    `Normalize a movie/show request for Gary. This is intake-only: it does not call ${serverName()} library, media request system, TV/movie download systems, or any media service.`,
  inputSchema: mediaRequestInputSchema,
  outputSchema: mediaRequestPlanSchema,
  execute: async (input) => {
    const request = mediaRequestInputSchema.parse(input);
    const ambiguityReasons: string[] = [];

    if (request.mediaType === 'unknown') {
      ambiguityReasons.push('media type is unknown');
    }

    if (!request.year && !request.tmdbId) {
      ambiguityReasons.push('no year or TMDB id provided');
    }

    const plan: MediaRequestPlan = {
      status: ambiguityReasons.length > 0 ? 'needs-clarification' : 'ready-for-lookup',
      requester: request.requester,
      title: request.title,
      mediaType: request.mediaType,
      year: request.year,
      tmdbId: request.tmdbId,
      notifyWhenAvailable: request.notifyWhenAvailable,
      notificationChannel: request.notifyWhenAvailable ? request.notificationChannel : 'none',
      qualityObjective: request.qualityObjective,
      ambiguityReasons,
      nextChecks: [
        `Check whether the title already exists in ${serverName()} library before creating any request.`,
        'Resolve ambiguity with the requester before making external media requests.',
        'Use approved quality/profile defaults only after the request is unambiguous.',
      ],
      approvalRequiredBefore: [
        'creating or modifying a media request',
        'triggering TV/movie download searches or downloads',
        'deleting, replacing, or re-encoding media files',
        'notifying external users outside the selected channel',
      ],
    };

    return plan;
  },
});
