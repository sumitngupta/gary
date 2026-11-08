import { assertMutationAllowed, requireService } from '../config/gary-config';

type PlexLibrarySection = {
  key?: string;
  type?: string;
  title?: string;
};

type PlexMetadata = {
  title?: string;
  type?: string;
  year?: number;
  index?: number;
  ratingKey?: string;
  leafCount?: number;
  viewedLeafCount?: number;
  summary?: string;
  childCount?: number;
  librarySectionID?: number;
};

export function normalizeTitle(title: string) {
  return title
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

async function plexRequest(path: string, init?: RequestInit): Promise<Response> {
  const { url, apiKey: token } = requireService('plex');
  if (init?.method && init.method !== 'GET') assertMutationAllowed('change');
  const separator = path.includes('?') ? '&' : '?';
  const response = await fetch(`${url}${path}${separator}X-Plex-Token=${encodeURIComponent(token)}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...init?.headers,
    },
  });
  if (!response.ok) throw new Error(`Plex returned HTTP ${response.status}`);
  return response;
}

async function plexFetch<T>(path: string): Promise<T> {
  return await (await plexRequest(path)).json() as T;
}

async function plexIdentity() {
  const data = await plexFetch<{ MediaContainer?: { machineIdentifier?: string }; machineIdentifier?: string }>('/identity');
  const id = data.MediaContainer?.machineIdentifier || data.machineIdentifier;
  if (!id) throw new Error('Plex did not return its machine identifier.');
  return id;
}

function queryPath(path: string, params: Record<string, string>) {
  return `${path}?${new URLSearchParams(params).toString()}`;
}

async function listSections() {
  const data = await plexFetch<{ MediaContainer?: { Directory?: PlexLibrarySection[] } }>('/library/sections');
  return data.MediaContainer?.Directory || [];
}

export type PlexCollectionView = {
  ratingKey: string;
  title: string;
  summary?: string;
  mediaType: 'movie' | 'tv';
  sectionKey: string;
  library: string;
  items: Array<{ ratingKey: string; title: string; year?: number; type: string }>;
};

export async function listPlexCollections(mediaType?: 'movie' | 'tv'): Promise<PlexCollectionView[]> {
  const sections = (await listSections()).filter((section) =>
    section.key && (section.type === 'movie' || section.type === 'show')
      && (!mediaType || section.type === (mediaType === 'tv' ? 'show' : 'movie')),
  );
  const collections: PlexCollectionView[] = [];
  for (const section of sections) {
    if (!section.key) continue;
    const data = await plexFetch<{ MediaContainer?: { Metadata?: PlexMetadata[]; Directory?: PlexMetadata[] } }>(
      `/library/sections/${encodeURIComponent(section.key)}/collections`,
    );
    for (const item of [...(data.MediaContainer?.Metadata || []), ...(data.MediaContainer?.Directory || [])]) {
      if (!item.ratingKey || !item.title) continue;
      const children = await listMetadataChildren(item.ratingKey);
      collections.push({
        ratingKey: item.ratingKey,
        title: item.title,
        summary: item.summary,
        mediaType: section.type === 'show' ? 'tv' : 'movie',
        sectionKey: section.key,
        library: section.title || (section.type === 'show' ? 'TV Shows' : 'Movies'),
        items: children.filter((child) => child.ratingKey && child.title).map((child) => ({
          ratingKey: child.ratingKey!, title: child.title!, year: child.year, type: child.type || section.type || 'unknown',
        })),
      });
    }
  }
  return collections;
}

export async function resolveExactPlexLibraryItems(input: { title: string; year?: number; mediaType: 'movie' | 'tv' }[]) {
  const sections = await listSections();
  const inventories = new Map<string, PlexMetadata[]>();
  const results = [];
  for (const candidate of input) {
    const section = sections.find((item) => item.key && item.type === (candidate.mediaType === 'tv' ? 'show' : 'movie'));
    if (!section?.key) { results.push({ candidate, matches: [] }); continue; }
    if (!inventories.has(section.key)) inventories.set(section.key, await listSectionItems(section.key));
    const normalized = normalizeTitle(candidate.title);
    const matches = inventories.get(section.key)!.filter((item) => item.ratingKey && item.title
      && normalizeTitle(item.title) === normalized && (candidate.year === undefined || item.year === candidate.year))
      .map((item) => ({ ratingKey: item.ratingKey!, title: item.title!, year: item.year, type: item.type || section.type || 'unknown', sectionKey: section.key!, library: section.title || '' }));
    results.push({ candidate, matches });
  }
  return results;
}

export async function createPlexCollection(input: { title: string; summary?: string; mediaType: 'movie' | 'tv'; sectionKey: string; ratingKeys: string[] }) {
  if (input.ratingKeys.length === 0) throw new Error('Plex collections require at least one available library item.');
  const uri = `server://${await plexIdentity()}/com.plexapp.plugins.library/library/metadata/${input.ratingKeys.join(',')}`;
  const response = await plexRequest(queryPath('/library/collections', {
    uri, type: input.mediaType === 'tv' ? '2' : '1', title: input.title, smart: '0', sectionId: input.sectionKey,
  }), { method: 'POST' });
  const data = await response.json() as { MediaContainer?: { Metadata?: PlexMetadata[]; Directory?: PlexMetadata[] }; ratingKey?: string };
  const created = data.MediaContainer?.Metadata?.[0] || data.MediaContainer?.Directory?.[0] || data;
  const ratingKey = created.ratingKey;
  if (!ratingKey) throw new Error('Plex created no identifiable collection.');
  if (input.summary !== undefined) await updatePlexCollectionMetadata(ratingKey, { summary: input.summary });
  return ratingKey;
}

export async function updatePlexCollectionMetadata(ratingKey: string, input: { title?: string; summary?: string }) {
  const params: Record<string, string> = {};
  if (input.title !== undefined) { params['title.value'] = input.title; params['title.locked'] = '1'; }
  if (input.summary !== undefined) { params['summary.value'] = input.summary; params['summary.locked'] = '1'; }
  if (Object.keys(params).length) await plexRequest(queryPath(`/library/metadata/${encodeURIComponent(ratingKey)}`, params), { method: 'PUT' });
}

export async function addPlexCollectionItems(collectionKey: string, ratingKeys: string[]) {
  const uri = `server://${await plexIdentity()}/com.plexapp.plugins.library/library/metadata/${ratingKeys.join(',')}`;
  await plexRequest(queryPath(`/library/collections/${encodeURIComponent(collectionKey)}/items`, { uri }), { method: 'PUT' });
}

export async function removePlexCollectionItem(collectionKey: string, itemKey: string) {
  await plexRequest(`/library/collections/${encodeURIComponent(collectionKey)}/items/${encodeURIComponent(itemKey)}`, { method: 'DELETE' });
}

export type PlexShelfInventory = {
  sections: Array<{ key: string; mediaType: 'movie' | 'tv'; items: Array<{ ratingKey: string; title: string; year?: number; tmdbIds: number[] }> }>;
  collections: Array<{ ratingKey: string; title: string; sectionKey: string; itemKeys: string[] }>;
};

const SECTION_PAGE_SIZE = 1000;

async function listSectionItemsWithGuids(sectionKey: string) {
  const items: Array<PlexMetadata & { Guid?: Array<{ id?: string }> }> = [];
  for (let start = 0; ; start += SECTION_PAGE_SIZE) {
    const data = await plexFetch<{ MediaContainer?: { Metadata?: Array<PlexMetadata & { Guid?: Array<{ id?: string }> }> } }>(queryPath(
      `/library/sections/${encodeURIComponent(sectionKey)}/all`,
      { includeGuids: '1', 'X-Plex-Container-Start': String(start), 'X-Plex-Container-Size': String(SECTION_PAGE_SIZE) },
    ));
    const page = data.MediaContainer?.Metadata || [];
    items.push(...page);
    if (page.length < SECTION_PAGE_SIZE) return items;
  }
}

export async function loadPlexShelfInventory(): Promise<PlexShelfInventory> {
  const all = await listSections();
  const picked = (['movie', 'tv'] as const).flatMap((mediaType) => {
    const section = all.find((candidate) => candidate.key && candidate.type === (mediaType === 'tv' ? 'show' : 'movie'));
    return section?.key ? [{ key: section.key, mediaType }] : [];
  });
  const sections = await Promise.all(picked.map(async (section) => ({
    ...section,
    items: (await listSectionItemsWithGuids(section.key)).flatMap((item) => item.ratingKey && item.title ? [{
      ratingKey: item.ratingKey,
      title: item.title,
      year: item.year,
      tmdbIds: (item.Guid || []).flatMap((guid) => {
        const match = guid.id?.match(/^tmdb:\/\/(\d+)$/);
        return match ? [Number(match[1])] : [];
      }),
    }] : []),
  })));
  const collections = (await listPlexCollections()).map(({ ratingKey, title, sectionKey, items }) => ({
    ratingKey, title, sectionKey, itemKeys: items.map((item) => item.ratingKey),
  }));
  return { sections, collections };
}

export async function deletePlexCollection(ratingKey: string) {
  await plexRequest(`/library/collections/${encodeURIComponent(ratingKey)}`, { method: 'DELETE' });
}

export async function refreshPlexLibrary(mediaType: 'movie' | 'tv') {
  const plexType = mediaType === 'tv' ? 'show' : 'movie';
  const sections = await listSections();
  const section = sections.find((candidate) => candidate.type === plexType && candidate.key);

  if (!section?.key) {
    return undefined;
  }

  await plexRequest(`/library/sections/${encodeURIComponent(section.key)}/refresh`, {
    method: 'PUT',
  });

  return {
    sectionKey: section.key,
    library: section.title || (mediaType === 'tv' ? 'TV Shows' : 'Movies'),
  };
}

async function listSectionItems(sectionKey: string) {
  const data = await plexFetch<{ MediaContainer?: { Metadata?: PlexMetadata[] } }>(
    `/library/sections/${encodeURIComponent(sectionKey)}/all?X-Plex-Container-Size=2000&X-Plex-Container-Start=0`,
  );
  return data.MediaContainer?.Metadata || [];
}

async function listMetadataChildren(ratingKey: string) {
  const data = await plexFetch<{ MediaContainer?: { Metadata?: PlexMetadata[] } }>(
    `/library/metadata/${encodeURIComponent(ratingKey)}/children`,
  );
  return data.MediaContainer?.Metadata || [];
}

export async function searchPlexAvailability(request: {
  query: string;
  mediaType?: 'movie' | 'tv' | 'unknown';
  year?: number;
}) {
  const normalizedQuery = normalizeTitle(request.query);
  const sections = (await listSections()).filter((section) => {
    if (request.mediaType === 'movie') return section.type === 'movie';
    if (request.mediaType === 'tv') return section.type === 'show';
    return section.type === 'movie' || section.type === 'show';
  });
  const matches = [];

  for (const section of sections) {
    if (!section.key) continue;

    for (const item of await listSectionItems(section.key)) {
      if (!item.title) continue;

      const normalizedTitle = normalizeTitle(item.title);
      const titleMatches = normalizedTitle === normalizedQuery || normalizedTitle.includes(normalizedQuery);
      const yearMatches = request.year === undefined || item.year === request.year;

      if (titleMatches && yearMatches) {
        const seasons = item.type === 'show' && item.ratingKey
          ? await listMetadataChildren(item.ratingKey)
          : [];
        const availableSeasons = seasons
          .filter((season) => season.type === 'season' && typeof season.index === 'number' && season.index > 0)
          .map((season) => season.index as number)
          .sort((left, right) => left - right);
        matches.push({
          title: item.title,
          type: item.type || section.type || 'unknown',
          year: item.year,
          ratingKey: item.ratingKey,
          library: section.title,
          seasonCount: item.type === 'show' ? availableSeasons.length : undefined,
          availableSeasons: item.type === 'show' ? availableSeasons : undefined,
          episodeCount: item.leafCount,
          viewedEpisodeCount: item.viewedLeafCount,
        });
      }
    }
  }

  return matches.slice(0, 10);
}

export async function checkPlexTitleAvailability(request: {
  query: string;
  mediaType?: 'movie' | 'tv' | 'unknown';
  year?: number;
  seasonNumber?: number;
}) {
  const matches = await searchPlexAvailability(request);
  const primary = matches[0];

  if (!primary) {
    return {
      streamable: false,
      matches,
      episodeCount: undefined,
      seasonEpisodeCount: undefined,
      seasonSatisfied: request.seasonNumber === undefined ? undefined : false,
    };
  }

  if (request.seasonNumber === undefined || request.mediaType !== 'tv' || !primary.ratingKey) {
    return {
      streamable: true,
      matches,
      episodeCount: primary.episodeCount,
      seasonEpisodeCount: undefined,
      seasonSatisfied: request.seasonNumber === undefined ? undefined : true,
    };
  }

  const seasons = await listMetadataChildren(primary.ratingKey);
  const season = seasons.find((item) => item.type === 'season' && item.index === request.seasonNumber);
  const seasonEpisodeCount = season?.leafCount
    ?? (season?.ratingKey ? (await listMetadataChildren(season.ratingKey)).filter((item) => item.type === 'episode').length : 0);

  return {
    streamable: seasonEpisodeCount > 0,
    matches,
    episodeCount: primary.episodeCount,
    seasonEpisodeCount,
    seasonSatisfied: seasonEpisodeCount > 0,
  };
}
