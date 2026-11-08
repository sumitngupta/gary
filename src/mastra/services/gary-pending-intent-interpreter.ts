import { z } from 'zod';
import { garyPendingIntentInterpreterAgent } from '../agents/gary-pending-intent-interpreter-agent';
import type { PendingIntent } from './gary-operations-store';
import { pendingIntentAllowsSemanticInterpretation } from './gary-pending-intent-policy';

export { pendingIntentAllowsSemanticInterpretation } from './gary-pending-intent-policy';

export const pendingIntentInterpretationSchema = z.object({
  decision: z.enum(['select', 'decline', 'revise', 'unclear']),
  optionKey: z.string().nullable(),
  reason: z.string(),
});

type SemanticAgent = Pick<typeof garyPendingIntentInterpreterAgent, 'generate'>;

export async function interpretRoutinePendingIntent(
  text: string,
  intent: PendingIntent,
  agent: SemanticAgent = garyPendingIntentInterpreterAgent,
) {
  // The model may only select one already-frozen option. Safety comes from the
  // option set and the downstream typed executor, not from requiring every new
  // conversational question to be added to a kind-name allowlist. Sensitive
  // mutations deliberately keep their stricter explicit-confirmation path.
  if (!pendingIntentAllowsSemanticInterpretation(intent)) return { decision: 'unsupported' as const };
  const result = await agent.generate(
    `Pending question: ${JSON.stringify(intent.question)}\nAllowed options: ${JSON.stringify(intent.options.map(({ key, label, aliases }) => ({ key, label, aliases })))}\nUser reply: ${JSON.stringify(text)}`,
    { structuredOutput: { schema: pendingIntentInterpretationSchema } },
  );
  const output = pendingIntentInterpretationSchema.parse(result.object);
  if (output.decision === 'revise' && !/title|media.*(?:match|clarif)|(?:match|clarif).*media/i.test(intent.kind)) {
    return { decision: 'unclear' as const, optionKey: null, reason: 'Only title clarification can be reopened by a correction.' };
  }
  if (output.decision !== 'select') return output;
  return intent.options.some((option) => option.key === output.optionKey)
    ? output
    : { decision: 'unclear' as const, optionKey: null, reason: 'The model returned an option outside the frozen set.' };
}
