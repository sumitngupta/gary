import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { toolCaller } from '../channels/gary-channels';
import { issueCode, linkedIdentities } from '../channels/people';

export const manageGaryAccessTool = createTool({
  id: 'manage-gary-access',
  description: 'Invite a new person to Gary (admin only), or give the current user a one-time code that connects another chat app or browser to their own Gary account. The code is shown once; the person sends it to Gary from the chat they want to connect.',
  inputSchema: z.object({
    action: z.enum(['invite', 'link-code', 'list-my-chats']),
    displayName: z.string().trim().min(1).max(80).optional(),
  }),
  outputSchema: z.object({ status: z.string(), summary: z.string(), code: z.string().optional(), expiresAt: z.string().optional(), chats: z.array(z.string()).optional() }),
  execute: async (input, context) => {
    const caller = await toolCaller(context);
    if (caller?.kind !== 'person') return { status: 'denied', summary: 'Only an enrolled person can manage Gary access.' };
    if (input.action === 'list-my-chats') {
      const chats = (await linkedIdentities(caller.person.id)).map((identity) => identity.channel);
      return { status: 'ok', summary: `Connected chats: ${chats.join(', ') || 'none'}.`, chats };
    }
    if (input.action === 'invite') {
      if (!input.displayName) return { status: 'invalid', summary: 'Tell me the name of the person to invite.' };
      const { code, expiresAt } = await issueCode({ kind: 'new-user', displayName: input.displayName, role: 'member' });
      return { status: 'created', summary: `Invite code for ${input.displayName}: ${code}. It works once and expires ${expiresAt}. They send it to Gary from web chat, Telegram or WhatsApp.`, code, expiresAt };
    }
    const { code, expiresAt } = await issueCode({ kind: 'existing-user', userId: caller.person.id }, 1);
    return { status: 'created', summary: `Send ${code} to Gary from the other chat (or enter it on the web sign-in page) within an hour to connect it to your account.`, code, expiresAt };
  },
});
