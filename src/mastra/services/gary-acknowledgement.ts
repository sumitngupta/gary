const ACKNOWLEDGEMENT_ONLY = /^(?:thanks|thank you|thx|ty|appreciate it|perfect|great|awesome)[!.\s]*$/i;

export function isGaryAcknowledgementOnly(text: string) {
  return ACKNOWLEDGEMENT_ONLY.test(text.trim());
}

