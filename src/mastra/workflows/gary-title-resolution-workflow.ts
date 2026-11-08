import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { checkMediaStatuses } from '../tools/check-media-statuses-tool';
import { searchWeb } from '../services/web-lookup-client';
import { getSeerrTitleDetails, searchSeerr, seerrTitle, seerrYear } from '../services/seerr-readonly-client';
import { selectConstraintVerifiedGaryTitle, type GaryTitleCandidateEvidence, type GaryTitleConstraints } from '../services/gary-title-constraint-verifier';
import { serverName } from '../config/branding';

const inputSchema = z.object({
  query: z.string().min(1),
  mediaType: z.enum(['movie', 'tv', 'unknown']).default('unknown'),
  year: z.number().int().min(1888).max(2100).optional(),
  country: z.string().max(80).optional(),
  language: z.string().max(80).optional(),
  festivalYear: z.number().int().min(1888).max(2100).optional(),
  aliases: z.array(z.string().min(1).max(200)).max(10).default([]),
  actors: z.array(z.string().min(2).max(120)).max(10).default([]),
  setting: z.string().min(2).max(120).optional(),
  requiredKeywords: z.array(z.string().min(2).max(120)).max(10).default([]),
  requester: z.string().min(1).default('admin'),
});

function hasHardConstraints(input: z.infer<typeof inputSchema>) {
  return Boolean(input.actors.length || input.setting || input.country || input.language || input.requiredKeywords.length);
}

async function candidateEvidence(candidate: { title: string; mediaType: 'movie' | 'tv'; year?: number; tmdbId: number }, parsed: z.infer<typeof inputSchema>) {
  const details = await getSeerrTitleDetails(candidate.mediaType, candidate.tmdbId).catch(() => undefined);
  const research = parsed.setting || parsed.requiredKeywords.length
    ? await searchWeb({ query: buildGaryCandidateVerificationQuery(candidate.title, parsed), maxResults: 6, searchType: 'fast', useBrightDataFallback: true }).catch(() => undefined)
    : undefined;
  const evidenceText = [details?.overview, ...(research?.results || []).flatMap((result) => [result.title, result.snippet, ...result.highlights])].filter(Boolean).join(' ');
  return {
    ...candidate,
    actors: (details?.credits?.cast || []).map((person) => person.name).filter((name): name is string => Boolean(name)),
    countries: [...(details?.originCountry || []), ...(details?.productionCountries || []).flatMap((country) => [country.name, country.iso_3166_1]).filter((name): name is string => Boolean(name))],
    languages: details?.originalLanguage ? [details.originalLanguage] : [],
    evidenceText,
  } satisfies GaryTitleCandidateEvidence;
}

async function verifyCandidate(candidate: { title: string; mediaType: 'movie' | 'tv'; year?: number; tmdbId: number }, parsed: z.infer<typeof inputSchema>) {
  const evidence = await candidateEvidence(candidate, parsed);
  const constraints: GaryTitleConstraints = { mediaType: parsed.mediaType, year: parsed.year, actors: parsed.actors, setting: parsed.setting, country: parsed.country, language: parsed.language, requiredKeywords: parsed.requiredKeywords };
  return selectConstraintVerifiedGaryTitle([evidence], constraints).matrix[0];
}
const outputSchema = z.object({
  status: z.enum(['resolved', 'needs-research', 'needs-confirmation', 'service-unavailable']),
  canonicalTitle: z.string().optional(), year: z.number().int().optional(), tmdbId: z.number().int().positive().optional(),
  mediaType: z.enum(['movie', 'tv', 'unknown']), clues: z.array(z.string()), summary: z.string(),
});

