import { createTool } from '@mastra/core/tools';
import {
  mediaRequestCreateInputSchema,
  mediaRequestCreateOutputSchema,
  type MediaRequestCreateInput,
  type MediaRequestCreateOutput,
} from '../schemas/media-request';
import {
  createSeerrRequest,
  findSeerrRequestReceipt,
  getSeerrTitleDetails,
  listSeerrMedia,
  listSeerrRequests,
  searchSeerr,
  seerrTitle,
  seerrYear,
  seerrRequestStatusLabels,
} from '../services/seerr-readonly-client';
import { appendMediaRequestLedger } from '../services/media-request-ledger';
import { randomUUID } from 'node:crypto';
import { appendOperationEvent } from '../services/gary-operations-store';
import { createMediaAvailabilityWatch } from '../services/media-availability-watch-store';
import { getGaryUserProfile } from '../services/gary-user-profile-store';
import { readConfiguredStorageHealth, type StorageHealth } from '../services/storage-health';
import { serverName, serverNameTitle } from '../config/branding';
import { assertMutationAllowed, hardQualityProfileId } from '../config/gary-config';

export const LARGE_TV_CATALOG_SEASON_THRESHOLD = 6;

export function storageAllowsMediaAcquisition(health: StorageHealth) {
  return health.status !== 'critical' && health.status !== 'unavailable';
}

export function tvCatalogSeasonScope(details: {
  numberOfSeasons?: number;
  seasons?: Array<{ seasonNumber?: number }>;
}, requestedSeasons?: 'all' | number[]) {
  const explicitScope = Array.isArray(requestedSeasons) && requestedSeasons.length === 0
    ? undefined
    : requestedSeasons;
  const regularSeasons = [...new Set(
    (details.seasons || [])
      .map((season) => season.seasonNumber)
      .filter((season): season is number => typeof season === 'number' && season > 0),
  )].sort((a, b) => a - b);
  const seasonCount = regularSeasons.length || details.numberOfSeasons || 0;

  if (explicitScope !== undefined || seasonCount < LARGE_TV_CATALOG_SEASON_THRESHOLD) {
    return { requiresScope: false, seasonCount, suggestedSeasons: [] as number[] };
  }

  const suggestedSeasons = regularSeasons.length > 0 ? regularSeasons.slice(0, 2) : [1, 2];
  return { requiresScope: true, seasonCount, suggestedSeasons };
}

export function resolveMediaRequestQualityProfile(request: MediaRequestCreateInput) {
  if (request.qualityObjective !== '4k-dv-atmos-hard') return undefined;
  return hardQualityProfileId(request.mediaType);
}

export function resolveMediaRequester(inputRequester: string, resourceId?: string, preferredName?: string) {
  if (resourceId?.startsWith('whatsapp:') && preferredName?.trim()) return preferredName.trim();
  return inputRequester;
}

export async function ensureMediaRequestLifecycleWatch(
  input: MediaRequestCreateInput,
  result: MediaRequestCreateOutput,
  context: { resourceId?: string; threadId?: string; correlationId: string },
) {
  if (!context.resourceId || !context.threadId || !['created', 'already-requested'].includes(result.status)) return undefined;
  const created = await createMediaAvailabilityWatch({
    title: result.title,
    mediaType: result.mediaType,
    year: result.year,
    tmdbId: result.tmdbId,
    requester: result.requester,
    resourceId: context.resourceId,
    threadId: context.threadId,
    correlationId: context.correlationId,
    channel: input.notifyWhenAvailable ? input.notificationChannel : 'none',
  });
  await appendOperationEvent({
    correlationId: context.correlationId,
    resourceId: context.resourceId,
    threadId: context.threadId,
    requestId: result.requestId ? String(result.requestId) : undefined,
    phase: created.created ? 'lifecycle-watch-created' : 'lifecycle-watch-already-active',
    detail: { watchId: created.watch.id, notificationChannel: created.watch.channel },
  });
  return created.watch;
}

function friendlyRequestStatus(code?: number) {
  if (code === undefined) {
    return 'unknown request status';
  }

  return seerrRequestStatusLabels.get(code) || `unknown request status ${code}`;
}

function normalizeTitle(title: string) {
  return title.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ');
}

type CanonicalRequestCandidate = {
  title: string;
  mediaType: 'movie' | 'tv';
  year?: number;
  tmdbId: number;
};

export function selectCanonicalRequestCandidate(
  request: { title: string; mediaType: 'movie' | 'tv'; year?: number; tmdbId?: number },
  candidates: CanonicalRequestCandidate[],
) {
  return candidates.find((candidate) =>
    candidate.mediaType === request.mediaType
    && (request.tmdbId === undefined || candidate.tmdbId === request.tmdbId)
    && normalizeTitle(candidate.title) === normalizeTitle(request.title)
    && (request.year === undefined || candidate.year === request.year));
}

