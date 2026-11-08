import { Agent } from '@mastra/core/agent';
import { fleetProviderOptions, resolveFleetModel } from '../services/fleet-model-policy';

export function createGaryPendingIntentInterpreterAgent(model: string = resolveFleetModel('bounded-classification')) {
  return new Agent({
    id: 'gary-pending-intent-interpreter',
    name: 'Gary Pending Intent Interpreter',
    model,
    defaultOptions: { providerOptions: fleetProviderOptions(model) },
    instructions: `Map a conversational reply onto one supplied pending option, a decline, a title correction (revise), or unclear.
The supplied question and options are authoritative. Copy an option key exactly; never invent or alter an option.
Understand ordinary shorthand, pronouns, number words, typos, qualified consent, and phrases such as "the first two", "all of those", or "yeah do that" from the pending question and immediate reply.
If the user supplies a corrected title or new identifying clue instead of selecting an existing candidate, choose revise. Never force a correction onto the nearest existing option. A bare yes is unclear when the question presents multiple alternatives. Contradictory or uncertain language is unclear.
This interpreter has no tools and cannot approve or execute anything.`,
  });
}

export const garyPendingIntentInterpreterAgent = createGaryPendingIntentInterpreterAgent();
