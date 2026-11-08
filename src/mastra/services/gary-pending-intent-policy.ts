import type { PendingIntent } from './gary-operations-store';

const SENSITIVE_PENDING_KIND = /(?:delete|remove|replace|upgrade|repair|collection|purchase|payment|privacy|profile|email|external[- ]message|supervisor|admin|credential|permission|account)/i;

export function pendingIntentRequiresExplicitText(intent: Pick<PendingIntent, 'kind'>) {
  return SENSITIVE_PENDING_KIND.test(intent.kind);
}

export function pendingIntentAllowsSemanticInterpretation(intent: Pick<PendingIntent, 'kind'>) {
  return !pendingIntentRequiresExplicitText(intent);
}
