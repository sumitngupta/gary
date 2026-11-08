import { isGaryWhatsAppActorAuthorized } from './gary-access-policy';
import { assertMutationAllowed, garyConfig } from '../config/gary-config';

export async function sendWhatsAppMediaRadar(resourceId: string, text: string) {
  const to = resourceId.match(/^whatsapp:(\d+)$/)?.[1];
  const { accessToken, phoneNumberId, graphVersion } = garyConfig().whatsapp;
  if (!to || !await isGaryWhatsAppActorAuthorized(to)) throw new Error('WhatsApp radar target is not allowlisted.');
  if (!accessToken || !phoneNumberId) throw new Error('WhatsApp radar delivery is not configured.');
  assertMutationAllowed('message');
  const response = await fetch(`https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body: text } }),
  });
  const body = await response.json().catch(() => undefined) as { messages?: Array<{ id?: string }>; error?: { message?: string } } | undefined;
  if (!response.ok || !body?.messages?.[0]?.id) throw new Error(`WhatsApp radar delivery failed: ${body?.error?.message || `HTTP ${response.status}`}`);
  return body.messages[0].id;
}
