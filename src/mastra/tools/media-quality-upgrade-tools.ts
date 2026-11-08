import { createTool, type ToolExecutionContext } from '@mastra/core/tools';
import {
  mediaQualityUpgradeExecuteInputSchema, mediaQualityUpgradeExecuteOutputSchema,
  mediaQualityUpgradePreviewInputSchema, mediaQualityUpgradePreviewOutputSchema, type MediaQualityUpgradeItem,
} from '../schemas/media-quality-upgrade';
import { applyArrHardQualityProfileAndSearch, getRadarrMovieStatus, getSonarrSeriesStatus, getArrMediaQualityAudit } from '../services/arr-readonly-client';
import { consumeMediaQualityUpgradePlan, createMediaQualityUpgradePlan, recordMediaQualityUpgrade } from '../services/media-quality-upgrade-store';

import { isGaryWhatsAppActorAuthorized } from '../services/gary-access-policy';
import { serverName } from '../config/branding';

function actor(context: ToolExecutionContext | undefined) {
  const channel = context?.requestContext?.get('channel') as { platform?: string; userId?: string } | undefined;
  if (channel?.platform && channel.userId) {
    const id = channel.platform.toLowerCase() === 'whatsapp' ? `+${channel.userId.replace(/\D/g, '')}` : channel.userId;
    return `${channel.platform.toLowerCase()}:${id}`;
  }
  return context?.agent?.resourceId || '';
}
function owners() {
  const values = (process.env.GARY_MEDIA_OWNER_ACTORS || '').split(',').map((v) => v.trim()).filter(Boolean);
  if (process.env.GARY_ADMIN_WHATSAPP) values.push(`whatsapp:${process.env.GARY_ADMIN_WHATSAPP}`);
  values.push('admin-household'); return new Set(values);
}
export async function canRequestMediaQualityUpgrade(actorId: string) {
  if (owners().has(actorId)) return true;
  if (actorId.startsWith('whatsapp:') && /^\+?\d+$/.test(actorId.slice(9))) {
    return isGaryWhatsAppActorAuthorized(actorId.slice(9));
  }
  return false;
}
const hardProfile = (type: 'movie' | 'tv') => Number.parseInt(type === 'movie'
  ? process.env.GARY_HARD_QUALITY_RADARR_PROFILE_ID || '8'
  : process.env.GARY_HARD_QUALITY_SONARR_PROFILE_ID || '9', 10);

