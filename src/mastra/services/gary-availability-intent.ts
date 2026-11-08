import { serverName } from '../config/branding';
const ACQUISITION = /\b(?:add|request|get|grab|download|find)\b/i;
const COMPLETION_NOTICE = /\b(?:let me know|tell me|notify me|message me|ping me)\b[\s\S]{0,60}\b(?:when|once)\b[\s\S]{0,50}\b(?:done|ready|available|finished|complete|lands?|arrives?)\b/i;
const PLURAL_FOLLOWUP = /\b(?:let me know|tell me|notify me|message me|ping me)\b[\s\S]{0,60}\b(?:when|once)\b[\s\S]{0,30}\b(?:they(?:'re| are)?|them|all)\b[\s\S]{0,30}\b(?:done|ready|available|finished|complete|land|arrive)/i;

export function requestsMediaCompletionNotice(text: string) {
  return (ACQUISITION.test(text) && COMPLETION_NOTICE.test(text)) || PLURAL_FOLLOWUP.test(text);
}

export function availabilityIntentInstruction(text: string) {
  if (!requestsMediaCompletionNotice(text)) return undefined;
  return `Deterministic completion-notification requirement: preserve this intent through web research and title resolution. For a singular request, create a separate availability watch for that exact title. For a plural follow-up referring to a preceding batch (they/them/all), create an availability watch for every title in that batch and do not notify until all requested titles are available in ${serverName()}. Do not collapse a plural request to one fuzzy franchise watch. Do not treat request submission as completion.`;
}
