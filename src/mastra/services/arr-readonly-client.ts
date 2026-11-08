import { assertMutationAllowed, requireService } from '../config/gary-config';

type SonarrSeries = {
  id: number;
  title: string;
  year?: number;
  tvdbId?: number;
  tmdbId?: number;
  monitored?: boolean;
  qualityProfileId?: number;
  seasons?: Array<{ seasonNumber: number; monitored: boolean }>;
  statistics?: {
    episodeFileCount?: number;
    episodeCount?: number;
    totalEpisodeCount?: number;
    percentOfEpisodes?: number;
    sizeOnDisk?: number;
  };
};

export function scopedSonarrSeasons(
  seasons: Array<{ seasonNumber: number; monitored: boolean }>,
  selectedSeasons: number[],
) {
  const selected = new Set(selectedSeasons);
  return seasons.map((season) => ({
    ...season,
    monitored: season.seasonNumber > 0 && selected.has(season.seasonNumber),
  }));
}

export async function adjustSonarrSeasonScope(request: {
  query: string;
  year?: number;
  seasons: number[];
}) {
  const { url: baseUrl, apiKey } = requireService('sonarr');
  const allSeries = await arrFetch<SonarrSeries[]>(baseUrl, apiKey, '/api/v3/series');
  const matched = allSeries.find((series) =>
    normalizeTitle(series.title) === normalizeTitle(request.query)
    && (request.year === undefined || series.year === request.year),
  );
  if (!matched) return undefined;
  const series = await arrFetch<SonarrSeries>(baseUrl, apiKey, `/api/v3/series/${matched.id}`);
  const knownSeasons = series.seasons || [];
  const available = new Set(knownSeasons.filter((season) => season.seasonNumber > 0).map((season) => season.seasonNumber));
  const invalid = request.seasons.filter((season) => !available.has(season));
  if (invalid.length) throw new Error(`Unknown season number(s): ${invalid.join(', ')}`);
  const updated = await arrPut<SonarrSeries>(baseUrl, apiKey, `/api/v3/series/${series.id}`, {
    ...series,
    monitored: true,
    seasons: scopedSonarrSeasons(knownSeasons, request.seasons),
  });
  return { series: updated, selectedSeasons: [...request.seasons].sort((a, b) => a - b) };
}

type ArrFileQuality = {
  id?: number;
  size?: number;
  quality?: { quality?: { name?: string; resolution?: number } };
  mediaInfo?: {
    audioCodec?: string;
    audioChannels?: number;
    videoDynamicRange?: string;
    videoDynamicRangeType?: string;
    resolution?: string;
  };
  customFormats?: Array<{ name?: string }> | null;
  customFormatScore?: number | null;
};

type SonarrQueueRecord = {
  seriesId?: number;
  title?: string;
  status?: string;
  trackedDownloadStatus?: string;
  trackedDownloadState?: string;
  progress?: number;
  size?: number;
  sizeleft?: number;
  timeleft?: string;
  estimatedCompletionTime?: string;
  errorMessage?: string;
  episode?: {
    title?: string;
    seasonNumber?: number;
    episodeNumber?: number;
  };
};

type SonarrEpisode = {
  id: number;
  title?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  monitored?: boolean;
  hasFile?: boolean;
  airDateUtc?: string;
};

type SonarrHistoryRecord = {
  episodeId?: number;
  seriesId?: number;
  sourceTitle?: string;
  date?: string;
  eventType?: string;
  downloadId?: string;
  episode?: {
    title?: string;
    seasonNumber?: number;
    episodeNumber?: number;
  };
};

type SonarrBlocklistRecord = {
  seriesId?: number;
  sourceTitle?: string;
  date?: string;
  protocol?: string;
  indexer?: string;
  reason?: string;
};

type SonarrIndexer = {
  name: string;
  protocol?: string;
  enableAutomaticSearch?: boolean;
  enableInteractiveSearch?: boolean;
  supportsSearch?: boolean;
  priority?: number;
};

