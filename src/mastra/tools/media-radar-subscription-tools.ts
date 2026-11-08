import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { createMediaRadarSubscription, getMediaRadarSubscription, listMediaRadarSubscriptions, recordMediaRadarCandidates, updateMediaRadarSubscription } from '../services/media-radar-subscription-store';
import { deliverMediaRadar } from '../services/media-radar-notification-service';
import { KeyedTaskQueue } from '../services/keyed-task-queue';
import { checkMediaStatuses } from './check-media-statuses-tool';
import { serverName } from '../config/branding';
const deliveryQueue = new KeyedTaskQueue();

const candidateSchema = z.object({ title: z.string().min(1), year: z.number().int().optional() });

export function mediaRadarSchedulePrompt(input: { subscriptionId: string; theme: string; constraints: string[]; preferredGenres: string[]; blockedGenres: string[]; shortlistSize: number; previouslySurfaced?: string[] }) {
  return `Create the recurring Gary recommendation digest for subscription ${input.subscriptionId}. Theme: ${input.theme}. Constraints: ${input.constraints.join('; ') || 'none'}. Preferred genres: ${input.preferredGenres.join(', ') || 'none'}. Blocked genres: ${input.blockedGenres.join(', ') || 'none'}. Find current, source-grounded candidates with one bounded discovery pass. Fetch only the finalists whose snippets do not establish the needed evidence. Check the complete shortlist in one ${serverName()}-status call. Exclude titles already in ${serverName()} and never repeat these previously surfaced titles: ${(input.previouslySurfaced || []).join(', ') || 'none'}. Select at most ${input.shortlistSize}; a smaller fully supported list is better than exhausting the run. Prefer released, currently requestable titles. Put intentionally included unreleased titles in a clearly labeled Upcoming section, and require source-grounded age suitability for child-oriented recommendations. Compose the complete polished user-facing digest, then call recordMediaRadarDelivery with the subscription id, exact selected titles, and that exact digest text. Return the same digest after the tool succeeds. This run is read-only except for that exact delivery record: do not request titles, create availability watches, or change profiles.

The final response is a friendly note from Gary, not an operations report. Show only the recommendations, a short reason each fits, whether each is Watch now, Requestable, or Upcoming, useful plain-language ${serverName()} availability when it was checked, and direct source links. Never promise a future notification unless the user separately created a watch. Never expose the subscription id, cron or schedule expression, tool names, internal constraint syntax, lookup/filtering mechanics, resource or thread ids, recording/deduplication steps, or implementation commentary. Do not narrate that you searched, fetched, filtered, excluded, checked tools, or recorded anything. Use natural section names when the theme has categories and end with at most one conversational offer to help with a title.`;
}

