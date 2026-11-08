export type GaryTitleConstraints = {
  mediaType?: 'movie' | 'tv' | 'unknown';
  year?: number;
  actors?: string[];
  setting?: string;
  country?: string;
  language?: string;
  requiredKeywords?: string[];
};

export type GaryTitleCandidateEvidence = {
  title: string;
  mediaType: 'movie' | 'tv';
  year?: number;
  tmdbId: number;
  actors: string[];
  countries: string[];
  languages: string[];
  evidenceText: string;
};

export type GaryConstraintResult = { constraint: string; value: string; status: 'verified' | 'contradicted' | 'missing' };

function normalized(value: string) {
  return value.toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function contains(values: string[], expected: string) {
  const target = normalized(expected);
  return values.some((value) => normalized(value) === target || normalized(value).includes(target) || target.includes(normalized(value)));
}

export function verifyGaryTitleCandidate(candidate: GaryTitleCandidateEvidence, constraints: GaryTitleConstraints) {
  const results: GaryConstraintResult[] = [];
  if (constraints.mediaType && constraints.mediaType !== 'unknown') results.push({ constraint: 'mediaType', value: constraints.mediaType, status: candidate.mediaType === constraints.mediaType ? 'verified' : 'contradicted' });
  if (constraints.year) results.push({ constraint: 'year', value: String(constraints.year), status: candidate.year === constraints.year ? 'verified' : 'contradicted' });
  for (const actor of constraints.actors || []) results.push({ constraint: 'actor', value: actor, status: candidate.actors.length ? (contains(candidate.actors, actor) ? 'verified' : 'contradicted') : 'missing' });
  if (constraints.country) results.push({ constraint: 'country', value: constraints.country, status: candidate.countries.length ? (contains(candidate.countries, constraints.country) ? 'verified' : 'contradicted') : 'missing' });
  if (constraints.language) results.push({ constraint: 'language', value: constraints.language, status: candidate.languages.length ? (contains(candidate.languages, constraints.language) ? 'verified' : 'contradicted') : 'missing' });
  const evidence = normalized(candidate.evidenceText);
  if (constraints.setting) results.push({ constraint: 'setting', value: constraints.setting, status: evidence.includes(normalized(constraints.setting)) ? 'verified' : 'missing' });
  for (const keyword of constraints.requiredKeywords || []) results.push({ constraint: 'keyword', value: keyword, status: evidence.includes(normalized(keyword)) ? 'verified' : 'missing' });
  return { candidate, constraints: results, contradicted: results.some((item) => item.status === 'contradicted'), fullyVerified: results.length > 0 && results.every((item) => item.status === 'verified') };
}

export function selectConstraintVerifiedGaryTitle(candidates: GaryTitleCandidateEvidence[], constraints: GaryTitleConstraints) {
  const matrix = candidates.map((candidate) => verifyGaryTitleCandidate(candidate, constraints));
  const verified = matrix.filter((item) => item.fullyVerified);
  return { status: verified.length === 1 ? 'resolved' as const : verified.length > 1 ? 'ambiguous' as const : 'unverified' as const, candidate: verified.length === 1 ? verified[0].candidate : undefined, matrix };
}