type ArrHealthRecord = {
  type?: string;
  source?: string;
  message?: string;
};

type ArrCommand = {
  id?: number;
  name?: string;
  status?: string;
  body?: {
    seriesId?: number;
    movieId?: number;
    movieIds?: number[];
  };
};

type RadarrMovie = {
  id: number;
  title: string;
  year?: number;
  tmdbId?: number;
  monitored?: boolean;
  qualityProfileId?: number;
  hasFile?: boolean;
  downloaded?: boolean;
  movieFile?: {
    size?: number;
    quality?: {
      quality?: {
        name?: string;
        resolution?: number;
      };
    };
  } & ArrFileQuality;
};

type RadarrQueueRecord = {
  movieId?: number;
  title?: string;
  status?: string;
  trackedDownloadStatus?: string;
  trackedDownloadState?: string;
  progress?: number;
  size?: number;
  sizeleft?: number;
  timeleft?: string;
  estimatedCompletionTime?: string;
  errorMessage?: string;
  outputPath?: string;
  downloadId?: string;
  statusMessages?: Array<{
    title?: string;
    messages?: string[];
  }>;
};

function normalizeTitle(title: string) {
  return title
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

async function arrFetch<T>(baseUrl: string, apiKey: string, path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      'X-Api-Key': apiKey,
    },
  });

  if (!response.ok) {
    throw new Error(`Arr service returned HTTP ${response.status}`);
  }

  return await response.json() as T;
}

async function arrPost<T>(baseUrl: string, apiKey: string, path: string, body: unknown): Promise<T> {
  assertMutationAllowed('change');
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Arr service returned HTTP ${response.status}`);
  }

  return await response.json() as T;
}

async function arrPut<T>(baseUrl: string, apiKey: string, path: string, body: unknown): Promise<T> {
  assertMutationAllowed('change');
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Arr service returned HTTP ${response.status}`);
  }

  return await response.json() as T;
}

async function arrDelete(baseUrl: string, apiKey: string, path: string, toleratedStatuses: number[] = []): Promise<void> {
  assertMutationAllowed('change');
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'DELETE',
    headers: { 'X-Api-Key': apiKey },
  });
  if (!response.ok && !toleratedStatuses.includes(response.status)) throw new Error(`Arr service returned HTTP ${response.status}`);
}

function arrPath(path: string, params: Record<string, string | number | boolean | undefined>) {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      query.set(key, String(value));
    }
  }

  const queryText = query.toString();
  return queryText ? `${path}?${queryText}` : path;
}

function bestTitleMatch<T extends { title: string; year?: number; tmdbId?: number; tvdbId?: number }>(
  items: T[],
  request: { query: string; year?: number; tmdbId?: number; tvdbId?: number },
) {
  const normalizedQuery = normalizeTitle(request.query);

  return items.find((item) => request.tmdbId && item.tmdbId === request.tmdbId)
    || items.find((item) => request.tvdbId && item.tvdbId === request.tvdbId)
    || items.find((item) => normalizeTitle(item.title) === normalizedQuery && (request.year === undefined || item.year === request.year))
    || items.find((item) => normalizeTitle(item.title).includes(normalizedQuery) && (request.year === undefined || item.year === request.year));
}

export async function getSonarrSeriesStatus(request: {
  query: string;
  year?: number;
  tmdbId?: number;
  tvdbId?: number;
}) {
  const { url: baseUrl, apiKey } = requireService('sonarr');
  const allSeries = await arrFetch<SonarrSeries[]>(baseUrl, apiKey, '/api/v3/series');
  const series = bestTitleMatch(allSeries, request);

  if (!series) {
    return undefined;
  }

  const [episodes, queue] = await Promise.all([
    arrFetch<SonarrEpisode[]>(baseUrl, apiKey, arrPath('/api/v3/episode', { seriesId: series.id })),
    arrFetch<{ totalRecords?: number; records?: SonarrQueueRecord[] }>(
      baseUrl,
      apiKey,
      '/api/v3/queue?includeSeries=true&includeEpisode=true&page=1&pageSize=200',
    ),
  ]);
  const queueItems = (queue.records || []).filter((record) => record.seriesId === series.id);

  return {
    series,
    episodes,
    queueItems,
  };
}

