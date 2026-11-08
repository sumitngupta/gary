import { z } from 'zod';

const optionalPositiveInt = z.preprocess(
  (value) => value === null ? undefined : value,
  z.number().int().positive().optional(),
);

const optionalYear = z.preprocess(
  (value) => value === null ? undefined : value,
  z.number().int().min(1888).max(2100).optional(),
);

export const plexAvailabilityInputSchema = z.object({
  query: z.string().min(1),
  mediaType: z.enum(['movie', 'tv', 'unknown']).default('unknown'),
  year: z.number().int().min(1888).max(2100).optional(),
  tmdbId: z.number().int().positive().optional(),
});

export const plexAvailabilityMatchSchema = z.object({
  title: z.string(),
  type: z.string(),
  year: z.number().int().optional(),
  ratingKey: z.string().optional(),
  library: z.string().optional(),
  seasonCount: z.number().int().optional(),
  availableSeasons: z.array(z.number().int().nonnegative()).optional(),
  episodeCount: z.number().int().optional(),
  viewedEpisodeCount: z.number().int().optional(),
});

export const plexAvailabilityOutputSchema = z.object({
  status: z.enum(['found', 'not-found', 'service-unavailable']),
  query: z.string(),
  streamable: z.boolean(),
  matches: z.array(plexAvailabilityMatchSchema).default([]),
  casualSummary: z.string(),
  summary: z.string(),
});

export type PlexAvailabilityOutput = z.infer<typeof plexAvailabilityOutputSchema>;

export const plexLibraryRefreshInputSchema = z.object({
  mediaType: z.enum(['movie', 'tv']),
});

export const plexLibraryRefreshOutputSchema = z.object({
  status: z.enum(['started', 'library-not-found', 'service-unavailable']),
  mediaType: z.enum(['movie', 'tv']),
  library: z.string().optional(),
  sectionKey: z.string().optional(),
  summary: z.string(),
});

export type PlexLibraryRefreshOutput = z.infer<typeof plexLibraryRefreshOutputSchema>;

export const sonarrSeriesStatusInputSchema = z.object({
  query: z.string().min(1),
  year: z.number().int().min(1888).max(2100).optional(),
  tvdbId: z.number().int().positive().optional(),
  tmdbId: z.number().int().positive().optional(),
});

export const sonarrSeriesStatusOutputSchema = z.object({
  status: z.enum(['found', 'not-found', 'service-unavailable']),
  query: z.string(),
  title: z.string().optional(),
  year: z.number().int().optional(),
  monitored: z.boolean().optional(),
  seriesId: z.number().int().optional(),
  tvdbId: z.number().int().optional(),
  tmdbId: z.number().int().optional(),
  episodeFileCount: z.number().int().optional(),
  episodeCount: z.number().int().optional(),
  totalEpisodeCount: z.number().int().optional(),
  percentOfEpisodes: z.number().optional(),
  seasons: z.array(z.object({
    seasonNumber: z.number().int().nonnegative(),
    episodeCount: z.number().int().nonnegative(),
    monitoredEpisodeCount: z.number().int().nonnegative(),
    episodeFileCount: z.number().int().nonnegative(),
    missingEpisodeCount: z.number().int().nonnegative(),
    missingMonitoredEpisodeCount: z.number().int().nonnegative(),
    airedEpisodeCount: z.number().int().nonnegative(),
    missingAiredEpisodeCount: z.number().int().nonnegative(),
    upcomingEpisodeCount: z.number().int().nonnegative(),
    unknownAirDateEpisodeCount: z.number().int().nonnegative(),
    nextAirDateUtc: z.string().optional(),
  })).default([]),
  sizeOnDisk: z.number().int().optional(),
  queueCount: z.number().int().default(0),
  queueItems: z.array(z.object({
    title: z.string().optional(),
    status: z.string().optional(),
    episodeTitle: z.string().optional(),
    trackedDownloadStatus: z.string().optional(),
    trackedDownloadState: z.string().optional(),
    progress: z.number().optional(),
    size: z.number().int().optional(),
    sizeLeft: z.number().int().optional(),
    timeLeft: z.string().optional(),
    estimatedCompletionTime: z.string().optional(),
    errorMessage: z.string().optional(),
  })).default([]),
  casualSummary: z.string(),
  summary: z.string(),
});

export type SonarrSeriesStatusOutput = z.infer<typeof sonarrSeriesStatusOutputSchema>;

export const sonarrSeriesDiagnosticsInputSchema = sonarrSeriesStatusInputSchema.extend({
  historyLimit: z.number().int().min(1).max(100).default(50),
  blocklistLimit: z.number().int().min(1).max(100).default(50),
});

