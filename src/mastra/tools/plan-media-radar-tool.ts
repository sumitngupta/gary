import { createTool } from '@mastra/core/tools';
import {
  mediaRadarInputSchema,
  mediaRadarPlanSchema,
  type MediaRadarCandidate,
  type MediaRadarPreferences,
  type MediaRadarScoredCandidate,
} from '../schemas/media-radar';
import { serverName } from '../config/branding';

function normalizedSet(values: string[]) {
  return new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean));
}

function hasOverlap(candidateValues: string[], targetValues: Set<string>) {
  return candidateValues.some((value) => targetValues.has(value.trim().toLowerCase()));
}

function scoreCandidate(
  candidate: MediaRadarCandidate,
  preferences: MediaRadarPreferences,
): MediaRadarScoredCandidate {
  const preferredGenres = normalizedSet(preferences.preferredGenres);
  const blockedGenres = normalizedSet(preferences.blockedGenres);
  const reasons: string[] = [];
  let score = 0;

  if (candidate.metascore !== undefined) {
    score += candidate.metascore;
    if (candidate.metascore >= preferences.minMetascore) {
      reasons.push(`Metascore ${candidate.metascore} clears the ${preferences.minMetascore} threshold`);
    } else {
      reasons.push(`Metascore ${candidate.metascore} is below the ${preferences.minMetascore} threshold`);
      score -= 20;
    }
  } else {
    reasons.push('No Metascore supplied yet');
    score -= 10;
  }

  if (candidate.userScore !== undefined) {
    score += candidate.userScore * 4;
    if (candidate.userScore >= preferences.minUserScore) {
      reasons.push(`User score ${candidate.userScore.toFixed(1)} clears the ${preferences.minUserScore} threshold`);
    } else {
      reasons.push(`User score ${candidate.userScore.toFixed(1)} is below the ${preferences.minUserScore} threshold`);
      score -= 12;
    }
  } else {
    reasons.push('No user score supplied yet');
  }

  if ((candidate.criticReviewCount || 0) >= preferences.minCriticReviewCount) {
    score += 8;
    reasons.push(`${candidate.criticReviewCount} critic reviews gives the signal some weight`);
  } else if (candidate.criticReviewCount !== undefined) {
    score -= 5;
    reasons.push(`Only ${candidate.criticReviewCount} critic reviews so far`);
  }

  if (preferredGenres.size > 0 && hasOverlap(candidate.genres, preferredGenres)) {
    score += 12;
    reasons.push('Matches preferred genres');
  }

  if (blockedGenres.size > 0 && hasOverlap(candidate.genres, blockedGenres)) {
    score -= 80;
    reasons.push('Matches a blocked genre');
  }

  if (candidate.alreadyKnown && !preferences.includeAlreadyKnown) {
    score -= 60;
    reasons.push('Already known locally, so keep it out of a discovery shortlist');
  }

  for (const signal of candidate.signals.slice(0, 3)) {
    reasons.push(signal);
  }

  const recommendation = score >= 90 ? 'shortlist' : score >= 65 ? 'watch' : 'reject';

  return {
    ...candidate,
    score: Math.round(score * 10) / 10,
    recommendation,
    reasons,
  };
}

function renderDraftMessage(
  shortlist: MediaRadarScoredCandidate[],
  preferences: MediaRadarPreferences,
) {
  const lines = [
    `Draft ${preferences.deliveryChannel} watchlist radar for ${preferences.requester}: ${preferences.theme}`,
    '',
  ];

  if (shortlist.length === 0) {
    lines.push('No supplied candidates cleared the shortlist threshold yet.');
  } else {
    for (const [index, item] of shortlist.entries()) {
      const scoreParts = [
        item.metascore === undefined ? undefined : `Metascore ${item.metascore}`,
        item.userScore === undefined ? undefined : `user ${item.userScore.toFixed(1)}`,
      ].filter(Boolean);
      lines.push(
        `${index + 1}. ${item.title}${item.year ? ` (${item.year})` : ''} - ${scoreParts.join(', ') || `score ${item.score}`}. ${item.reasons[0] || 'Worth a closer look.'}`,
      );
    }
  }

  lines.push('', 'Recommendations only; no downloads or media requests were started.');
  return lines.join('\n');
}

export const planMediaRadarTool = createTool({
  id: 'plan-media-radar',
  description:
    'Score supplied movie/TV discovery candidates and draft a recommendation digest. Use Gary web research to collect candidates before calling this tool.',
  inputSchema: mediaRadarInputSchema,
  outputSchema: mediaRadarPlanSchema,
  execute: async (input) => {
    const request = mediaRadarInputSchema.parse(input);
    const scored = request.candidates
      .map((candidate) => scoreCandidate(candidate, request.preferences))
      .sort((left, right) => right.score - left.score);

    const shortlist = scored
      .filter((candidate) => candidate.recommendation === 'shortlist')
      .slice(0, request.preferences.shortlistSize);
    const rejected = scored.filter(
      (candidate) => !shortlist.some((item) => item.title === candidate.title && item.mediaType === candidate.mediaType),
    );

    return {
      status: 'draft-ready' as const,
      requester: request.preferences.requester,
      theme: request.preferences.theme,
      shortlist,
      rejected,
      draftMessage: renderDraftMessage(shortlist, request.preferences),
      nextReadOnlyChecks: [
        'Confirm candidate source pages and metadata freshness.',
        `Check whether shortlisted titles already exist in ${serverName()} library or a watchlist before proposing any add.`,
        'Review parental/content fit when the list is for family viewing.',
      ],
      approvalRequiredBefore: ['deleting or replacing media', 'changing media files or quality profiles'],
    };
  },
});