export async function getSonarrSeriesDiagnostics(request: {
  query: string;
  year?: number;
  tmdbId?: number;
  tvdbId?: number;
  historyLimit?: number;
  blocklistLimit?: number;
}) {
  const { url: baseUrl, apiKey } = requireService('sonarr');
  const allSeries = await arrFetch<SonarrSeries[]>(baseUrl, apiKey, '/api/v3/series');
  const series = bestTitleMatch(allSeries, request);

  if (!series) {
    return undefined;
  }

  const [episodes, queue, history, blocklist, indexers, health] = await Promise.all([
    arrFetch<SonarrEpisode[]>(baseUrl, apiKey, arrPath('/api/v3/episode', { seriesId: series.id })),
    arrFetch<{ totalRecords?: number; records?: SonarrQueueRecord[] }>(
      baseUrl,
      apiKey,
      '/api/v3/queue?includeSeries=true&includeEpisode=true&page=1&pageSize=200',
    ),
    arrFetch<{ totalRecords?: number; records?: SonarrHistoryRecord[] }>(
      baseUrl,
      apiKey,
      arrPath('/api/v3/history', {
        seriesId: series.id,
        page: 1,
        pageSize: request.historyLimit || 50,
        sortKey: 'date',
        sortDirection: 'descending',
        includeSeries: true,
        includeEpisode: true,
      }),
    ),
    arrFetch<{ totalRecords?: number; records?: SonarrBlocklistRecord[] }>(
      baseUrl,
      apiKey,
      arrPath('/api/v3/blocklist', {
        seriesId: series.id,
        page: 1,
        pageSize: request.blocklistLimit || 50,
        sortKey: 'date',
        sortDirection: 'descending',
      }),
    ),
    arrFetch<SonarrIndexer[]>(baseUrl, apiKey, '/api/v3/indexer'),
    arrFetch<ArrHealthRecord[]>(baseUrl, apiKey, '/api/v3/health'),
  ]);

  const now = Date.now();
  const missingAiredMonitoredEpisodes = episodes.filter((episode) => {
    const airTime = episode.airDateUtc ? Date.parse(episode.airDateUtc) : Number.NaN;
    return episode.monitored !== false
      && !episode.hasFile
      && !Number.isNaN(airTime)
      && airTime <= now;
  });

  const episodeIds = new Set(episodes.map((episode) => episode.id));
  const historyItems = (history.records || []).filter((record) =>
    record.seriesId === series.id || (record.episodeId !== undefined && episodeIds.has(record.episodeId)),
  );

  return {
    series,
    episodes,
    missingAiredMonitoredEpisodes,
    queueItems: (queue.records || []).filter((record) => record.seriesId === series.id),
    historyItems,
    blocklistItems: (blocklist.records || []).filter((record) => record.seriesId === series.id),
    indexers,
    health,
  };
}

export async function getRadarrMovieStatus(request: {
  query: string;
  year?: number;
  tmdbId?: number;
}) {
  const { url: baseUrl, apiKey } = requireService('radarr');
  const allMovies = await arrFetch<RadarrMovie[]>(baseUrl, apiKey, '/api/v3/movie');
  const movie = bestTitleMatch(allMovies, request);

  if (!movie) {
    return undefined;
  }

  const queue = await arrFetch<{ totalRecords?: number; records?: RadarrQueueRecord[] }>(
    baseUrl,
    apiKey,
    '/api/v3/queue?includeMovie=true&page=1&pageSize=200',
  );
  const queueItems = (queue.records || []).filter((record) => record.movieId === movie.id);

  return {
    movie,
    queueItems,
  };
}