export const manageMediaRadarSubscriptionsTool = createTool({
  id: 'manage-media-radar-subscriptions',
  description: 'Create, list, update, pause, resume, run now, or cancel recurring personalized Gary recommendation digests for the current user and chat.',
  inputExamples: [
    { input: { action: 'create', name: 'Friday sci-fi', theme: 'new thoughtful science-fiction movies and shows', cron: '0 18 * * 5', timezone: 'America/New_York', preferredGenres: ['science fiction'], constraints: ['avoid very grim stories'], shortlistSize: 5 } },
    { input: { action: 'pause', subscriptionId: 'radar_example' } },
    { input: { action: 'update', subscriptionId: 'radar_example', cron: '0 9 1 * *', timezone: 'America/New_York' } },
  ],
  inputSchema: z.object({
    action: z.enum(['create', 'list', 'update', 'pause', 'resume', 'run', 'cancel']),
    subscriptionId: z.string().optional(), name: z.string().min(1).optional(), theme: z.string().min(1).optional(),
    cron: z.string().min(1).optional(), timezone: z.string().min(1).optional(), channel: z.enum(['telegram', 'slack', 'whatsapp', 'none']).optional(),
    quietHours: z.object({ start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }).optional(),
    preferredGenres: z.array(z.string()).optional(), blockedGenres: z.array(z.string()).optional(), constraints: z.array(z.string()).optional(), shortlistSize: z.number().int().min(1).max(20).optional(),
  }),
  outputSchema: z.object({ status: z.string(), subscriptionId: z.string().optional(), summary: z.string(), subscriptions: z.array(z.object({ id: z.string(), name: z.string(), theme: z.string(), cron: z.string(), timezone: z.string(), status: z.string() })).optional() }),
  execute: async (input, context) => {
    const resourceId = context.agent?.resourceId;
    const threadId = context.agent?.threadId;
    if (!resourceId || !threadId || !context.mastra) return { status: 'service-unavailable', summary: 'The current chat or scheduler was unavailable.' };
    if (input.action === 'list') {
      const items = await listMediaRadarSubscriptions({ resourceId });
      return { status: 'listed', summary: items.length ? `Found ${items.length} recommendation subscription(s).` : 'No recommendation subscriptions are active.', subscriptions: items.map(({ id, name, theme, cron, timezone, status }) => ({ id, name, theme, cron, timezone, status })) };
    }
    if (input.action === 'create') {
      if (!input.theme || !input.cron) return { status: 'invalid', summary: 'A theme and schedule are required.' };
      const theme = input.theme;
      const timezone = input.timezone || 'Etc/UTC';
      const preferredGenres = input.preferredGenres || [];
      const blockedGenres = input.blockedGenres || [];
      const constraints = input.constraints || [];
      const shortlistSize = input.shortlistSize || 5;
      const provisionalId = `radar-${Date.now()}`;
      // Mastra Channels render agent signals in channel-backed threads, so
      // scheduled research runs in a private thread.
      const executionThreadId = `gary-radar:${provisionalId}`;
      if (executionThreadId !== threadId) {
        const memory = await context.mastra.getAgent('gary').getMemory();
        await memory?.createThread({
          threadId: executionThreadId,
          resourceId,
          title: `Gary recurring radar: ${input.name || theme}`,
          metadata: { kind: 'gary-media-radar-execution' },
        });
      }
      const schedule = await context.mastra.schedules.create({ id: provisionalId, agentId: 'gary', name: input.name || theme, cron: input.cron, timezone, resourceId, threadId: executionThreadId, prompt: mediaRadarSchedulePrompt({ subscriptionId: provisionalId, theme, constraints, preferredGenres, blockedGenres, shortlistSize }), metadata: { kind: 'gary-media-radar' } });
      try {
        const item = await createMediaRadarSubscription({ scheduleId: schedule.id, name: input.name || theme, requester: resourceId, resourceId, threadId, channel: input.channel || (resourceId.startsWith('slack:') || threadId.startsWith('slack:') ? 'slack' : resourceId.startsWith('telegram:') ? 'telegram' : resourceId.startsWith('whatsapp:') ? 'whatsapp' : 'none'), theme, cron: input.cron, timezone, quietHours: input.quietHours, preferredGenres, blockedGenres, constraints, shortlistSize });
        await context.mastra.schedules.update(schedule.id, { prompt: mediaRadarSchedulePrompt({ subscriptionId: item.id, theme, constraints, preferredGenres, blockedGenres, shortlistSize }) });
        const quiet = item.quietHours ? ` Quiet hours: ${item.quietHours.start}-${item.quietHours.end}.` : '';
        return { status: 'created', subscriptionId: item.id, summary: `Created ${item.name}: ${item.cron} (${item.timezone}), delivered to this chat.${quiet} Say “pause ${item.name}” or “cancel ${item.name}” anytime.` };
      } catch (error) {
        await context.mastra.schedules.delete(schedule.id).catch(() => undefined);
        throw error;
      }
    }
    if (!input.subscriptionId) return { status: 'invalid', summary: 'A subscription id is required.' };
    const item = await getMediaRadarSubscription(input.subscriptionId);
    if (!item || item.resourceId !== resourceId) return { status: 'not-found', summary: 'No matching recommendation subscription was found for this user.' };
    if (input.action === 'pause') { await context.mastra.schedules.pause(item.scheduleId); await updateMediaRadarSubscription(item.id, { status: 'paused' }); }
    if (input.action === 'resume') { await context.mastra.schedules.resume(item.scheduleId); await updateMediaRadarSubscription(item.id, { status: 'active' }); }
    if (input.action === 'run') await context.mastra.schedules.run(item.scheduleId);
    if (input.action === 'cancel') { await context.mastra.schedules.delete(item.scheduleId); await updateMediaRadarSubscription(item.id, { status: 'cancelled' }); }
    if (input.action === 'update') {
      const updated = { ...item, ...(input.name ? { name: input.name } : {}), ...(input.theme ? { theme: input.theme } : {}), ...(input.cron ? { cron: input.cron } : {}), ...(input.timezone ? { timezone: input.timezone } : {}), ...(input.channel ? { channel: input.channel } : {}), ...(input.quietHours !== undefined ? { quietHours: input.quietHours } : {}), ...(input.preferredGenres !== undefined ? { preferredGenres: input.preferredGenres } : {}), ...(input.blockedGenres !== undefined ? { blockedGenres: input.blockedGenres } : {}), ...(input.constraints !== undefined ? { constraints: input.constraints } : {}), ...(input.shortlistSize !== undefined ? { shortlistSize: input.shortlistSize } : {}) };
      await context.mastra.schedules.update(item.scheduleId, { cron: updated.cron, timezone: updated.timezone, name: updated.name, prompt: mediaRadarSchedulePrompt({ subscriptionId: item.id, ...updated, previouslySurfaced: item.surfaced.map((x) => `${x.title}${x.year ? ` (${x.year})` : ''}`) }) });
      await updateMediaRadarSubscription(item.id, updated);
    }
    const summary = input.action === 'run'
      ? `Started a fresh ${item.name} run. I will send the finished list to this chat when it is ready.`
      : `${input.action} completed for ${item.name}.`;
    return { status: input.action, subscriptionId: item.id, summary };
  },
});

