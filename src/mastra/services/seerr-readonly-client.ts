import { assertMutationAllowed, requireService } from '../config/gary-config';

type SeerrSearchResult = {
  id: number;
  mediaType: 'movie' | 'tv';
  title?: string;
  name?: string;
  releaseDate?: string;
  firstAirDate?: string;
  overview?: string;
};

export type SeerrTitleDetails = {
  id?: number;
  title?: string;
  name?: string;
  releaseDate?: string;
  firstAirDate?: string;
  overview?: string;
  originalLanguage?: string;
  originCountry?: string[];
  productionCountries?: Array<{ iso_3166_1?: string; name?: string }>;
  credits?: { cast?: Array<{ name?: string }>; crew?: Array<{ name?: string; job?: string }> };
  numberOfSeasons?: number;
  seasons?: Array<{ seasonNumber?: number; episodeCount?: number; name?: string }>;
};

export type SeerrMediaRecord = {
  id?: number;
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  status?: number;
  status4k?: number;
};

export type SeerrRequestRecord = {
  id: number;
  status?: number;
  createdAt?: string;
  updatedAt?: string;
  media?: SeerrMediaRecord;
  requestedBy?: {
    displayName?: string;
    username?: string;
    plexUsername?: string;
    email?: string;
  };
};

type CreateSeerrRequestInput = {
  mediaType: 'movie' | 'tv';
  mediaId: number;
  seasons?: 'all' | number[];
  is4k?: boolean;
  profileId?: number;
};

type CreatedSeerrRequestRecord = SeerrRequestRecord & {
  media?: SeerrMediaRecord & {
    tmdbId: number;
  };
};

export const seerrMediaStatusLabels = new Map<number, string>([
  [1, 'unknown'],
  [2, 'pending'],
  [3, 'processing'],
  [4, 'partially available'],
  [5, 'available'],
  [6, 'blocked'],
  [7, 'deleted'],
]);

export const seerrRequestStatusLabels = new Map<number, string>([
  [1, 'pending approval'],
  [2, 'approved'],
  [3, 'declined'],
  [4, 'failed'],
  [5, 'completed'],
]);

async function seerrHttpError(response: Response) {
  let detail = '';
  try {
    const body = await response.text();
    if (body) {
      try {
        const parsed = JSON.parse(body) as { message?: unknown; error?: unknown };
        const candidate = parsed.message || parsed.error;
        detail = typeof candidate === 'string' ? candidate : '';
      } catch {
        detail = body;
      }
    }
  } catch {
  }

  const safeDetail = detail.replace(/\s+/g, ' ').trim().slice(0, 300);
  return new Error(`Seerr returned HTTP ${response.status}${safeDetail ? `: ${safeDetail}` : ''}`);
}

async function seerrFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const { url, apiKey } = requireService('seerr');
  if (init?.method && init.method !== 'GET') assertMutationAllowed('change');
  const response = await fetch(`${url}${path}`, {
    ...init,
    headers: {
      ...init?.headers,
      'X-Api-Key': apiKey,
    },
  });
  if (!response.ok) throw await seerrHttpError(response);
  if (response.status === 204) return undefined as T;
  const body = await response.text();
  return (body ? JSON.parse(body) : undefined) as T;
}

export function seerrTitle(result: SeerrSearchResult) {
  return result.title || result.name || `TMDB ${result.id}`;
}

export function seerrYear(result: SeerrSearchResult) {
  const raw = result.releaseDate || result.firstAirDate;
  if (!raw) {
    return undefined;
  }

  const year = Number.parseInt(raw.slice(0, 4), 10);
  return Number.isFinite(year) ? year : undefined;
}

