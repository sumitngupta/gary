const FOUR_K = /\b(?:4k|2160p)\b/i;
const ATMOS = /\batmos\b/i;
const DOLBY_VISION = /\b(?:dolby\s+vision|dv)\b/i;
const QUALITY_TERM = /\b(?:4k|2160p|1080p|uhd|hdr|atmos|dolby|dv|remux|quality)\b/i;

export function qualityIntentInstruction(text: string) {
  const softWording = /\bnot (?:a )?hard\b/i.test(text)
    || (/\b(?:prefer(?:ence)?|best available|if available)\b/i.test(text) && QUALITY_TERM.test(text));
  if (softWording) {
    return 'Deterministic soft quality preference: preserve the stated preference as request-scoped context; use household-default, never 4k-dv-atmos-hard. Do not claim a profile or search was changed without a successful mutation receipt. Persist a personal preference only if the user explicitly asks to remember it.';
  }
  if (!FOUR_K.test(text) || !ATMOS.test(text)) return undefined;
  if (DOLBY_VISION.test(text)) return 'Deterministic quality constraint: the user explicitly requested 4K, Dolby Vision, and Atmos. Use qualityObjective "4k-dv-atmos-hard".';
  return 'Deterministic quality constraint: the user requested 4K with Atmos but did not request Dolby Vision. Do not use "4k-dv-atmos-hard" and do not add Dolby Vision as a hidden hard requirement. Use household-default and preserve 4K + Atmos as user notes until a dedicated profile is available.';
}
