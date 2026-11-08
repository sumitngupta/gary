import { registerApiRoute } from '@mastra/core/server';
import { sweepMediaAvailabilityWatches } from '../services/media-availability-observer';
import {
  listMediaAvailabilityWatches,
  markMatchingMediaAvailabilityWatchesDirty,
} from '../services/media-availability-watch-store';
import { garyConfig } from '../config/gary-config';

// Without GARY_MEDIA_EVENTS_TOKEN these routes stay closed. Arr and Plex
// webhooks cannot send headers everywhere, so ?token= is accepted too.
export function isAuthorized(authorization: string | undefined, token: string | undefined) {
  const expected = garyConfig().mediaEventsToken;
  if (!expected) return false;
  return authorization === `Bearer ${expected}` || token === expected;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function extractSonarrCriteria(payload: unknown) {
  const body = asRecord(payload);
  const series = asRecord(body.series);
  const episodes = Array.isArray(body.episodes) ? body.episodes.map(asRecord) : [];
  const seasonNumber = numberValue(body.seasonNumber)
    ?? numberValue(episodes[0]?.seasonNumber);

  return {
    title: stringValue(series.title) || stringValue(body.seriesTitle) || stringValue(body.title),
    mediaType: 'tv' as const,
    year: numberValue(series.year),
    seasonNumber,
    tmdbId: numberValue(series.tmdbId),
  };
}

function extractRadarrCriteria(payload: unknown) {
  const body = asRecord(payload);
  const movie = asRecord(body.movie);

  return {
    title: stringValue(movie.title) || stringValue(body.movieTitle) || stringValue(body.title),
    mediaType: 'movie' as const,
    year: numberValue(movie.year),
    tmdbId: numberValue(movie.tmdbId),
  };
}

function extractPlexCriteria(payload: unknown) {
  const body = asRecord(payload);
  const metadata = asRecord(body.Metadata || body.metadata);
  const type = stringValue(metadata.type) || stringValue(body.type);
  const grandparentTitle = stringValue(metadata.grandparentTitle);
  const title = grandparentTitle || stringValue(metadata.title) || stringValue(body.title);
  const seasonNumber = numberValue(metadata.parentIndex);

  return {
    title,
    mediaType: type === 'movie' ? 'movie' as const : type === 'episode' || type === 'show' || type === 'season' ? 'tv' as const : 'unknown' as const,
    year: numberValue(metadata.year),
    seasonNumber,
  };
}

function parseJsonObject(text: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

async function markDirtyAndSweep(criteria: {
  title?: string;
  mediaType?: 'movie' | 'tv' | 'unknown';
  year?: number;
  seasonNumber?: number;
  tmdbId?: number;
}) {
  const dirty = await markMatchingMediaAvailabilityWatchesDirty(criteria);
  const result = await sweepMediaAvailabilityWatches();
  return {
    dirty,
    ...result,
  };
}

export const mediaAvailabilityWatchRoute = registerApiRoute('/gary/media-availability-watches', {
  method: 'GET',
  requiresAuth: false,
  handler: async (c) => {
    if (!isAuthorized(c.req.header('Authorization'), c.req.query('token'))) {
      return c.json({ ok: false, error: 'Unauthorized' }, 401);
    }

    const watches = await listMediaAvailabilityWatches();
    return c.json({
      ok: true,
      watches,
    });
  },
});

export const mediaAvailabilityWatchSweepRoute = registerApiRoute('/gary/media-availability-watches/sweep', {
  method: 'POST',
  requiresAuth: false,
  handler: async (c) => {
    if (!isAuthorized(c.req.header('Authorization'), c.req.query('token'))) {
      return c.json({ ok: false, error: 'Unauthorized' }, 401);
    }

    const result = await sweepMediaAvailabilityWatches();
    return c.json({
      ok: true,
      ...result,
    });
  },
});

export const sonarrMediaEventRoute = registerApiRoute('/gary/media-events/sonarr', {
  method: 'POST',
  requiresAuth: false,
  handler: async (c) => {
    if (!isAuthorized(c.req.header('Authorization'), c.req.query('token'))) {
      return c.json({ ok: false, error: 'Unauthorized' }, 401);
    }

    const payload = await c.req.json().catch(() => ({}));
    const criteria = extractSonarrCriteria(payload);
    const result = await markDirtyAndSweep(criteria);
    return c.json({ ok: true, source: 'sonarr', criteria, ...result });
  },
});

export const radarrMediaEventRoute = registerApiRoute('/gary/media-events/radarr', {
  method: 'POST',
  requiresAuth: false,
  handler: async (c) => {
    if (!isAuthorized(c.req.header('Authorization'), c.req.query('token'))) {
      return c.json({ ok: false, error: 'Unauthorized' }, 401);
    }

    const payload = await c.req.json().catch(() => ({}));
    const criteria = extractRadarrCriteria(payload);
    const result = await markDirtyAndSweep(criteria);
    return c.json({ ok: true, source: 'radarr', criteria, ...result });
  },
});

export const plexMediaEventRoute = registerApiRoute('/gary/media-events/plex', {
  method: 'POST',
  requiresAuth: false,
  handler: async (c) => {
    if (!isAuthorized(c.req.header('Authorization'), c.req.query('token'))) {
      return c.json({ ok: false, error: 'Unauthorized' }, 401);
    }

    const body = asRecord(await c.req.parseBody().catch(() => ({})));
    const payload = body.payload;
    const rawPayload = typeof payload === 'string'
      ? parseJsonObject(payload)
      : body;
    const criteria = extractPlexCriteria(rawPayload);
    const result = await markDirtyAndSweep(criteria);
    return c.json({ ok: true, source: 'plex', criteria, ...result });
  },
});
