import { createTool } from '@mastra/core/tools';
import {
  mediaStatusLookupInputSchema,
  mediaStatusLookupOutputSchema,
  type MediaStatusLookupOutput,
} from '../schemas/media-status';
import {
  listSeerrMedia,
  listSeerrRequests,
  searchSeerr,
  seerrMediaStatusLabels,
  seerrRequestStatusLabels,
  seerrTitle,
  seerrYear,
} from '../services/seerr-readonly-client';
import { serverName } from '../config/branding';

function friendlyMediaStatus(code?: number) {
  if (code === undefined) {
    return 'not tracked yet';
  }

  return seerrMediaStatusLabels.get(code) || `unknown status ${code}`;
}

function friendlyRequestStatus(code?: number) {
  if (code === undefined) {
    return 'unknown request status';
  }

  return seerrRequestStatusLabels.get(code) || `unknown request status ${code}`;
}

function approvalBoundaries() {
  return [
    'creating, approving, declining, or modifying media requests',
    'triggering TV/movie download searches or downloads',
    'deleting, replacing, or re-encoding media files',
    'sending requester notifications',
  ];
}

function formatReleaseDate(date?: string) {
  if (!date) {
    return undefined;
  }

  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return date;
  }

  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(parsed);
}

function titleWithYear(title: string, year?: number) {
  return `${title}${year ? ` (${year})` : ''}`;
}

function casualFoundSummary(
  selected: { title: string; year?: number },
  mediaStatus: { available: boolean; label: string },
  requests: { statusLabel: string }[],
) {
  const title = titleWithYear(selected.title, selected.year);

  if (mediaStatus.available) {
    return `${title} is already available in ${serverName()}.`;
  }

  if (requests.length > 0) {
    const hasActiveRequest = requests.some((request) =>
      ['approved', 'processing', 'completed', 'pending approval'].includes(request.statusLabel),
    );

    if (hasActiveRequest) {
      return `Not yet — ${title} is already requested but has not landed in ${serverName()}.`;
    }
  }

  if (mediaStatus.label === 'partially available') {
    return `${title} is partially available in ${serverName()}.`;
  }

  return `${title} is not available in ${serverName()} yet.`;
}

export async function checkMediaStatus(input: unknown): Promise<MediaStatusLookupOutput> {
    const request = mediaStatusLookupInputSchema.parse(input);

    try {
      const searchResults = await searchSeerr(request.query);
      const matches = searchResults
        .filter((result) => request.mediaType === 'unknown' || result.mediaType === request.mediaType)
        .map((result) => ({
          title: seerrTitle(result),
          mediaType: result.mediaType,
          year: seerrYear(result),
          releaseDate: result.releaseDate || result.firstAirDate,
          tmdbId: result.id,
          overview: result.overview,
        }))
        .filter((result) => request.year === undefined || result.year === request.year)
        .slice(0, 5);

      if (matches.length === 0) {
        return {
          status: 'not-found',
          query: request.query,
          requester: request.requester,
          matches: [],
          requests: [],
          casualSummary: `I could not find a match for "${request.query}"${request.year ? ` (${request.year})` : ''}.`,
          summary: `I could not find a media request system match for "${request.query}"${request.year ? ` (${request.year})` : ''}.`,
          nextReadOnlyChecks: ['Try a more specific title, year, or movie/show type.'],
          approvalRequiredBefore: approvalBoundaries(),
        };
      }

      if (matches.length > 1 && request.year === undefined) {
        return {
          status: 'needs-clarification',
          query: request.query,
          requester: request.requester,
          matches,
          requests: [],
          casualSummary: `I found a few possible matches for "${request.query}". Which year or version did you mean?`,
          summary: `I found multiple possible matches for "${request.query}". Ask for the year or whether this is a movie or show before checking queue status.`,
          nextReadOnlyChecks: ['Confirm the exact title/year, then run the read-only status lookup again.'],
          approvalRequiredBefore: approvalBoundaries(),
        };
      }

      const selected = matches[0];
      const [mediaRecords, requestRecords] = await Promise.all([
        listSeerrMedia(),
        listSeerrRequests(),
      ]);
      const mediaRecord = mediaRecords.find(
        (record) => record.mediaType === selected.mediaType && record.tmdbId === selected.tmdbId,
      );
      const matchingRequests = requestRecords
        .filter((record) => record.media?.mediaType === selected.mediaType && record.media.tmdbId === selected.tmdbId)
        .map((record) => ({
          requestId: record.id,
          statusCode: record.status,
          statusLabel: friendlyRequestStatus(record.status),
          requestedBy: record.requestedBy?.displayName
            || record.requestedBy?.username
            || record.requestedBy?.plexUsername
            || record.requestedBy?.email,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        }));

      const label = friendlyMediaStatus(mediaRecord?.status);
      const available = mediaRecord?.status === 5;
      const requestText = matchingRequests.length > 0
        ? `Latest request status: ${matchingRequests[0].statusLabel}.`
        : 'No matching request record was found.';
      const releaseText = selected.releaseDate
        ? `Release date: ${formatReleaseDate(selected.releaseDate)}. `
        : '';

      return {
        status: 'found',
        query: request.query,
        requester: request.requester,
        selected,
        matches,
        mediaStatus: {
          code: mediaRecord?.status,
          label,
          available,
        },
        requests: matchingRequests.slice(0, 5),
        casualSummary: casualFoundSummary(selected, { available, label }, matchingRequests),
        summary: `${selected.title}${selected.year ? ` (${selected.year})` : ''} is ${label} in the media request system. ${releaseText}${requestText}`,
        nextReadOnlyChecks: [
          'If the status is unclear, check TV/movie download history read-only for download/import details.',
          `If the item is available, check ${serverName()} library read-only before telling a requester it is ready.`,
        ],
        approvalRequiredBefore: approvalBoundaries(),
      };
    } catch (error) {
      return {
        status: 'service-unavailable',
        query: request.query,
        requester: request.requester,
        matches: [],
        requests: [],
        casualSummary: `I could not check "${request.query}" right now because the media request system is unavailable.`,
        summary: `I could not reach the media request system for a read-only status lookup: ${error instanceof Error ? error.message : String(error)}`,
        nextReadOnlyChecks: ['Verify the media request system is reachable from Gary and that the API key can be read from local config.'],
        approvalRequiredBefore: approvalBoundaries(),
      };
    }
}

export const checkMediaStatusTool = createTool({
  id: 'check-media-status',
  description:
    `Read-only lookup for a movie/show in ${serverName()} media request system. Searches metadata, request records, and media availability without creating requests, downloads, or notifications.`,
  inputSchema: mediaStatusLookupInputSchema,
  outputSchema: mediaStatusLookupOutputSchema,
  execute: checkMediaStatus,
});
