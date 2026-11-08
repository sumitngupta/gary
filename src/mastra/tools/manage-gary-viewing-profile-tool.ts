import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { checkViewingTitles, connectTautulliUser, disconnectViewingHistory, findTautulliUserMatches, getCompactViewingProfile, refreshViewingProfile } from '../services/tautulli-viewing-profile';
import { getGaryUserProfile, updateGaryUserProfile } from '../services/gary-user-profile-store';

export const manageGaryViewingProfileTool = createTool({
  id: 'manage-gary-viewing-profile',
  description: 'Connect the current user’s matching local Plex/Tautulli viewing profile by default, refresh or read its compact taste summary, check recommendation candidates against watched history, or honor a durable opt-out by disconnecting and erasing it.',
  inputSchema: z.object({
    action: z.enum(['find-match', 'connect', 'refresh', 'get', 'check-titles', 'disconnect']),
    name: z.string().trim().min(1).max(100).optional(),
    username: z.string().trim().min(1).max(100).optional(),
    userConsented: z.boolean().optional(),
    titles: z.array(z.object({ title: z.string().trim().min(1).max(200), year: z.number().int().min(1870).max(2100).optional() })).max(20).optional(),
  }),
  outputSchema: z.object({ status: z.string(), summary: z.string(), data: z.unknown().optional() }),
  execute: async (input, context) => {
    const resourceId = context.agent?.resourceId;
    if (!resourceId) return { status: 'service-unavailable', summary: 'The current user context is unavailable.' };
    if (input.action === 'find-match') {
      const profile = await getGaryUserProfile(resourceId);
      if (profile?.plexPersonalizationConsent === 'declined') {
        return { status: 'opted-out', summary: 'This user opted out of Plex viewing-history personalization. Do not reconnect unless they explicitly ask to opt back in.' };
      }
      const name = input.name || profile?.preferredName;
      if (!name) return { status: 'name-required', summary: 'I need to know what you are called before I can privately match a Plex profile.' };
      const matches = await findTautulliUserMatches(name);
      if (matches.length === 0) return { status: 'not-found', summary: `I could not confidently match a local Plex profile for ${name}.` };
      const best = matches[0]!;
      const unique = best.score >= 80 && (!matches[1] || best.score > matches[1].score);
      if (!unique) {
        return { status: 'ambiguous', summary: `I found more than one possible local Plex profile for ${name}. Ask one short identity clarification using only these candidate usernames. Viewing-history personalization is enabled by default, so do not ask a separate consent question.`, data: matches.map(({ username, name: displayName }) => ({ username, name: displayName })) };
      }
      const match = await connectTautulliUser(resourceId, best.username);
      if (!match) return { status: 'not-found', summary: `I could not connect the matched Plex profile ${best.username}.` };
      await updateGaryUserProfile(resourceId, { plexPersonalizationConsent: 'granted' });
      const viewing = await refreshViewingProfile(resourceId);
      return { status: 'connected', summary: `Matched and connected the local Plex viewing profile ${match.username} by default. Tell the user briefly that viewing-history personalization is on and that they can opt out at any time.`, data: viewing };
    }
    if (input.action === 'connect') {
      if (!input.username) return { status: 'username-required', summary: 'The exact Plex username is required.' };
      const userProfile = await getGaryUserProfile(resourceId);
      if (userProfile?.plexPersonalizationConsent === 'declined' && !input.userConsented) {
        return { status: 'consent-required', summary: 'This user previously opted out. They must explicitly ask to opt back in before reconnecting.' };
      }
      const match = await connectTautulliUser(resourceId, input.username);
      if (!match) return { status: 'not-found', summary: `I could not find the Plex profile ${input.username}.` };
      await updateGaryUserProfile(resourceId, { plexPersonalizationConsent: 'granted' });
      const profile = await refreshViewingProfile(resourceId);
      return { status: 'connected', summary: `Connected the local Plex viewing profile ${match.username} and analyzed ${profile.titlesAnalyzed} recent titles.`, data: profile };
    }
    if (input.action === 'disconnect') {
      if (!input.userConsented) return { status: 'consent-required', summary: 'Explicit confirmation is required to disconnect and erase the derived viewing profile.' };
      const count = await disconnectViewingHistory(resourceId);
      await updateGaryUserProfile(resourceId, { plexPersonalizationConsent: 'declined' });
      return { status: 'disconnected', summary: `Disconnected Plex viewing personalization and deleted ${count} local profile record(s).` };
    }
    if (input.action === 'refresh') return { status: 'refreshed', summary: 'Refreshed the local viewing profile.', data: await refreshViewingProfile(resourceId) };
    if (input.action === 'check-titles') return { status: 'ok', summary: 'Checked candidates against the current user’s local viewing index.', data: await checkViewingTitles(resourceId, input.titles || []) };
    const profile = await getCompactViewingProfile(resourceId);
    return profile ? { status: 'connected', summary: 'Loaded the compact local viewing profile.', data: profile } : { status: 'not-connected', summary: 'No Plex viewing profile is connected for this user.' };
  },
});
