import type { TvCompleteness } from '../schemas/media-availability-watch';
import { serverName } from '../config/branding';

type SeasonEpisode = {
  seasonNumber?: number;
  monitored?: boolean;
  hasFile?: boolean;
  airDateUtc?: string;
};

export function summarizeSonarrSeasons(episodes: SeasonEpisode[], now = Date.now()) {
  const seasons = new Map<number, SeasonEpisode[]>();
  for (const episode of episodes) {
    if (episode.seasonNumber === undefined || episode.seasonNumber === 0) continue;
    const items = seasons.get(episode.seasonNumber) || [];
    items.push(episode);
    seasons.set(episode.seasonNumber, items);
  }

  return [...seasons.entries()]
    .sort(([left], [right]) => left - right)
    .map(([seasonNumber, items]) => {
      const monitoredEpisodeCount = items.filter((episode) => episode.monitored !== false).length;
      const episodeFileCount = items.filter((episode) => episode.hasFile).length;
      const aired = items.filter((episode) => episode.airDateUtc && Date.parse(episode.airDateUtc) <= now);
      const upcoming = items.filter((episode) => episode.airDateUtc && Date.parse(episode.airDateUtc) > now);
      return {
        seasonNumber,
        episodeCount: items.length,
        monitoredEpisodeCount,
        episodeFileCount,
        missingEpisodeCount: items.length - episodeFileCount,
        missingMonitoredEpisodeCount: items.filter((episode) => episode.monitored !== false && !episode.hasFile).length,
        airedEpisodeCount: aired.length,
        missingAiredEpisodeCount: aired.filter((episode) => !episode.hasFile).length,
        upcomingEpisodeCount: upcoming.length,
        unknownAirDateEpisodeCount: items.length - aired.length - upcoming.length,
        nextAirDateUtc: upcoming.map((episode) => episode.airDateUtc!).sort()[0],
      };
    });
}

export function tvCompleteness(input: {
  plexStreamable: boolean;
  seasonNumber?: number;
  seriesSeasons?: Array<{ seasonNumber: number; monitored: boolean }>;
  episodes: SeasonEpisode[];
  now?: number;
}): TvCompleteness {
  const monitored = new Set((input.seriesSeasons || []).filter((season) => season.monitored).map((season) => season.seasonNumber));
  // Episodes Sonarr will never grab (e.g. "new episodes only" on a current season)
  // must not hold a watch open forever.
  const seasons = summarizeSonarrSeasons(input.episodes.filter((episode) => episode.monitored !== false), input.now)
    .filter((season) => season.airedEpisodeCount > 0
      && (input.seasonNumber === undefined ? monitored.has(season.seasonNumber) : season.seasonNumber === input.seasonNumber))
    .map((season) => ({
      seasonNumber: season.seasonNumber,
      aired: season.airedEpisodeCount,
      withFiles: season.airedEpisodeCount - season.missingAiredEpisodeCount,
      upcoming: season.upcomingEpisodeCount,
    }));
  const missingAired = seasons.reduce((total, season) => total + season.aired - season.withFiles, 0);
  const state = !input.plexStreamable ? 'none' : missingAired === 0 ? 'complete' : 'partial';
  return { state, seasons, missingAired };
}

export function completeSeasonNumbers(completeness: TvCompleteness) {
  return completeness.seasons.filter((season) => season.withFiles === season.aired).map((season) => season.seasonNumber);
}

export function pendingSeasonNumbers(completeness: TvCompleteness) {
  return completeness.seasons.filter((season) => season.withFiles < season.aired).map((season) => season.seasonNumber);
}

export function formatSeasonList(seasonNumbers: number[]) {
  const sorted = [...seasonNumbers].sort((left, right) => left - right);
  const runs: string[] = [];
  for (let start = 0; start < sorted.length;) {
    let end = start;
    while (sorted[end + 1] === sorted[end] + 1) end += 1;
    runs.push(end > start ? `${sorted[start]}–${sorted[end]}` : `${sorted[start]}`);
    start = end + 1;
  }
  const list = runs.length > 1 ? `${runs.slice(0, -1).join(', ')} and ${runs.at(-1)}` : runs[0] || '';
  return `${sorted.length === 1 ? 'season' : 'seasons'} ${list}`;
}

export function partialTvDetail(completeness: TvCompleteness) {
  const present = completeSeasonNumbers(completeness);
  const episodes = `${completeness.missingAired} aired episode${completeness.missingAired === 1 ? '' : 's'} still downloading`;
  if (!present.length) return `Some episodes are on ${serverName()}; ${episodes}.`;
  const seasons = formatSeasonList(present);
  return `${seasons[0].toUpperCase()}${seasons.slice(1)} of ${completeness.seasons.length} ${present.length === 1 ? 'is' : 'are'} on ${serverName()}; ${episodes}.`;
}