export async function resolveGaryTitle(input: z.input<typeof inputSchema>): Promise<z.infer<typeof outputSchema>> {
  const parsed = inputSchema.parse(input);
  const queries = [...new Set([parsed.query, ...parsed.aliases])].slice(0, 6);
  const years = titleResolutionYears(parsed.year, parsed.festivalYear);
  if (hasHardConstraints(parsed)) {
    const rawCandidates = (await Promise.all(queries.map((query) => searchSeerr(query).catch(() => [])))).flat();
    const candidates = [...new Map(rawCandidates
      .filter((candidate) => parsed.mediaType === 'unknown' || candidate.mediaType === parsed.mediaType)
      .map((candidate) => [`${candidate.mediaType}:${candidate.id}`, candidate])).values()].slice(0, 15);
    const evidence = await Promise.all(candidates.map((candidate) => candidateEvidence({
      title: seerrTitle(candidate), mediaType: candidate.mediaType, year: seerrYear(candidate), tmdbId: candidate.id,
    }, parsed)));
    const constraints: GaryTitleConstraints = { mediaType: parsed.mediaType, year: parsed.year, actors: parsed.actors, setting: parsed.setting, country: parsed.country, language: parsed.language, requiredKeywords: parsed.requiredKeywords };
    const selection = selectConstraintVerifiedGaryTitle(evidence, constraints);
    if (selection.status === 'resolved' && selection.candidate) {
      const verified = selection.matrix.find((item) => item.candidate.tmdbId === selection.candidate!.tmdbId)!;
      return { status: 'resolved', canonicalTitle: selection.candidate.title, year: selection.candidate.year, tmdbId: selection.candidate.tmdbId,
        mediaType: selection.candidate.mediaType, clues: verified.constraints.map((item) => `${item.constraint} ${item.value}: ${item.status}`),
        summary: `Resolved ${selection.candidate.title}${selection.candidate.year ? ` (${selection.candidate.year})` : ''} only after verifying every supplied clue (TMDB ${selection.candidate.tmdbId}).` };
    }
    if (selection.status === 'ambiguous') return { status: 'needs-confirmation', mediaType: parsed.mediaType, clues: [], summary: 'More than one title satisfies every supplied clue. Ask for one distinguishing clue before requesting.' };
  }
  for (const query of queries) for (const year of years) {
    const checked = await checkMediaStatuses({ titles: [{ title: query, mediaType: parsed.mediaType, year }], requester: parsed.requester });
    const result = checked.results[0];
    if (result.status === 'service-unavailable') return { status: 'service-unavailable', mediaType: parsed.mediaType, clues: [], summary: `The canonical ${serverName()} title lookup is temporarily unavailable.` };
    if (result.resolvedTitle && result.resolvedTmdbId && !['needs-clarification', 'not-found'].includes(result.status)) {
      if (hasHardConstraints(parsed)) {
        const verified = await verifyCandidate({ title: result.resolvedTitle, year: result.resolvedYear, tmdbId: result.resolvedTmdbId, mediaType: result.mediaType as 'movie' | 'tv' }, parsed);
        if (!verified.fullyVerified) continue;
        const evidenceClues = verified.constraints.map((item) => `${item.constraint} ${item.value}: ${item.status}`);
        return { status: 'resolved', canonicalTitle: result.resolvedTitle, year: result.resolvedYear, tmdbId: result.resolvedTmdbId, mediaType: result.mediaType, clues: evidenceClues, summary: `Resolved ${result.resolvedTitle}${result.resolvedYear ? ` (${result.resolvedYear})` : ''} only after verifying every supplied clue (TMDB ${result.resolvedTmdbId}).` };
      }
      return { status: 'resolved', canonicalTitle: result.resolvedTitle, year: result.resolvedYear, tmdbId: result.resolvedTmdbId, mediaType: result.mediaType, clues: [`matched query: ${query}`, year ? `matched year: ${year}` : 'matched without a year constraint'], summary: `Resolved ${result.resolvedTitle}${result.resolvedYear ? ` (${result.resolvedYear})` : ''} to confirmed title metadata (TMDB ${result.resolvedTmdbId}).` };
    }
    if (result.resolvedTitle) return { status: 'needs-confirmation', canonicalTitle: result.resolvedTitle, year: result.resolvedYear, tmdbId: result.resolvedTmdbId, mediaType: result.mediaType, clues: [`matched query: ${query}`], summary: `Found a likely match for ${result.resolvedTitle}; confirm it before requesting.` };
  }
  const clues = [parsed.country && `country: ${parsed.country}`, parsed.language && `language: ${parsed.language}`, parsed.festivalYear && `festival year: ${parsed.festivalYear}`, ...parsed.aliases.map((alias) => `alias: ${alias}`)].filter((value): value is string => Boolean(value));
  const researchQuery = buildGaryTitleResearchQuery(parsed);
  const research = await searchWeb({ query: researchQuery, maxResults: 5, searchType: 'fast', useBrightDataFallback: true }).catch(() => undefined);
  const webClues = research?.results.flatMap((result) => {
    const tmdb = result.url.match(/themoviedb\.org\/(movie|tv)\/(\d+)/i);
    return [result.title && `web title: ${result.title}`, tmdb && `TMDB ${tmdb[1]} id: ${tmdb[2]}`].filter((value): value is string => Boolean(value));
  }).slice(0, 8) || [];
  const stableCandidate = research?.results.map((result) => {
    const match = result.url.match(/themoviedb\.org\/(movie|tv)\/(\d+)/i);
    return match ? { mediaType: match[1] as 'movie' | 'tv', tmdbId: Number(match[2]), title: result.title } : undefined;
  }).find(Boolean);
  return { status: 'needs-confirmation', mediaType: stableCandidate?.mediaType || parsed.mediaType, tmdbId: stableCandidate?.tmdbId, canonicalTitle: stableCandidate?.title, clues: [...clues, ...webClues], summary: webClues.length
    ? `Automatic web research found metadata clues, but ${serverName()} has not yet confirmed one canonical title. Confirm the likely title and rerun resolution before requesting.`
    : 'Automatic web research did not produce a safely confirmed title. Ask for one distinguishing clue before requesting.' };
}