export const sonarrSeriesDiagnosticsOutputSchema = z.object({
  status: z.enum(['found', 'not-found', 'service-unavailable']),
  query: z.string(),
  title: z.string().optional(),
  year: z.number().int().optional(),
  seriesId: z.number().int().optional(),
  monitored: z.boolean().optional(),
  episodeFileCount: z.number().int().optional(),
  episodeCount: z.number().int().optional(),
  missingAiredMonitoredCount: z.number().int().optional(),
  queueCount: z.number().int().default(0),
  recentHistory: z.array(z.object({
    date: z.string().optional(),
    eventType: z.string().optional(),
    sourceTitle: z.string().optional(),
    episodeTitle: z.string().optional(),
    seasonNumber: z.number().int().optional(),
    episodeNumber: z.number().int().optional(),
    downloadId: z.string().optional(),
  })).default([]),
  blocklistItems: z.array(z.object({
    date: z.string().optional(),
    sourceTitle: z.string().optional(),
    indexer: z.string().optional(),
    protocol: z.string().optional(),
    reason: z.string().optional(),
  })).default([]),
  indexers: z.array(z.object({
    name: z.string(),
    protocol: z.string().optional(),
    enableAutomaticSearch: z.boolean().optional(),
    enableInteractiveSearch: z.boolean().optional(),
    supportsSearch: z.boolean().optional(),
    priority: z.number().int().optional(),
  })).default([]),
  health: z.array(z.object({
    type: z.string().optional(),
    source: z.string().optional(),
    message: z.string().optional(),
  })).default([]),
  casualSummary: z.string(),
  summary: z.string(),
});

export type SonarrSeriesDiagnosticsOutput = z.infer<typeof sonarrSeriesDiagnosticsOutputSchema>;

export const radarrMovieStatusInputSchema = z.object({
  query: z.string().min(1),
  year: z.number().int().min(1888).max(2100).optional(),
  tmdbId: z.number().int().positive().optional(),
});

export const radarrMovieStatusOutputSchema = z.object({
  status: z.enum(['found', 'not-found', 'service-unavailable']),
  query: z.string(),
  title: z.string().optional(),
  year: z.number().int().optional(),
  movieId: z.number().int().optional(),
  tmdbId: z.number().int().optional(),
  monitored: z.boolean().optional(),
  hasFile: z.boolean().optional(),
  downloaded: z.boolean().optional(),
  quality: z.string().optional(),
  size: z.number().int().optional(),
  queueCount: z.number().int().default(0),
  queueItems: z.array(z.object({
    title: z.string().optional(),
    status: z.string().optional(),
    trackedDownloadStatus: z.string().optional(),
    trackedDownloadState: z.string().optional(),
    progress: z.number().optional(),
    size: z.number().int().optional(),
    sizeLeft: z.number().int().optional(),
    timeLeft: z.string().optional(),
    estimatedCompletionTime: z.string().optional(),
    errorMessage: z.string().optional(),
  })).default([]),
  casualSummary: z.string(),
  summary: z.string(),
});

export type RadarrMovieStatusOutput = z.infer<typeof radarrMovieStatusOutputSchema>;

export const arrMediaFreshSearchInputSchema = z.object({
  query: z.string().min(1),
  mediaType: z.enum(['tv', 'movie']),
  year: optionalYear,
  tmdbId: optionalPositiveInt,
  tvdbId: optionalPositiveInt,
  seasonNumber: z.number().int().min(0).max(100).optional(),
  monitorSeason: z.boolean().optional(),
});

export const arrMediaFreshSearchOutputSchema = z.object({
  status: z.enum(['started', 'not-found', 'nothing-to-search', 'service-unavailable']),
  mediaType: z.enum(['tv', 'movie']),
  query: z.string(),
  title: z.string().optional(),
  year: z.number().int().optional(),
  seasonNumber: z.number().int().optional(),
  monitoredEpisodeCount: z.number().int().optional(),
  missingMonitoredEpisodeCount: z.number().int().optional(),
  airedEpisodeCount: z.number().int().optional(),
  upcomingEpisodeCount: z.number().int().optional(),
  nextAirDateUtc: z.string().optional(),
  sonarrSeriesId: z.number().int().optional(),
  radarrMovieId: z.number().int().optional(),
  commandName: z.string().optional(),
  commandId: z.number().int().optional(),
  commandStatus: z.string().optional(),
  summary: z.string(),
});

export type ArrMediaFreshSearchOutput = z.infer<typeof arrMediaFreshSearchOutputSchema>;
