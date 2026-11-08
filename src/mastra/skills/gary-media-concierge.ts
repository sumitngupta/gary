import { createSkill } from '@mastra/core/skills';
import { serverName } from '../config/branding';

export const garyMediaConciergeSkill = createSkill({
  name: 'gary-media-concierge',
  description:
    `Use for title resolution, recommendations, availability explanations, and single or batch ${serverName()} request planning.`,
  instructions: `# Gary Media Concierge

Use this procedure when resolving titles, recommending media, explaining ${serverName()}
status, or preparing one or more requests.

## Resolve before mutation

1. Preserve title, year, media type, language, country, festival, creator, and
   cast clues supplied by the user.
2. Check ${serverName()} first. If an obscure, misspelled, alternate-language, or
   festival title remains unresolved, perform read-only web research
   automatically. Do not ask the user whether Gary should search the web.
3. Present the smallest useful candidate confirmation only when ambiguity
   remains. Carry the resolved stable metadata identifier into later checks and
   requests instead of resolving the title repeatedly.
4. Never mutate from a fuzzy title or treat a web result as ${serverName()} availability.

## Recommendations

- Ask only for a constraint that materially changes safety or usefulness.
- Use current research for discovery and release claims; preferences personalize
  the search but do not replace it.
- Check the complete bounded shortlist in one ${serverName()}-status call before labeling
  any candidate available, requested, or missing.
- Keep the result conversational and explain why each pick fits.

## Requests

- For one exact missing title, use the single-request path after the read-only
  check.
- For a TV show with 6 or more seasons, never assume the requester wants the
  entire catalog. Call the request tool without a seasons value first so the
  deterministic catalog guard can inspect its size. If it returns
  needs-season-scope, ask naturally whether they want all seasons or want to
  start with seasons 1 and 2. On the follow-up, pass seasons "all" only for an
  explicit all/everything answer; otherwise pass the exact season numbers they
  chose.
- For a collection or franchise, resolve the complete bounded set, check it as
  a batch, and use one durable batch operation. A direct request for the exact
  set, or the user's selection of an exact scope Gary just offered, is already
  authorization: plan it as "explicit-request" and execute it in the same turn.
  Use "preview-required" only for candidates the user has not chosen to request.
  Never require a second “approve” message after “all of them”, “the essential
  five”, or another unambiguous scope selection. Report every title as
  requested, already available/requested, unresolved, or failed.
- Keep large-set responses conversational. Lead with compact counts, name only
  exceptions by default, and do not expose batch IDs, binding rules, or backend
  queue mechanics.
- Requested or processing never means playable. Reserve "available in ${serverName()}"
  for current library evidence.
`,
});
