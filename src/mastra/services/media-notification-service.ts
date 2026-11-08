import { createHash } from 'node:crypto';
import type { MediaAvailabilityWatch } from '../schemas/media-availability-watch';
import { serverName } from '../config/branding';
import { garyConfig } from '../config/gary-config';
import { deliverToAdmins, deliverToUser, type Delivery, type Notice } from '../channels/gary-channels';
import { userIdFromResource } from '../channels/people';

type AvailableWatch = Pick<MediaAvailabilityWatch, 'title' | 'year' | 'seasonNumber'> & Partial<Pick<MediaAvailabilityWatch, 'lastSnapshot'>>;

function completedSeasonCount(watch: AvailableWatch) {
  return watch.seasonNumber === undefined ? watch.lastSnapshot?.tvCompleteness?.seasons.length || 0 : 0;
}

export function mediaAvailableMessage(watch: AvailableWatch) {
  const seasonText = watch.seasonNumber !== undefined ? ` season ${watch.seasonNumber}` : '';
  const yearText = watch.year ? ` (${watch.year})` : '';
  const seasons = completedSeasonCount(watch);
  if (seasons > 1) return `All ${seasons} seasons of ${watch.title}${yearText} are now available in ${serverName()}.`;
  return `${watch.title}${yearText}${seasonText} is now available in ${serverName()}.`;
}

export function mediaAvailableTitle(watch: AvailableWatch) {
  const seasonText = watch.seasonNumber !== undefined ? ` season ${watch.seasonNumber}` : '';
  const yearText = watch.year ? ` (${watch.year})` : '';
  const seasons = completedSeasonCount(watch);
  return `${watch.title}${yearText}${seasons > 1 ? ` (all ${seasons} seasons)` : seasonText}`;
}

export function mediaAvailableBatchMessage(watches: AvailableWatch[]) {
  return `These titles are now available in ${serverName()}:\n${watches.map((watch) => `• ${mediaAvailableTitle(watch)}`).join('\n')}`;
}

export function mediaIssueMessage(
  watch: Pick<MediaAvailabilityWatch, 'title' | 'year' | 'seasonNumber'>,
  issue: string,
) {
  const seasonText = watch.seasonNumber !== undefined ? ` season ${watch.seasonNumber}` : '';
  const yearText = watch.year ? ` (${watch.year})` : '';
  return `${watch.title}${yearText}${seasonText} needs attention in ${serverName()}: ${issue}.`;
}

export function supervisorMediaIssueMessage(
  watch: Pick<MediaAvailabilityWatch, 'title' | 'year' | 'seasonNumber' | 'requester'>,
  issue: string,
) {
  const requester = watch.requester ? ` for ${watch.requester}` : '';
  return `Gary watch${requester}: ${mediaIssueMessage(watch, issue)}`;
}

export async function sendAvailabilityMessage(
  watch: MediaAvailabilityWatch,
  text: string,
  options?: { idempotencyKey?: string; kind?: 'media.available' | 'media.issue'; watches?: MediaAvailabilityWatch[] },
): Promise<Delivery> {
  const userId = userIdFromResource(watch.resourceId);
  if (!userId) return { sent: false, reason: 'The watch does not belong to an enrolled Gary user' };
  const watches = options?.watches || [watch];
  const notice: Notice = options?.kind === 'media.issue'
    ? { kind: 'media.issue', text }
    : { kind: 'media.available', text, titles: watches.map(mediaAvailableTitle) };
  return deliverToUser(userId, notice, {
    prefer: watch.channel === 'none' ? undefined : watch.channel,
    idempotencyKey: options?.idempotencyKey,
    targetIds: watches.map((item) => item.id),
  });
}

export async function sendMediaAvailableNotification(input: MediaAvailabilityWatch | MediaAvailabilityWatch[]): Promise<Delivery> {
  const watches = Array.isArray(input) ? input : [input];
  const watch = watches[0];
  if (!watch) return { sent: false, reason: 'No availability watches to notify' };
  const summary = watches.length > 1 ? mediaAvailableBatchMessage(watches) : mediaAvailableMessage(watch);
  const batchKey = createHash('sha256').update(watches.map((item) => item.id).sort().join('|')).digest('hex').slice(0, 24);
  return await sendAvailabilityMessage(watch, summary, { idempotencyKey: `media.available:${batchKey}`, kind: 'media.available', watches });
}

export async function sendMediaIssueNotification(watch: MediaAvailabilityWatch, issue: string): Promise<Delivery> {
  const cooldownMs = garyConfig().stalledAlertCooldownHours * 3_600_000;
  const bucket = Math.floor(Date.now() / cooldownMs);
  const results = await deliverToAdmins(
    { kind: 'media.issue', text: supervisorMediaIssueMessage(watch, issue) },
    { idempotencyKey: `media.issue:${watch.id}:${issue}:${bucket}` },
  );
  return results.find((result) => result.sent) ?? results[0] ?? { sent: false, reason: 'No admin is enrolled' };
}
