import { getGaryUserProfile } from './gary-user-profile-store';
import { getCompactViewingProfile } from './tautulli-viewing-profile';
import { getGaryHouseholdContext } from './gary-household-context-store';

export type GaryRecommendationContext = {
  personalLikes: string[]; personalDislikes: string[]; contentBoundaries: string[];
  viewingSignals?: Record<string, unknown>;
  viewerAges: number[]; sharedLikes: string[]; intensityPolicy: string;
};

export async function getGaryRecommendationContext(resourceId: string): Promise<GaryRecommendationContext> {
  const [personal, household, viewing, canonicalHousehold] = await Promise.all([
    getGaryUserProfile(resourceId),
    resourceId === 'admin-household' ? undefined : getGaryUserProfile('admin-household'),
    getCompactViewingProfile(resourceId),
    getGaryHouseholdContext(),
  ]);
  const taste = viewing as (Record<string, unknown> & { lastSyncedAt?: string }) | undefined;
  return {
    personalLikes: personal?.likes || [],
    personalDislikes: [...new Set([...(personal?.dislikes || []), ...(household?.dislikes || [])])].slice(0, 30),
    contentBoundaries: [...new Set([...canonicalHousehold.contentBoundaries, ...(household?.contentBoundaries || []), ...(personal?.contentBoundaries || [])])].slice(0, 30),
    viewerAges: canonicalHousehold.viewerAges,
    sharedLikes: [...new Set([...canonicalHousehold.sharedLikes, ...(household?.likes || [])])].slice(0, 30),
    intensityPolicy: canonicalHousehold.intensityPolicy,
    viewingSignals: taste ? {
      strongGenres: taste.strongGenres,
      completedTitles: taste.completedTitles,
      repeatTitles: taste.repeatTitles,
      titlesAnalyzed: taste.titlesAnalyzed,
      windowMonths: taste.windowMonths,
      lastSyncedAt: taste.lastSyncedAt,
    } : undefined,
  };
}