function fileQualityEvidence(file: ArrFileQuality) {
  const labels = [
    file.quality?.quality?.name,
    file.mediaInfo?.audioCodec,
    file.mediaInfo?.videoDynamicRange,
    file.mediaInfo?.videoDynamicRangeType,
    ...(file.customFormats || []).map((format) => format.name),
  ].filter((value): value is string => Boolean(value));
  const haystack = labels.join(' ').toLowerCase();
  const resolution = file.quality?.quality?.resolution
    || Number(file.mediaInfo?.resolution?.match(/^\d+x(\d+)$/)?.[1] || 0);
  return {
    fileId: file.id,
    size: file.size,
    quality: file.quality?.quality?.name,
    resolution,
    dynamicRange: file.mediaInfo?.videoDynamicRangeType || file.mediaInfo?.videoDynamicRange,
    audioCodec: file.mediaInfo?.audioCodec,
    audioChannels: file.mediaInfo?.audioChannels,
    customFormats: (file.customFormats || []).map((format) => format.name).filter((name): name is string => Boolean(name)),
    customFormatScore: file.customFormatScore ?? undefined,
    hasDolbyVision: /dolby.?vision|\bdv\b/.test(haystack),
    hasAtmos: /atmos/.test(haystack),
  };
}

export async function getArrMediaQualityAudit(request: {
  query: string;
  mediaType: 'movie' | 'tv';
  year?: number;
  tmdbId?: number;
  tvdbId?: number;
}) {
  if (request.mediaType === 'movie') {
    const result = await getRadarrMovieStatus(request);
    if (!result) return undefined;
    return {
      title: result.movie.title,
      year: result.movie.year,
      mediaType: request.mediaType,
      monitored: Boolean(result.movie.monitored),
      files: result.movie.movieFile ? [fileQualityEvidence(result.movie.movieFile)] : [],
    };
  }

  const { url: baseUrl, apiKey } = requireService('sonarr');
  const status = await getSonarrSeriesStatus(request);
  if (!status) return undefined;
  const files = await arrFetch<ArrFileQuality[]>(baseUrl, apiKey, arrPath('/api/v3/episodefile', { seriesId: status.series.id }));
  return {
    title: status.series.title,
    year: status.series.year,
    mediaType: request.mediaType,
    monitored: Boolean(status.series.monitored),
    files: files.map(fileQualityEvidence),
  };
}

export async function applyArrHardQualityProfileAndSearch(item: { mediaType: 'movie' | 'tv'; arrId: number; targetProfileId: number }) {
  if (item.mediaType === 'movie') {
    const { url: baseUrl, apiKey } = requireService('radarr');
    const movie = await arrFetch<RadarrMovie>(baseUrl, apiKey, `/api/v3/movie/${item.arrId}`);
    await arrPut(baseUrl, apiKey, `/api/v3/movie/${item.arrId}`, { ...movie, qualityProfileId: item.targetProfileId, monitored: true });
    const command = await arrPost<{ id?: number; name?: string; status?: string }>(baseUrl, apiKey, '/api/v3/command', { name: 'MoviesSearch', movieIds: [item.arrId] });
    return { commandId: command.id, commandName: command.name || 'MoviesSearch', commandStatus: command.status };
  }
  const { url: baseUrl, apiKey } = requireService('sonarr');
  const series = await arrFetch<SonarrSeries>(baseUrl, apiKey, `/api/v3/series/${item.arrId}`);
  await arrPut(baseUrl, apiKey, `/api/v3/series/${item.arrId}`, { ...series, qualityProfileId: item.targetProfileId, monitored: true });
  const command = await arrPost<{ id?: number; name?: string; status?: string }>(baseUrl, apiKey, '/api/v3/command', { name: 'SeriesSearch', seriesId: item.arrId });
  return { commandId: command.id, commandName: command.name || 'SeriesSearch', commandStatus: command.status };
}