export const previewMediaQualityUpgradeTool = createTool({
  id: 'preview-media-quality-upgrade', description: 'Authorized-user read-only preview that freezes exact existing noncompliant titles for the hard 4K Dolby Vision plus Atmos profile. It does not change profiles, search, download, or replace files.',
  inputSchema: mediaQualityUpgradePreviewInputSchema, outputSchema: mediaQualityUpgradePreviewOutputSchema,
  execute: async (input, context) => {
    const actorId = actor(context);
    if (!await canRequestMediaQualityUpgrade(actorId)) return { status: 'denied' as const, items: [], totalCurrentBytes: 0, summary: `Quality upgrades require an authorized ${serverName()} user.`, mutation: false as const };
    try {
      const items: MediaQualityUpgradeItem[] = [];
      for (const candidate of input.candidates) {
        const [audit, status] = await Promise.all([
          getArrMediaQualityAudit({ ...candidate, query: candidate.title }),
          candidate.mediaType === 'movie' ? getRadarrMovieStatus({ query: candidate.title, year: candidate.year, tmdbId: candidate.tmdbId }) : getSonarrSeriesStatus({ query: candidate.title, year: candidate.year, tmdbId: candidate.tmdbId, tvdbId: candidate.tvdbId }),
        ]);
        if (!audit || !status) continue;
        const failures = audit.files.flatMap((file, index) => [file.resolution < 2160 ? `File ${index + 1} is below 2160p.` : undefined, !file.hasDolbyVision ? `File ${index + 1} has no verified Dolby Vision evidence.` : undefined, !file.hasAtmos ? `File ${index + 1} has no verified Atmos evidence.` : undefined].filter((v): v is string => Boolean(v)));
        if (!failures.length) continue;
        const arr = candidate.mediaType === 'movie'
          ? (status as Awaited<ReturnType<typeof getRadarrMovieStatus>> & {}).movie
          : (status as Awaited<ReturnType<typeof getSonarrSeriesStatus>> & {}).series;
        if (!arr.qualityProfileId) throw new Error(`${audit.title} has no current quality profile id.`);
        items.push({ ...candidate, title: audit.title, year: audit.year, arrId: arr.id, currentProfileId: arr.qualityProfileId, targetProfileId: hardProfile(candidate.mediaType), currentBytes: audit.files.reduce((n, file) => n + (file.size || 0), 0), fileCount: audit.files.length, failures });
      }
      if (!items.length) return { status: 'nothing-to-upgrade' as const, items, totalCurrentBytes: 0, summary: 'No resolved existing files require this upgrade.', mutation: false as const };
      if (items.length !== input.candidates.length) return { status: 'not-found' as const, items, totalCurrentBytes: items.reduce((n, i) => n + i.currentBytes, 0), summary: `Only ${items.length} of ${input.candidates.length} titles resolved as noncompliant; refusing a partial plan.`, mutation: false as const };
      const plan = await createMediaQualityUpgradePlan(actorId, items);
      return { status: 'ready' as const, planId: plan.id, expiresAt: plan.expiresAt, items, totalCurrentBytes: items.reduce((n, i) => n + i.currentBytes, 0), summary: `Ready for your approval: apply the hard profile and start upgrade searches for ${items.length} exact title(s). Current files stay in place until Arr imports a qualifying replacement.`, mutation: false as const };
    } catch (error) { return { status: 'service-unavailable' as const, items: [], totalCurrentBytes: 0, summary: `Could not prepare the upgrade plan: ${error instanceof Error ? error.message : String(error)}`, mutation: false as const }; }
  },
});

export const executeMediaQualityUpgradeTool = createTool({
  id: 'execute-media-quality-upgrade', requireApproval: true,
  description: 'Requesting-user-approved execution of one immutable quality-upgrade plan. Applies the hard Arr profile and starts an upgrade search; it never deletes the current file before a replacement imports.',
  inputSchema: mediaQualityUpgradeExecuteInputSchema, outputSchema: mediaQualityUpgradeExecuteOutputSchema,
  execute: async ({ planId }, context) => {
    const actorId = actor(context);
    if (!await canRequestMediaQualityUpgrade(actorId)) return { status: 'denied' as const, started: [], failed: [], summary: `Quality upgrades require an authorized ${serverName()} user.`, mutation: true as const };
    const items = await consumeMediaQualityUpgradePlan(planId, actorId);
    if (!items) return { status: 'expired' as const, started: [], failed: [], summary: 'That upgrade plan expired, was already used, or belongs to another user.', mutation: true as const };
    const started: MediaQualityUpgradeItem[] = []; const failed: Array<MediaQualityUpgradeItem & { error: string }> = [];
    for (const item of items) { try { await applyArrHardQualityProfileAndSearch(item); started.push(item); } catch (error) { failed.push({ ...item, error: error instanceof Error ? error.message : String(error) }); } }
    const status = failed.length === 0 ? 'started' as const : started.length ? 'partially-started' as const : 'failed' as const;
    await recordMediaQualityUpgrade({ planId, actorId, status, started, failed });
    return { status, started, failed, summary: `Started ${started.length} of ${items.length} hard-profile upgrade search(es). Existing files remain available until qualifying replacements import.${failed.length ? ` ${failed.length} failed and can be replanned safely.` : ''}`, mutation: true as const };
  },
});
