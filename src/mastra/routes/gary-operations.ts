import { registerApiRoute } from '@mastra/core/server';
import { dispositionGaryEscalation, getOperationTimeline, listGaryEscalationQueue } from '../services/gary-operations-store';
import { garyConfig } from '../config/gary-config';

function authorized(header?: string) {
  const expected = garyConfig().adminToken;
  return Boolean(expected && header === `Bearer ${expected}`);
}

export const garyEscalationsRoute = registerApiRoute('/gary/escalations', {
  method: 'GET', requiresAuth: false,
  handler: async (c) => authorized(c.req.header('authorization'))
    ? c.json({ ok: true, escalations: await listGaryEscalationQueue({ status: c.req.query('status'), owner: c.req.query('owner'), limit: Number(c.req.query('limit') || 50) }) })
    : c.json({ ok: false, error: 'Unauthorized' }, 401),
});

export const garyEscalationDispositionRoute = registerApiRoute('/gary/escalations/:id', {
  method: 'POST', requiresAuth: false,
  handler: async (c) => {
    if (!authorized(c.req.header('authorization'))) return c.json({ ok: false, error: 'Unauthorized' }, 401);
    const body = await c.req.json() as { status?: string; disposition?: string };
    if (!['acknowledged', 'resolved', 'dismissed', 'retrying'].includes(body.status || '')) return c.json({ ok: false, error: 'Invalid status' }, 400);
    const updated = await dispositionGaryEscalation(c.req.param('id'), { status: body.status as 'acknowledged' | 'resolved' | 'dismissed' | 'retrying', disposition: body.disposition });
    return c.json({ ok: updated });
  },
});

export const garyOperationTimelineRoute = registerApiRoute('/gary/operations/:correlationId', {
  method: 'GET', requiresAuth: false,
  handler: async (c) => authorized(c.req.header('authorization'))
    ? c.json({ ok: true, timeline: await getOperationTimeline(c.req.param('correlationId')) })
    : c.json({ ok: false, error: 'Unauthorized' }, 401),
});
