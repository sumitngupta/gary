import { createSkill } from '@mastra/core/skills';
import { serverName } from '../config/branding';

export const garyMediaRepairSkill = createSkill({
  name: 'gary-media-repair',
  description:
    'Use when diagnosing or repairing a movie/show that is missing, partial, stalled, not imported, or present in Sonarr/Radarr but absent from Plex.',
  instructions: `# Gary Media Repair

Use this procedure for media discrepancies, stalled downloads/imports, missing
seasons, explicit Plex refresh requests, and approved fresh searches.

## Establish the state

1. Resolve the exact title, year, media type, and requested season when present.
2. Check ${serverName()}/Plex availability and the matching Sonarr or Radarr status.
3. For TV, compare every relevant season across:
   - known episode count;
   - monitored episode count;
   - episode files present;
   - missing monitored episodes;
   - Plex-indexed season numbers.
4. Load deeper Sonarr diagnostics only when the user asks why something is
   stalled or approves investigation of queue, history, blocklist, indexer,
   search, health, or import clues.

Never interpret an aggregate such as "72/72 aired episodes have files" as proof
that the complete series is present. The denominator can include only monitored
episodes.

## Classify before acting

- **Acquisition gap:** Sonarr/Radarr has no file. A Plex refresh cannot fix it.
- **Library-scan gap:** Sonarr/Radarr has a file for the requested season/title,
  but Plex does not index it. A bounded Plex library refresh is appropriate.
- **Active work:** A matching queue/import is progressing. Report the evidence;
  do not start duplicate work.
- **Stalled work:** Missing content plus concrete queue/history/blocklist/health
  evidence. Explain the clue and choose only a supported next action.
- **Available:** Plex confirms the requested title or season. Only then call it
  available or ready to watch.

## Supported repair actions

- When the user explicitly asks to refresh or scan Plex/${serverName()}, call
  refreshPlexLibrary for Movies or TV Shows. Say only that the scan started;
  do not claim the title appeared until a later read verifies it.
- An exact request such as "get season 4 of TITLE" authorizes a season-aware
  triggerArrMediaFreshSearch after the read-only check confirms it is missing.
  Pass seasonNumber and monitorSeason: true. Do not ask for an extra confirmation.
- Preserve season numbers across follow-ups such as "both", "go ahead", or
  "fresh search". Never substitute a whole-series search for a season request.
- For a tracked missing/stalled movie or show that the user explicitly asks to
  get, retry, repair, or fresh-search, use triggerArrMediaFreshSearch only after
  the read-only state supports it.
- For a completed multi-movie pack, let the deterministic pack-repair path
  copy-import the originally approved movie. Never treat the pack as a failed
  download or start the same release again. Additional exact sibling titles
  require the frozen owner-only collection-pack approval and its single-use
  execution tool.
- Do not remove/re-add titles, delete or replace files, change quality profiles,
  re-encode media, or manipulate download clients/trackers. Offer a bounded
  supervisor escalation only after the user explicitly agrees.

## Reporting

For ordinary users, use ${serverName()} language and state the concrete outcome briefly.
For owner-requested diagnostics, label backend detail "Diagnostic details:" or
"Technical details:". Always distinguish requested, downloading, imported, and
Plex-verified availability.`,
  references: {
    'ds9-season-discrepancy.md': `# DS9 monitored-subset regression

## Incident

Sonarr reported 72/72 aired episodes with files for Star Trek: Deep Space Nine.
Gary interpreted that as the complete series and said seasons 4 and 5 were
already present. Plex showed only seasons 1 through 3.

## Authoritative state

- Sonarr knew seven regular seasons plus specials.
- Seasons 1-3 contained 72 episodes with files.
- Seasons 4-7 each had 26 known episodes, zero monitored episodes, and zero
  files.
- Plex indexed exactly seasons 1-3 and 72 episodes.

## Correct conclusion

The 72/72 aggregate described the monitored subset, not the whole series.
Seasons 4 and 5 were acquisition gaps, not Plex scan gaps. A library refresh
could not make absent files appear.`,
  },
});