function encodeSeerrQuery(query: string) {
  return encodeURIComponent(query).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

export async function searchSeerr(query: string) {
  const data = await seerrFetch<{ results?: SeerrSearchResult[] }>(
    `/api/v1/search?query=${encodeSeerrQuery(query)}`,
  );

  return (data.results || []).filter((result) => result.mediaType === 'movie' || result.mediaType === 'tv');
}

export async function getSeerrTitleDetails(mediaType: 'movie' | 'tv', tmdbId: number) {
  return await seerrFetch<SeerrTitleDetails>(`/api/v1/${mediaType}/${tmdbId}`);
}

export async function listSeerrMedia() {
  const firstPage = await seerrFetch<{
    pageInfo?: { pages?: number };
    results?: SeerrMediaRecord[];
  }>('/api/v1/media?take=100&skip=0');
  const pages = Math.min(firstPage.pageInfo?.pages || 1, 10);
  const records = [...(firstPage.results || [])];

  for (let page = 2; page <= pages; page += 1) {
    const pageData = await seerrFetch<{ results?: SeerrMediaRecord[] }>(
      `/api/v1/media?take=100&skip=${(page - 1) * 100}`,
    );
    records.push(...(pageData.results || []));
  }

  return records;
}

export async function listSeerrRequests() {
  const firstPage = await seerrFetch<{
    pageInfo?: { pages?: number };
    results?: SeerrRequestRecord[];
  }>('/api/v1/request?take=100&skip=0');
  const pages = Math.min(firstPage.pageInfo?.pages || 1, 10);
  const records = [...(firstPage.results || [])];

  for (let page = 2; page <= pages; page += 1) {
    const pageData = await seerrFetch<{ results?: SeerrRequestRecord[] }>(
      `/api/v1/request?take=100&skip=${(page - 1) * 100}`,
    );
    records.push(...(pageData.results || []));
  }

  return records;
}

export async function createSeerrRequest(request: CreateSeerrRequestInput) {
  if (request.mediaType === 'tv' && Array.isArray(request.seasons) && request.seasons.length === 0) {
    throw new Error('Refusing to create a TV request without an explicit non-empty season scope');
  }
  assertMutationAllowed('request');
  return await seerrFetch<CreatedSeerrRequestRecord>('/api/v1/request', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      mediaType: request.mediaType,
      mediaId: request.mediaId,
      seasons: request.mediaType === 'tv' ? request.seasons ?? 'all' : undefined,
      is4k: request.is4k || false,
      profileId: request.profileId,
    }),
  });
}

export async function findSeerrRequestReceipt(
  mediaType: 'movie' | 'tv',
  tmdbId: number,
  options: {
    attempts?: number;
    delayMs?: number;
    listRequests?: typeof listSeerrRequests;
    wait?: (milliseconds: number) => Promise<void>;
  } = {},
) {
  const attempts = Math.max(1, options.attempts ?? 4);
  const delayMs = Math.max(0, options.delayMs ?? 250);
  const listRequests = options.listRequests ?? listSeerrRequests;
  const wait = options.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const receipt = (await listRequests()).find(
      (record) => record.media?.mediaType === mediaType && record.media.tmdbId === tmdbId,
    );
    if (receipt?.id) return receipt;
    if (attempt < attempts - 1 && delayMs > 0) await wait(delayMs);
  }
  return undefined;
}

export async function blockSeerrMedia(input: {
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  title: string;
}) {
  // Seerr sets Media to DELETED when its requests are removed, and Plex
  // Watchlist Sync re-requests DELETED titles. Recreating the blocklist entry
  // last leaves BLOCKLISTED as the final Media status.
  try {
    await seerrFetch<void>(`/api/v1/blocklist/${input.tmdbId}?mediaType=${input.mediaType}`, {
      method: 'DELETE',
    });
  } catch (error) {
    if (!/Seerr returned HTTP 404/.test(error instanceof Error ? error.message : String(error))) throw error;
  }

  const matchingRequests = (await listSeerrRequests()).filter(
    (request) => request.media?.mediaType === input.mediaType && request.media.tmdbId === input.tmdbId,
  );
  for (const request of matchingRequests) {
    await seerrFetch<void>(`/api/v1/request/${request.id}`, { method: 'DELETE' });
  }

  await seerrFetch<void>('/api/v1/blocklist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, user: 1 }),
  });
  await seerrFetch(`/api/v1/blocklist/${input.tmdbId}?mediaType=${input.mediaType}`);
  return { removedRequestIds: matchingRequests.map((request) => request.id) };
}

export async function isSeerrMediaBlocked(mediaType: 'movie' | 'tv', tmdbId: number) {
  try {
    await seerrFetch(`/api/v1/blocklist/${tmdbId}?mediaType=${mediaType}`);
    return true;
  } catch (error) {
    if (/Seerr returned HTTP 404/.test(error instanceof Error ? error.message : String(error))) return false;
    throw error;
  }
}
