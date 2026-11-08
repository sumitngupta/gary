import { registerApiRoute } from '@mastra/core/server';
import { garyAdapter } from '../channels/gary-channels';

// Mastra's generated channel route is POST-only. Meta verifies Cloud API
// subscriptions with a GET challenge on the same path, so bridge that method
// directly to the official adapter while leaving POST delivery to Channels.
export const whatsappGaryVerificationRoute = registerApiRoute(
  '/gary/webhooks/whatsapp',
  {
    method: 'GET',
    requiresAuth: false,
    handler: async (c) => {
      const adapter = garyAdapter('whatsapp');
      if (!adapter) return c.text('WhatsApp is not configured', 503);
      return adapter.handleWebhook(c.req.raw);
    },
  },
);

export const whatsappGaryDeliveryRoute = registerApiRoute(
  '/gary/webhooks/whatsapp',
  {
    method: 'POST',
    requiresAuth: false,
    handler: async (c) => {
      const adapter = garyAdapter('whatsapp');
      if (!adapter) return c.text('WhatsApp is not configured', 503);
      return adapter.handleWebhook(c.req.raw);
    },
  },
);