export async function deleteSonarrSeries(seriesId: number) {
  const { url: baseUrl, apiKey } = requireService('sonarr');
  await arrDelete(baseUrl, apiKey, arrPath(`/api/v3/series/${seriesId}`, {
    deleteFiles: true,
    addImportListExclusion: true,
  }));
}

async function cancelMatchingCommands(
  baseUrl: string,
  apiKey: string,
  matches: (command: ArrCommand) => boolean,
) {
  const commands = await arrFetch<ArrCommand[]>(baseUrl, apiKey, '/api/v3/command');
  const active = commands.filter((command) =>
    command.id && ['queued', 'started'].includes(command.status || '') && matches(command)
  );
  // Arr answers 409 for a command that has already started; deleting the
  // owning title still stops it.
  for (const command of active) await arrDelete(baseUrl, apiKey, `/api/v3/command/${command.id}`, [404, 409]);
  return active.map((command) => command.id!);
}

export async function cancelSonarrCommandsForSeries(seriesId: number) {
  const { url: baseUrl, apiKey } = requireService('sonarr');
  return await cancelMatchingCommands(baseUrl, apiKey, (command) => command.body?.seriesId === seriesId);
}

export async function cancelRadarrCommandsForMovie(movieId: number) {
  const { url: baseUrl, apiKey } = requireService('radarr');
  return await cancelMatchingCommands(baseUrl, apiKey, (command) =>
    command.body?.movieId === movieId || command.body?.movieIds?.includes(movieId) === true
  );
}

export async function deleteRadarrMovie(movieId: number) {
  const { url: baseUrl, apiKey } = requireService('radarr');
  await arrDelete(baseUrl, apiKey, arrPath(`/api/v3/movie/${movieId}`, {
    deleteFiles: true,
    addImportExclusion: true,
  }));
}

