import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { createGaryEscalation, getGaryUserProfile, markGaryEscalationDelivered } from '../services/gary-user-profile-store';
import { profileDedupeKey } from './manage-gary-profile-tool';
import { enqueueGaryEscalation, recordGaryEscalationDelivery } from '../services/gary-operations-store';
import { randomUUID } from 'node:crypto';
import { adminName } from '../config/branding';
import { assertMutationAllowed, garyConfig } from '../config/gary-config';

export const escalateToGarySupervisorTool = createTool({
  id: 'escalate-to-gary-supervisor',
  description: 'After the user explicitly agrees, send Gary’s supervisor a bounded summary of an unsupported or repeatedly failing request. Never include a transcript or secrets.',
  inputSchema: z.object({ summary: z.string().trim().min(10).max(500), reason: z.string().trim().min(3).max(240), userConsented: z.literal(true) }),
  outputSchema: z.object({ status: z.string(), summary: z.string(), escalationId: z.number().int().optional() }),
  execute: async (input, context) => {
    const resourceId = context.agent?.resourceId;
    const threadId = context.agent?.threadId;
    const config = garyConfig();
    const supervisor = config.owners.adminWhatsApp;
    if (!resourceId || !threadId || !supervisor) return { status: 'service-unavailable', summary: 'I could not reach my supervisor channel right now.' };
    const profile = await getGaryUserProfile(resourceId);
    const escalation = await createGaryEscalation({ resourceId, requesterName: profile?.preferredName, summary: input.summary, reason: input.reason, dedupeKey: profileDedupeKey(input.summary, input.reason) });
    if (!escalation.created) return escalation.delivered
      ? { status: 'already-open', summary: 'I already passed this request to my supervisor.', escalationId: escalation.id }
      : { status: 'recorded', summary: 'This request is recorded, but delivery to my supervisor has not been confirmed.', escalationId: escalation.id };
    if (!escalation.id) return { status: 'service-unavailable', summary: 'I could not record this request for my supervisor.' };
    const channel = context.requestContext?.get('channel') as { messageId?: string } | undefined;
    const queueId = await enqueueGaryEscalation({ resourceId, threadId, correlationId: channel?.messageId || randomUUID(), owner: adminName(), reason: input.reason, error: { summary: input.summary, legacyEscalationId: escalation.id } });
    const { accessToken: token, phoneNumberId, graphVersion } = config.whatsapp;
    if (!token || !phoneNumberId) {
      await recordGaryEscalationDelivery(queueId, { status: 'unavailable', error: 'WhatsApp supervisor delivery is not configured' });
      return { status: 'recorded', summary: 'I recorded this for my supervisor, but the notification channel is temporarily unavailable.', escalationId: escalation.id };
    }
    assertMutationAllowed('message');
    const requester = profile?.preferredName || resourceId.replace(/^whatsapp:/, 'WhatsApp user ');
    const response = await fetch(`https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: supervisor, type: 'text', text: { preview_url: false, body: `Gary escalation from ${requester}: ${input.summary}\n\nWhy Gary escalated: ${input.reason}\nReference: ${escalation.id}` } }),
    });
    const body = await response.json().catch(() => undefined) as { messages?: Array<{ id?: string }>; error?: { message?: string } } | undefined;
    const messageId = body?.messages?.[0]?.id;
    if (!response.ok || !messageId) {
      await recordGaryEscalationDelivery(queueId, { status: 'failed', error: body?.error?.message || `WhatsApp HTTP ${response.status}` });
      return { status: 'recorded', summary: 'I recorded this for my supervisor, but could not deliver the notification yet.', escalationId: escalation.id };
    }
    await markGaryEscalationDelivered(escalation.id, messageId);
    await recordGaryEscalationDelivery(queueId, { status: 'sent', messageId });
    return { status: 'sent', summary: `I passed that to ${adminName()}.`, escalationId: escalation.id };
  },
});