export const recordMediaRadarDeliveryTool = createTool({
  id: 'record-media-radar-delivery', description: 'Record selected radar titles and deliver the complete polished digest to the subscribed channel.',
  inputSchema: z.object({ subscriptionId: z.string().min(1), candidates: z.array(candidateSchema).min(1).max(20), digest: z.string().min(1).max(4096) }),
  outputSchema: z.object({ status: z.string(), summary: z.string() }),
  execute: async (input, context) => {
    return deliveryQueue.run(input.subscriptionId, async () => {
      const item = await getMediaRadarSubscription(input.subscriptionId);
      if (!item || item.resourceId !== context.agent?.resourceId) return { status: 'not-found', summary: 'The recommendation subscription was not found.' };
      if (item.status !== 'active' || item.channel === 'none') return { status: 'not-delivered', summary: 'This subscription is not active for delivery.' };
      const key = (entry: { title: string; year?: number }) => `${entry.title.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim()}|${entry.year || ''}`;
      const seen = new Set(item.surfaced.map(key));
      if (new Set(input.candidates.map(key)).size !== input.candidates.length || input.candidates.some((candidate) => seen.has(key(candidate)))) {
        return { status: 'duplicate', summary: 'This shortlist repeats previously delivered titles. Replace those candidates before delivery.' };
      }
      const checked = await checkMediaStatuses({ titles: input.candidates, requester: item.resourceId });
      if (checked.results.some((candidate) => candidate.status !== 'missing')) {
        return { status: 'ineligible', summary: 'The shortlist includes titles already available, requested, or not verified as missing. Replace or verify those candidates before delivery. Nothing was sent or recorded.' };
      }
      const delivery = await deliverMediaRadar(item.id, input.digest);
      if (!delivery.sent) return { status: 'not-delivered', summary: `The digest was not delivered: ${delivery.reason}. No candidates were marked as sent.` };
      await recordMediaRadarCandidates(item.id, input.candidates);
      return { status: 'recorded', summary: `Recorded ${input.candidates.length} recommendations and delivered the digest.` };
    });
  },
});
