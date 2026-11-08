import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getGaryHouseholdContext, updateGaryHouseholdContext } from '../services/gary-household-context-store';
import { serverName } from '../config/branding';
import { garyConfig } from '../config/gary-config';

export function isGaryHouseholdContextOwner(resourceId: string) {
  if (resourceId === 'admin-household') return true;
  const actor = resourceId.includes(':') ? resourceId.slice(resourceId.indexOf(':') + 1).replace(/\D/g, '') : resourceId;
  return garyConfig().owners.actors.map((value) => value.replace(/\D/g, '')).filter(Boolean).includes(actor);
}
export const manageGaryHouseholdContextTool = createTool({
  id: 'manage-gary-household-context', description: `Read canonical household recommendation constraints, or let ${serverName()} media owner update explicit viewer ages, shared tastes, boundaries, and the honest intensity-caveat policy.`,
  inputSchema: z.object({ action: z.enum(['get','update']), viewerAges: z.array(z.number().int().min(0).max(120)).max(20).optional(), sharedLikes: z.array(z.string().trim().min(1).max(120)).max(30).optional(), contentBoundaries: z.array(z.string().trim().min(1).max(120)).max(30).optional(), intensityPolicy: z.string().trim().min(10).max(500).optional() }),
  outputSchema: z.object({ status: z.string(), summary: z.string(), context: z.record(z.string(), z.unknown()).optional() }),
  execute: async (input, context) => {
    const resourceId = context.agent?.resourceId; if (!resourceId) return { status: 'service-unavailable', summary: 'Household context is unavailable.' };
    if (input.action === 'get') return isGaryHouseholdContextOwner(resourceId)
      ? { status: 'ok', summary: 'Loaded canonical household recommendation context.', context: await getGaryHouseholdContext() }
      : { status: 'ok', summary: 'Household safety boundaries are applied automatically; private household details are owner-only.' };
    if (!isGaryHouseholdContextOwner(resourceId)) return { status: 'denied', summary: `Only ${serverName()} media owner can change shared household context.` };
    const value = await updateGaryHouseholdContext({ ...(input.viewerAges && { viewerAges: input.viewerAges }), ...(input.sharedLikes && { sharedLikes: input.sharedLikes }), ...(input.contentBoundaries && { contentBoundaries: input.contentBoundaries }), ...(input.intensityPolicy && { intensityPolicy: input.intensityPolicy }) });
    return { status: 'updated', summary: 'Updated canonical household recommendation context.', context: value };
  },
});
