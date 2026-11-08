import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { createPendingIntent, getPendingIntent } from '../services/gary-operations-store';

const optionSchema = z.object({
  key: z.string().min(1).max(20),
  label: z.string().min(1).max(200),
  aliases: z.array(z.string().min(1).max(100)).max(10).optional(),
  value: z.json().optional(),
});

export const manageGaryPendingIntentInputSchema = z.object({
  action: z.enum(['record', 'inspect']),
  kind: z.string().min(1).max(80).nullish(),
  question: z.string().min(1).max(2_000).nullish(),
  options: z.array(optionSchema).max(20).nullish(),
  payload: z.record(z.string(), z.json()).optional(),
}).superRefine((input, context) => {
  if (input.action !== 'record') return;
  if (!input.kind) context.addIssue({ code: 'custom', path: ['kind'], message: 'kind is required when recording' });
  if (!input.question) context.addIssue({ code: 'custom', path: ['question'], message: 'question is required when recording' });
  if (!input.options?.length) context.addIssue({ code: 'custom', path: ['options'], message: 'options are required when recording' });
});

export const manageGaryPendingIntentTool = createTool({
  id: 'manage-gary-pending-intent',
  description: 'Durably record or inspect one explicit question awaiting a short WhatsApp answer. Record before asking A/B, yes/no, both, these, or “the rest” questions so the next reply binds to the exact proposal.',
  inputSchema: manageGaryPendingIntentInputSchema,
  outputSchema: z.object({ status: z.enum(['recorded', 'none', 'pending']), intentId: z.string().optional(), summary: z.string() }),
  execute: async (input, context) => {
    const resourceId = context.agent?.resourceId;
    const threadId = context.agent?.threadId;
    if (!resourceId || !threadId) throw new Error('Gary pending intents require a resource and thread');
    if (input.action === 'inspect') {
      const pending = await getPendingIntent(threadId);
      return pending
        ? { status: 'pending' as const, intentId: pending.id, summary: `${pending.question} Options: ${pending.options.map((option) => `${option.key}=${option.label}`).join(', ')}` }
        : { status: 'none' as const, summary: 'No short answer is currently pending.' };
    }
    if (/batch.*request.*approval/i.test(input.kind || '')) {
      const pending = await getPendingIntent(threadId);
      if (pending?.kind === 'batch-request-approval' && typeof pending.payload.batchId === 'string') {
        return {
          status: 'recorded' as const,
          intentId: pending.id,
          summary: 'The batch planner already recorded the exact batch-bound approval. Its pending approval was preserved unchanged.',
        };
      }
      throw new Error('Batch approvals are owned by planMediaRequestBatch and cannot be recorded or replaced through manageGaryPendingIntent');
    }
    const channel = context.requestContext?.get('channel') as { messageId?: string } | undefined;
    const pending = await createPendingIntent({ resourceId, threadId, kind: input.kind!, question: input.question!, options: input.options!, payload: input.payload, correlationId: channel?.messageId });
    return { status: 'recorded' as const, intentId: pending.id, summary: `Recorded the pending question with ${pending.options.length} explicit option(s).` };
  },
});
