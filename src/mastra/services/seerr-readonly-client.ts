import { readFile } from 'node:fs/promises';

type SeerrSettings = {
  main?: {
    apiKey?: string;
  };
};

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

const DEFAULT_SEERR_URLS = ['http://seerr:5055', 'http://127.0.0.1:5055'];

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

function configuredBaseUrls() {
  return [...new Set([
    process.env.GARY_SEERR_URL,
    ...DEFAULT_SEERR_URLS,
  ].filter((url): url is string => Boolean(url)))];
}

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
    // The status code remains useful even when the response body cannot be read.
  }

  const safeDetail = detail.replace(/\s+/g, ' ').trim().slice(0, 300);
  return new Error(`Seerr returned HTTP ${response.status}${safeDetail ? `: ${safeDetail}` : ''}`);
}

async function readApiKey() {
  if (process.env.GARY_SEERR_API_KEY) return process.env.GARY_SEERR_API_KEY;
  const settingsPath = process.env.GARY_SEERR_SETTINGS_PATH;
  if (!settingsPath) throw new Error('Seerr is not configured: set GARY_SEERR_API_KEY.');
  const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as SeerrSettings;

  if (!settings.main?.apiKey) {
    throw new Error('Seerr API key was not found in settings.json.');
  }

  return settings.main.apiKey;
}

async function seerrFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const apiKey = await readApiKey();
  let lastHttpError: Error | undefined;
  let lastTransportError: Error | undefined;

  for (const baseUrl of configuredBaseUrls()) {
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
          ...init?.headers,
          'X-Api-Key': apiKey,
        },
      });

      if (!response.ok) {
        lastHttpError = await seerrHttpError(response);
        continue;
      }

      if (response.status === 204) return undefined as T;
      const body = await response.text();
      return (body ? JSON.parse(body) : undefined) as T;
    } catch (error) {
      lastTransportError = error instanceof Error ? error : new Error(String(error));
    }
  }

  // Prefer an actual Seerr response over a later fallback connection failure.
  // This keeps the useful rejection reason instead of reducing it to `fetch failed`.
  throw lastHttpError || lastTransportError || new Error('No Seerr endpoint is configured.');
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
  // Seerr's request deletion changes the associated Media status to DELETED.
  // Merely leaving an existing Blocklist row therefore creates a split-brain
  // state: the UI shows a tombstone while Plex Watchlist Sync sees DELETED and
  // auto-requests the title again. Removing an existing blocklist also removes
  // its associated media/request graph; recreating it last makes BLOCKLISTED
  // the authoritative final Media status.
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
