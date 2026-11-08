import { serverNamePattern } from '../config/branding';
export type BoundedActionReceipt = {
  toolName: string;
  status?: string;
  requestIdPresent?: boolean;
  available?: boolean;
  summary?: string;
};

export type ActionClaimIssue =
  | 'completion-without-success-receipt'
  | 'created-claim-without-created-receipt'
  | 'sent-claim-without-sent-receipt'
  | 'available-claim-without-availability-receipt'
  | 'failure-receipt-described-as-success';

const completionClaim =
  /(?:^\s*(?:done|completed|finished)\b|(?:\bI(?:'ve| have)?|\bwe(?:'ve| have)?)\s+(?:successfully\s+)?(?:sent|emailed|created|added|updated|removed|deleted|requested|scheduled|deployed|fixed)\b|\b(?:was|has been|is now)\s+(?:successfully\s+)?(?:sent|emailed|created|added|updated|removed|deleted|requested|scheduled|deployed|fixed|completed|finished)\b)/i;
const createdClaim =
  /(?:^\s*Requested\b|(?:\bI(?:'ve| have)?|\bwe(?:'ve| have)?)\s+(?:successfully\s+)?(?:requested|submitted|created)\b|\b(?:was|has been|is now)\s+(?:successfully\s+)?(?:requested|submitted|created)\b)/i;
const sentClaim =
  /(?:\bI(?:'ve| have)?\s+(?:successfully\s+)?(?:sent|emailed)\b|\b(?:email|message)\s+(?:was|has been|is now)\s+(?:successfully\s+)?sent\b)/i;
const availableClaim =
  new RegExp(String.raw`\b(?:it|this|that|the (?:movie|show|title)|[A-Z0-9][\w:'&.,!?-]*(?:\s+(?:[A-Z0-9][\w:'&.,!?-]*|\(\d{4}\))){0,10})\s+(?:is|are)\s+(?:already\s+)?(?:available in ${serverNamePattern()}|ready to watch|watchable(?: in ${serverNamePattern()})?)\b`, 'i');
const availabilityCapability =
  /\b(?:can|could|help|check|tell|notify|watch|when|whether|what)\b/i;
const failureStatuses = new Set(['failed', 'error', 'service-unavailable', 'delivery-unconfirmed', 'partially-completed']);
const successfulStatuses = new Set([
  'created',
  'updated',
  'deleted',
  'sent',
  'completed',
  'succeeded',
  'verified',
  'already-requested',
  'already-available',
]);

export function actionClaimIssues(text: string, receipts: BoundedActionReceipt[]) {
  const issues = new Set<ActionClaimIssue>();
  const hasFailure = receipts.some((receipt) => failureStatuses.has(receipt.status || ''));
  const hasReadyPreview = receipts.some((receipt) =>
    /preview[-A-Za-z]*plex[-A-Za-z]*collection[-A-Za-z]*change/i.test(receipt.toolName)
    && receipt.status === 'ready');
  const hasSuccess = hasReadyPreview
    || receipts.some((receipt) => successfulStatuses.has(receipt.status || ''));
  const hasCreated = receipts.some((receipt) => (
    ['created', 'completed'].includes(receipt.status || '') && (
      (/createMediaRequest(?:Batch)?/i.test(receipt.toolName) && receipt.requestIdPresent === true)
      || /createMediaAvailabilityWatch/i.test(receipt.toolName)
      || /executePlexCollectionChange/i.test(receipt.toolName)
    )) || (
      receipt.status === 'ready'
      && /preview[-A-Za-z]*plex[-A-Za-z]*collection[-A-Za-z]*change/i.test(receipt.toolName)
    ));
  const hasSent = receipts.some((receipt) =>
    /(?:email|message|escalateToGarySupervisor)/i.test(receipt.toolName) && receipt.status === 'sent');
  const hasAvailability = receipts.some((receipt) =>
    receipt.available === true || receipt.status === 'already-available');
  const claimsAvailability = text
    .split(/[.!?\n]+/)
    .some((sentence) => availableClaim.test(sentence) && !availabilityCapability.test(sentence));

  if (completionClaim.test(text) && !hasSuccess) {
    issues.add('completion-without-success-receipt');
  }
  if (createdClaim.test(text) && !hasCreated
    && !receipts.some((receipt) =>
      /createMediaRequest/i.test(receipt.toolName) && receipt.status === 'already-requested')) {
    issues.add('created-claim-without-created-receipt');
  }
  if (sentClaim.test(text) && !hasSent) {
    issues.add('sent-claim-without-sent-receipt');
  }
  if (claimsAvailability && !hasAvailability) {
    issues.add('available-claim-without-availability-receipt');
  }
  if (completionClaim.test(text) && hasFailure && !hasSuccess) {
    issues.add('failure-receipt-described-as-success');
  }
  return [...issues];
}

export function actionClaimGate(input: {
  text: string;
  receipts: BoundedActionReceipt[];
}) {
  const issues = actionClaimIssues(input.text, input.receipts);
  const failureSummary = [...input.receipts].reverse().find((receipt) =>
    failureStatuses.has(receipt.status || '') && receipt.summary?.trim())?.summary?.trim();
  return {
    allowed: issues.length === 0,
    issues,
    fallback: issues.length === 0
      ? undefined
      : failureSummary || 'I could not confirm that action completed. I can check its current status before retrying.',
  };
}
