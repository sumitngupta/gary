import { registerApiRoute } from '@mastra/core/server';

export const healthzRoute = registerApiRoute('/healthz', {
  method: 'GET',
  requiresAuth: false,
  handler: async (c) => c.json({ ok: true, service: 'gary' }),
});