async function resolveCanonicalRequest(request: ReturnType<typeof mediaRequestCreateInputSchema.parse>) {
  const searchResults = await searchSeerr(request.title);
  const candidates = searchResults
    .filter((result) => result.mediaType === request.mediaType)
    .map((result) => ({
      title: seerrTitle(result),
      mediaType: result.mediaType,
      year: seerrYear(result),
      tmdbId: result.id,
    }));

  // Seerr orders search results by relevance. Multiple TMDB entries can share
  // an exact title and year, so use the first exact result just as the status
  // lookup does. Prefer a supplied TMDB id when the preceding lookup has one.
  const selected = selectCanonicalRequestCandidate(request, candidates);

  if (!selected) {
    throw new Error(
      `Could not verify exact metadata for ${request.title}${request.year ? ` (${request.year})` : ''}; refusing to create a media request.`,
    );
  }

  return {
    ...request,
    title: selected.title,
    year: selected.year || request.year,
    tmdbId: selected.tmdbId,
  };
}

export async function createMediaRequest(input: unknown): Promise<MediaRequestCreateOutput> {
  const parsedRequest = mediaRequestCreateInputSchema.parse(input);
  if (parsedRequest.mediaType === 'tv' && parsedRequest.episodeScope) {
    return { ...parsedRequest, status: 'blocked', summary: `No request was created for ${parsedRequest.title}. The requested episode scope (${parsedRequest.episodeScope}) cannot be enforced by the season-only request API. Resolve the relevant season and explain that alternative; do not request its backlog without the user's agreement.` };
  }

  try {
    assertMutationAllowed('request');
  } catch (error) {
    return { ...parsedRequest, status: 'blocked', summary: error instanceof Error ? error.message : String(error) };
  }

  try {
    const storage = await readConfiguredStorageHealth();
    if (storage && !storageAllowsMediaAcquisition(storage)) {
      return {
        status: 'service-unavailable',
        requester: parsedRequest.requester,
        title: parsedRequest.title,
        mediaType: parsedRequest.mediaType,
        year: parsedRequest.year,
        notifyWhenAvailable: parsedRequest.notifyWhenAvailable,
        notificationChannel: parsedRequest.notificationChannel,
        qualityObjective: parsedRequest.qualityObjective,
        summary: storage.status === 'critical'
          ? `${serverNameTitle()} media storage is at ${storage.usedPercent}% used with ${storage.available || 'limited space'} available. New acquisition is paused until storage pressure is reduced.`
          : `${serverNameTitle()} cannot verify current media-storage capacity, so new acquisition is paused fail-closed.`,
      };
    }
    const request = await resolveCanonicalRequest(parsedRequest);
      const [mediaRecords, requestRecords] = await Promise.all([
        listSeerrMedia(),
        listSeerrRequests(),
      ]);
      const mediaRecord = mediaRecords.find(
        (record) => record.mediaType === request.mediaType && record.tmdbId === request.tmdbId,
      );

      if (mediaRecord?.status === 5) {
        const output: MediaRequestCreateOutput = {
          status: 'already-available',
          requester: request.requester,
          title: request.title,
          mediaType: request.mediaType,
          year: request.year,
          tmdbId: request.tmdbId,
          notifyWhenAvailable: request.notifyWhenAvailable,
          notificationChannel: request.notificationChannel,
          qualityObjective: request.qualityObjective,
          summary: `${request.title}${request.year ? ` (${request.year})` : ''} is already available in ${serverName()}. No request was created.`,
        };
        return output;
      }

      if (mediaRecord?.status === 6) {
        return {
          status: 'blocked',
          requester: request.requester,
          title: request.title,
          mediaType: request.mediaType,
          year: request.year,
          tmdbId: request.tmdbId,
          notifyWhenAvailable: request.notifyWhenAvailable,
          notificationChannel: request.notificationChannel,
          qualityObjective: request.qualityObjective,
          summary: `${request.title}${request.year ? ` (${request.year})` : ''} was intentionally deleted and blocklisted. No request was created.`,
        };
      }

      const matchingRequest = requestRecords.find(
        (record) => record.media?.mediaType === request.mediaType && record.media.tmdbId === request.tmdbId,
      );

      if (matchingRequest) {
        const output: MediaRequestCreateOutput = {
          status: 'already-requested',
          requester: request.requester,
          title: request.title,
          mediaType: request.mediaType,
          year: request.year,
          tmdbId: request.tmdbId,
          requestId: matchingRequest.id,
          requestStatus: friendlyRequestStatus(matchingRequest.status),
          notifyWhenAvailable: request.notifyWhenAvailable,
          notificationChannel: request.notificationChannel,
          qualityObjective: request.qualityObjective,
          summary: `${request.title}${request.year ? ` (${request.year})` : ''} is already requested (${friendlyRequestStatus(matchingRequest.status)}). No duplicate request was created.`,
        };
        const ledgerPath = await appendMediaRequestLedger(request, output);
        return { ...output, ledgerPath };
      }

      if (request.mediaType === 'tv') {
        const details = await getSeerrTitleDetails('tv', request.tmdbId);
        const scope = tvCatalogSeasonScope(details, request.seasons);
        if (scope.requiresScope) {
          return {
            status: 'needs-season-scope',
            requester: request.requester,
            title: request.title,
            mediaType: request.mediaType,
            year: request.year,
            tmdbId: request.tmdbId,
            notifyWhenAvailable: request.notifyWhenAvailable,
            notificationChannel: request.notificationChannel,
            qualityObjective: request.qualityObjective,
            seasonCount: scope.seasonCount,
            suggestedSeasons: scope.suggestedSeasons,
            summary: `${request.title}${request.year ? ` (${request.year})` : ''} has ${scope.seasonCount} seasons. Before requesting it, ask whether they want all seasons or want to start with seasons ${scope.suggestedSeasons.join(' and ')}.`,
          };
        }
      }

      let created = await createSeerrRequest({
        mediaType: request.mediaType,
        mediaId: request.tmdbId,
        seasons: request.seasons,
        profileId: resolveMediaRequestQualityProfile(request),
      });
      if (!created?.id) created = (await findSeerrRequestReceipt(request.mediaType, request.tmdbId))!;
      // Some Seerr failures are transient and return no usable body before the
      // request is persisted. Reconcile first, then retry the idempotent exact
      // request once and perform the same bounded read-back.
      if (!created?.id) {
        try {
          created = await createSeerrRequest({
            mediaType: request.mediaType,
            mediaId: request.tmdbId,
            seasons: request.seasons,
            profileId: resolveMediaRequestQualityProfile(request),
          });
        } catch {
          // A duplicate/conflict response can mean the first request landed;
          // the exact read-back below remains the source of truth.
        }
        if (!created?.id) created = (await findSeerrRequestReceipt(request.mediaType, request.tmdbId))!;
      }
      if (!created?.id) {
        throw new Error(`${serverName()} returned no verifiable request receipt; the request was not confirmed`);
      }
      const requestStatus = friendlyRequestStatus(created.status);
      const output: MediaRequestCreateOutput = {
        status: 'created',
        requester: request.requester,
        title: request.title,
        mediaType: request.mediaType,
        year: request.year,
        tmdbId: request.tmdbId,
        requestId: created.id,
        requestStatus,
        notifyWhenAvailable: request.notifyWhenAvailable,
        notificationChannel: request.notificationChannel,
        qualityObjective: request.qualityObjective,
        summary: `${request.title}${request.year ? ` (${request.year})` : ''} was requested for ${request.requester}. Current request status: ${requestStatus}.`,
      };
      const ledgerPath = await appendMediaRequestLedger(request, output);
      return { ...output, ledgerPath };
  } catch (error) {
    return {
      status: 'service-unavailable',
      requester: parsedRequest.requester,
      title: parsedRequest.title,
      mediaType: parsedRequest.mediaType,
      year: parsedRequest.year,
      notifyWhenAvailable: parsedRequest.notifyWhenAvailable,
      notificationChannel: parsedRequest.notificationChannel,
      qualityObjective: parsedRequest.qualityObjective,
      summary: `I could not create the media request: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export const createMediaRequestTool = createTool({
  id: 'create-media-request',
  description:
    `Create one exact movie/show request in ${serverName()} media request system after the user explicitly asks to request/get/add it and read-only availability/request checks confirm it is missing. For TV catalogs with 6 or more seasons, an omitted seasons field returns needs-season-scope instead of requesting the whole catalog; call again with seasons "all" only after the user explicitly chooses everything, or with the requested season numbers. Set qualityObjective to 4k-dv-atmos-hard only when the user explicitly requests the reusable hard 4K Dolby Vision plus Atmos objective. A request to search, identify, inspect, or check availability is not authorization to call this tool.`,
  inputSchema: mediaRequestCreateInputSchema,
  outputSchema: mediaRequestCreateOutputSchema,
  execute: async (input, context) => {
    const resourceId = context.agent?.resourceId;
    const profile = resourceId?.startsWith('whatsapp:')
      ? await getGaryUserProfile(resourceId)
      : undefined;
    const canonicalInput = {
      ...input,
      requester: resolveMediaRequester(input.requester, resourceId, profile?.preferredName),
    };
    const channel = context.requestContext?.get('channel') as { messageId?: string } | undefined;
    const correlationId = channel?.messageId || context.agent?.toolCallId || randomUUID();
    await appendOperationEvent({ correlationId, resourceId, threadId: context.agent?.threadId, phase: 'request-started', detail: { title: canonicalInput.title } });
    const result = await createMediaRequest(canonicalInput);
    await appendOperationEvent({ correlationId, resourceId, threadId: context.agent?.threadId, requestId: result.requestId ? String(result.requestId) : undefined, phase: result.status === 'service-unavailable' ? 'request-failed' : 'request-finished', detail: { status: result.status } });
    await ensureMediaRequestLifecycleWatch(canonicalInput, result, { resourceId, threadId: context.agent?.threadId, correlationId });
    return { ...result, correlationId };
  },
});