export function titleResolutionYears(year?: number, festivalYear?: number) {
  return [...new Set([year, festivalYear, undefined])];
}

export function buildGaryTitleResearchQuery(input: Pick<z.infer<typeof inputSchema>, 'query' | 'country' | 'language' | 'festivalYear' | 'year' | 'aliases'>) {
  const clues = [input.country && `country ${JSON.stringify(input.country)}`, input.language && `language ${JSON.stringify(input.language)}`,
    input.festivalYear && `festival ${input.festivalYear}`, input.year && `general release ${input.year}`,
    ...input.aliases.map((alias) => `alias ${JSON.stringify(alias)}`)].filter((value): value is string => Boolean(value));
  return [`movie TV title ${JSON.stringify(input.query)}`, ...clues, 'site:themoviedb.org'].join(' ');
}

export function buildGaryCandidateVerificationQuery(title: string, input: Pick<z.infer<typeof inputSchema>, 'actors' | 'setting' | 'country' | 'language' | 'requiredKeywords'>) {
  return [JSON.stringify(title), ...input.actors.map((actor) => JSON.stringify(actor)), input.setting && `setting ${JSON.stringify(input.setting)}`,
    input.country && `country ${JSON.stringify(input.country)}`, input.language && `language ${JSON.stringify(input.language)}`,
    ...input.requiredKeywords.map((keyword) => JSON.stringify(keyword))].filter((value): value is string => Boolean(value)).join(' ');
}

const resolveStep = createStep({ id: 'resolve-gary-title', inputSchema, outputSchema, execute: async ({ inputData }) => resolveGaryTitle(inputData) });
export const garyTitleResolutionWorkflow = createWorkflow({ id: 'gary-title-resolution', inputSchema, outputSchema }).then(resolveStep).commit();
