import { createHash } from 'node:crypto';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { ensureGaryUserProfile, getGaryUserProfile, updateGaryUserProfile } from '../services/gary-user-profile-store';

const fields = z.object({
  preferredName: z.string().trim().min(1).max(80).optional(),
  likes: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  dislikes: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  contentBoundaries: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
});

export const manageGaryProfileTool = createTool({
  id: 'manage-gary-profile',
  description: 'Read or update the current user’s compact Gary preference profile during progressive onboarding or after an explicit preference request.',
  inputSchema: z.object({ action: z.enum(['get', 'update', 'skip-onboarding', 'mark-recommendations-shown']), profile: fields.optional() }),
  outputSchema: z.object({ status: z.string(), summary: z.string(), profile: z.record(z.string(), z.unknown()).optional() }),
  execute: async (input, context) => {
    const resourceId = context.agent?.resourceId;
    if (!resourceId) return { status: 'service-unavailable', summary: 'The current user context is unavailable.' };
    if (input.action === 'get') {
      const existing = await getGaryUserProfile(resourceId) || await ensureGaryUserProfile(resourceId);
      return { status: 'ok', summary: 'Loaded the current user profile.', profile: existing };
    }
    if (input.action === 'skip-onboarding') {
      const next = await updateGaryUserProfile(resourceId, { onboardingState: 'skipped' });
      return { status: 'skipped', summary: 'Onboarding questions will be skipped.', profile: next };
    }
    if (input.action === 'mark-recommendations-shown') {
      const next = await updateGaryUserProfile(resourceId, { onboardingState: 'settled', recommendationDemoAt: new Date().toISOString() });
      return { status: 'updated', summary: 'The introductory recommendations were shown.', profile: next };
    }
    const supplied = input.profile || {};
    const existing = await ensureGaryUserProfile(resourceId, 'profile-started');
    const next = await updateGaryUserProfile(resourceId, {
      ...supplied,
      likes: supplied.likes ? [...new Set([...existing.likes, ...supplied.likes])].slice(0, 30) : existing.likes,
      dislikes: supplied.dislikes ? [...new Set([...existing.dislikes, ...supplied.dislikes])].slice(0, 30) : existing.dislikes,
      contentBoundaries: supplied.contentBoundaries ? [...new Set([...existing.contentBoundaries, ...supplied.contentBoundaries])].slice(0, 30) : existing.contentBoundaries,
      onboardingState: supplied.preferredName || supplied.likes?.length || supplied.dislikes?.length ? 'profile-started' : existing.onboardingState,
    });
    return { status: 'updated', summary: 'Updated the current user’s explicit preferences.', profile: next };
  },
});

export function profileDedupeKey(summary: string, reason: string) {
  return createHash('sha256').update(`${summary}\n${reason}`.toLowerCase()).digest('hex').slice(0, 24);
}