export async function triggerSonarrSeriesSearch(request: {
  query: string;
  year?: number;
  tmdbId?: number;
  tvdbId?: number;
  seasonNumber?: number;
  monitorSeason?: boolean;
}) {
  const { url: baseUrl, apiKey } = requireService('sonarr');
  const allSeries = await arrFetch<SonarrSeries[]>(baseUrl, apiKey, '/api/v3/series');
  const series = bestTitleMatch(allSeries, request);

  if (!series) {
    return undefined;
  }

  const episodes = await arrFetch<SonarrEpisode[]>(baseUrl, apiKey, arrPath('/api/v3/episode', { seriesId: series.id }));
  const now = Date.now();

  if (request.seasonNumber !== undefined) {
    const seasonEpisodes = episodes.filter((episode) => episode.seasonNumber === request.seasonNumber);

    if (seasonEpisodes.length === 0) {
      return {
        series,
        seasonNumber: request.seasonNumber,
        monitoredEpisodeCount: 0,
        missingMonitoredEpisodeCount: 0,
        command: undefined,
        reason: 'season-not-found' as const,
      };
    }

    const airedSeasonEpisodes = seasonEpisodes.filter((episode) => {
      const airTime = episode.airDateUtc ? Date.parse(episode.airDateUtc) : Number.NaN;
      return !Number.isNaN(airTime) && airTime <= now;
    });
    const missingSeasonEpisodes = airedSeasonEpisodes.filter((episode) => !episode.hasFile);
    const upcomingSeasonEpisodes = seasonEpisodes.filter((episode) => episode.airDateUtc && Date.parse(episode.airDateUtc) > now);
    const airDateSummary = {
      airedEpisodeCount: airedSeasonEpisodes.length,
      upcomingEpisodeCount: upcomingSeasonEpisodes.length,
      nextAirDateUtc: upcomingSeasonEpisodes.map((episode) => episode.airDateUtc!).sort()[0],
    };
    const episodesToMonitor = (request.monitorSeason === false ? [] : request.monitorSeason === true ? seasonEpisodes : missingSeasonEpisodes)
      .filter((episode) => episode.monitored === false);

    if (request.monitorSeason === true && (series.monitored === false || series.seasons?.some((season) => season.seasonNumber === request.seasonNumber && !season.monitored))) {
      await arrPut(baseUrl, apiKey, `/api/v3/series/${series.id}`, {
        ...series, monitored: true,
        seasons: series.seasons?.map((season) => season.seasonNumber === request.seasonNumber ? { ...season, monitored: true } : season),
      });
    }

    if (request.monitorSeason !== false && episodesToMonitor.length > 0) {
      await arrPut(baseUrl, apiKey, '/api/v3/episode/monitor', {
        episodeIds: episodesToMonitor.map((episode) => episode.id),
        monitored: true,
      });
    }

    const missingMonitoredEpisodeCount = request.monitorSeason === false
      ? missingSeasonEpisodes.filter((episode) => episode.monitored !== false).length
      : missingSeasonEpisodes.length;

    if (missingMonitoredEpisodeCount === 0) {
      return {
        series,
        seasonNumber: request.seasonNumber,
        monitoredEpisodeCount: seasonEpisodes.filter((episode) => episode.monitored !== false).length + episodesToMonitor.length,
        missingMonitoredEpisodeCount,
        command: undefined,
        reason: 'nothing-missing' as const,
        ...airDateSummary,
      };
    }

    const command = await arrPost<{ id?: number; name?: string; status?: string }>(
      baseUrl,
      apiKey,
      '/api/v3/command',
      {
        name: 'EpisodeSearch',
        episodeIds: missingSeasonEpisodes.filter((episode) => request.monitorSeason !== false || episode.monitored !== false).map((episode) => episode.id),
      },
    );

    return {
      series,
      seasonNumber: request.seasonNumber,
      monitoredEpisodeCount: seasonEpisodes.filter((episode) => episode.monitored !== false).length + episodesToMonitor.length,
      missingMonitoredEpisodeCount,
      command,
      ...airDateSummary,
    };
  }

  const missingMonitoredEpisodes = episodes.filter((episode) => {
    const airTime = episode.airDateUtc ? Date.parse(episode.airDateUtc) : Number.NaN;
    return episode.monitored !== false
      && !episode.hasFile
      && !Number.isNaN(airTime)
      && airTime <= now;
  });

  if (missingMonitoredEpisodes.length === 0) {
    return {
      series,
      monitoredEpisodeCount: 0,
      missingMonitoredEpisodeCount: 0,
      command: undefined,
      reason: 'nothing-missing-monitored' as const,
    };
  }

  const command = await arrPost<{ id?: number; name?: string; status?: string }>(
    baseUrl,
    apiKey,
    '/api/v3/command',
    {
      name: 'EpisodeSearch',
      episodeIds: missingMonitoredEpisodes.map((episode) => episode.id),
    },
  );

  return {
    series,
    missingMonitoredEpisodeCount: missingMonitoredEpisodes.length,
    command,
  };
}

export async function triggerRadarrMovieSearch(request: {
  query: string;
  year?: number;
  tmdbId?: number;
}) {
  const { url: baseUrl, apiKey } = requireService('radarr');
  const allMovies = await arrFetch<RadarrMovie[]>(baseUrl, apiKey, '/api/v3/movie');
  const movie = bestTitleMatch(allMovies, request);

  if (!movie) {
    return undefined;
  }

  const command = await arrPost<{ id?: number; name?: string; status?: string }>(
    baseUrl,
    apiKey,
    '/api/v3/command',
    {
      name: 'MoviesSearch',
      movieIds: [movie.id],
    },
  );

  return {
    movie,
    command,
  };
}
