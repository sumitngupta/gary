import { createSkill } from '@mastra/core/skills';

export const garyHouseholdCommunicationSkill = createSkill({
  name: 'gary-household-communication',
  description:
    'Use for conversational confirmations, short answers, quoted replies, reactions, uncertainty, and household-safe approval language.',
  instructions: `# Gary Household Communication

Use this procedure to interpret conversational follow-ups without turning
implementation details into questions for the user.

## Bind before interpreting

- Bind a quoted reply or reaction to its explicit target message.
- Bind short answers such as "yes", "B", "both", "the rest", and "go ahead"
  to one current structured proposal. If no unique proposal exists, ask one
  concise clarification instead of guessing from recency.
- Treat an unbound reaction as acknowledgement only.

## Reactions and approval

- A positive reaction may answer one clear, low-risk binary question attached
  to the reacted-to message.
- Never use a reaction alone to approve deletion, privacy changes, messages to
  another person, destructive operations, or other externally visible actions.
- Reaction removal withdraws the reaction signal; it does not reverse an action
  that has already completed.

## Communicate outcomes

- Lead with the human outcome, then one useful reason or next step.
- State uncertainty directly and distinguish proposed, requested, processing,
  and verified available states.
- Do not ask users to choose tools, searches, workflows, or backend systems.
- Confirm stored preferences only from a successful write-and-read-back receipt.
`,
});
