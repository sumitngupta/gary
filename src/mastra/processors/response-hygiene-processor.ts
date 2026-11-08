import type {
  OutputProcessor,
  ProcessOutputResultArgs,
  ProcessOutputStepArgs,
} from '@mastra/core/processors';
import {
  actionClaimGate,
  type BoundedActionReceipt,
} from '../services/action-claim-gate';
import { serverName, serverNamePattern } from '../config/branding';

const internalMechanicSentencePatterns = [
  /\s*(?:I(?:[’\x27]ve)?\s+)?(?:also\s+)?(?:added|saved|recorded|stored)\s+(?:this|the|your|that)[^.!?\n]*(?:working[-\s]memory|memory|operating notes|vault)[^.!?\n]*[.!?]?/gi,
  /\s*(?:I(?:[’\x27]ve)?\s+)?(?:added|saved|recorded|stored)\s+[^.!?\n]*(?:so we can pick this up later|for later)[^.!?\n]*[.!?]?/gi,
  /\s*(?:I(?:[’\x27]ve)?\s+)?(?:updated|wrote to)\s+(?:working[-\s]memory|memory|operating notes|the vault|vault working[-\s]memory)[^.!?\n]*[.!?]?/gi,
  /\s*(?:I(?:[’\x27]ve)?\s+)?updated\s+(?:our|my|the)\s+notes[^.!?\n]*[.!?]?/gi,
  /\s*(?:I(?:[’\x27]ve)?\s+)?updated\s+(?:our|my|the)\s+working\s+notes[^.!?\n]*[.!?]?/gi,
  /\s*(?:I(?:[’\x27]ve)?\s+)?(?:added|noted|captured|updated)\s+[^.!?\n]*(?:preference|preferences|our notes|my notes|the notes)[^.!?\n]*[.!?]?/gi,
  /\s*[^.!?\n]*(?:working[-\s]memory|working notes|vault working[-\s]memory|thread id|resource id|tool id|artifact id|artifactId|agentcontroller|mode:\s*(?:research|plan|build|review)|controller state)[^.!?\n]*[.!?]?/gi,
  /\s*[^.!?\n]*(?:thread|resource)\s*:\s*[^.!?\n]+[.!?]?/gi,
  /\s*[^.!?\n]*\bpete-plan-\d+\b[^.!?\n]*[.!?]?/gi,
];

const internalMechanicLinePatterns = [
  /^\s*[-*]\s*(?:Saved|Recorded|Added|Stored|Updated)\s+[^.\n]*(?:memory|operating notes|vault)[^\n]*$/gim,
  /^\s*(?:Notes?|Safeguards?)\s+and\s+[^:\n]*:\s*$/gim,
];

export function sanitizeFriendFacingMediaTerms(text: string) {
  return text
    .replace(/\b(?:Seerr|Overseerr)\b/gi, 'media request system')
    .replace(/\b(?:Plex|Emby)\b/gi, `${serverName()} library`)
    .replace(/\bSonarr\b/gi, `${serverName()} repair system`)
    .replace(/\bRadarr\b/gi, `${serverName()} repair system`)
    .replace(/\bProwlarr\b/gi, `${serverName()} search system`)
    .replace(/\bqBittorrent\b|\bqbit\b/gi, `${serverName()} queue`)
    .replace(/\bTdarr\b/gi, `${serverName()} repair system`)
    .replace(/\bBazarr\b/gi, `${serverName()} subtitle system`)
    .replace(/\bTautulli\b/gi, `${serverName()} viewing history`)
    .replace(/\bMaintainerr\b/gi, `${serverName()} curation`)
    .replace(/\bRecommendarr\b/gi, `${serverName()} recommendations`)
    .replace(/\bAutobrr\b|\bcross[- ]seed\b/gi, `${serverName()} search system`)
    .replace(/\bRecyclarr\b/gi, `${serverName()} quality settings`)
    .replace(/\bTV download\/import system\b/gi, `${serverName()} repair system`)
    .replace(/\bmovie download\/import system\b/gi, `${serverName()} repair system`)
    .replace(/\bdownload\/import system\b/gi, `${serverName()} repair system`)
    .replace(/\bdownload\/import pipeline\b/gi, `${serverName()} repair process`)
    .replace(new RegExp(String.raw`\b${serverNamePattern()} repair system search\b`, 'gi'), `${serverName()} search`)
    .replace(new RegExp(String.raw`\b${serverNamePattern()} repair search\b`, 'gi'), `${serverName()} search`)
    .replace(/\bdownload queue\b/gi, `${serverName()} queue`)
    .replace(/\bTMDb\b|\bTVDb\b|\btmdbId\b|\btvdbId\b/gi, 'title metadata')
    .replace(/\btitle metadata\s+\d+\b/gi, 'the matching title metadata');
}

function allowsTechnicalMediaTerms(text: string) {
  return /\b(?:Diagnostic|Debug|Admin|Technical|Internal|Backend) details?\s*:/i.test(text);
}

function isInvitationDraft(text: string) {
  return new RegExp(String.raw`\b(?:Subject:\s*)?(?:Welcome|Invitation|Invite)\b.{0,80}\b${serverNamePattern()}\b`, 'i').test(text)
    && new RegExp(String.raw`\b(?:Plex|${serverNamePattern()} request page|setup|set up|invite links?|welcome\/invitation email)\b`, 'i').test(text);
}

function scrubUnsupportedMediaFollowups(text: string) {
  return text
    .split('\n')
    .map((line) => {
      if (/\bnotifyWhenAvailable\b/i.test(line) || /\b(?:mark|flag|set)\b.{0,80}\b(?:request|media request)\b.{0,80}\b(?:notify|notification)\b/i.test(line)) {
        return line.replace(
          /.*$/u,
          `- Notification note: availability notifications use a separate ${serverName()} watch, not a media request field.`,
        );
      }

      return line;
    })
    .filter(
      (line) =>
        !/\b(?:buy\/rent|purchase\/rent|buy or rent|rent options|purchase a copy|list buy|list .*rent|region-specific links|region\/store|store options|streaming\/rental|streaming or rental|rental availability|streaming availability)\b/i.test(line)
        && !new RegExp(String.raw`\badd it to ${serverNamePattern()}\b`, 'i').test(line),
    )
    .join('\n');
}

function scrubMediaRequestReceipt(text: string) {
  const isRequestReceipt = /\b(?:Done|Submitted|Requested)\b[\s\S]{0,200}\bmedia request\b/i.test(text)
    || /\bRequested\s+[^\n]+?\(\d{4}\)\.\s*Status:\s*(?:approved|pending approval|processing|completed|submitted)\b/i.test(text)
    || /\bRequest summary\b[\s\S]{0,400}\bRequest status:\s*(?:approved|pending approval|processing|completed)\b/i.test(text);

  if (!isRequestReceipt) {
    return text;
  }

  const titleMatch = text.match(/\bTitle:\s*([^\n]+?)(?:\s+[-—]\s+[^\n]+)?$/im)
    || text.match(/\bRequested\s+([^\n]+?\(\d{4}\))\.\s*Status:/i)
    || text.match(/\b(?:Requested|submitted)[^\n]*?\b([A-Z][^\n]+?\(\d{4}\))/i);
  const statusMatch = text.match(/\bRequest status:\s*([^\n.]+)/i)
    || text.match(/\bStatus:\s*([^\n.]+)/i);
  const title = titleMatch?.[1]?.trim().replace(/\.$/, '') || 'the title';
  const status = statusMatch?.[1]?.trim().replace(/\.$/, '') || 'submitted';

  return [
    `Requested ${title}. Status: ${status}.`,
    `Playback is not confirmed yet; ${serverName()} will show it once it is available.`,
  ].join('\n\n');
}

function normalizeRequestedVersusAvailableWording(text: string) {
  if (!/\b(?:requested|request|approved|processing)\b/i.test(text)) {
    return text;
  }

  return text
    .replace(
      new RegExp(String.raw`\ball\s+(?:requested\s+and\s+)?(?:tucked|added|put)\s+(?:into|in|to)\s+${serverNamePattern()}\b[.!]?`, 'gi'),
      'All of the requests were approved.',
    )
    .replace(
      new RegExp(String.raw`\b(?:tucked|added|put)\s+(?:it|them|the titles?|the movies?|the shows?)\s+(?:into|in|to)\s+${serverNamePattern()}\b[.!]?`, 'gi'),
      `requested through ${serverName()}`,
    );
}

function scrubCasualMediaCommandDetails(text: string) {
  if (allowsTechnicalMediaTerms(text)) {
    return text;
  }

  return text
    .replace(/\s*\([^)]*\b(?:SeriesSearch|SeasonSearch|MoviesSearch|commandId|command id|command status|series id|movie id)\b[^)]*\)/gi, '')
    .replace(new RegExp(String.raw`\b${serverNamePattern()} repair system queued a season search\.\s*`, 'gi'), '')
    .replace(new RegExp(String.raw`\b${serverNamePattern()} repair system queued a fresh search\.\s*`, 'gi'), '')
    .replace(new RegExp(String.raw`\b${serverNamePattern()} search queued a season search\.\s*`, 'gi'), '')
    .replace(/\b(?:SeriesSearch|SeasonSearch|MoviesSearch)\b/gi, 'fresh search')
    .replace(/\bcommandId\s*\d+\b/gi, '')
    .replace(/\bcommand id\s*\d+\b/gi, '')
    .replace(/\bcommand status\s*[:=]?\s*\w+\b/gi, '')
    .replace(/\bseries id\s*[:=]?\s*\d+\b/gi, '')
    .replace(/\bmovie id\s*[:=]?\s*\d+\b/gi, '')
    .replace(/[ \t]{2,}/g, ' ');
}

function scrubUnsupportedTimedRecheck(text: string) {
  return text.replace(
    /\s*Want me to re-check availability in\s*~?\s*\d+\s*[–-]?\s*\d*\s*minutes and report back\?/gi,
    ' Ask me later and I can check it again.',
  );
}

function normalizeAvailabilityWatchWording(text: string) {
  return text
    .split('\n')
    .map((line) => {
      const looksLikeAvailabilityWatch = /\b(?:watch|message (?:you here|this chat)|tell you here)\b/i.test(line);
      if (!looksLikeAvailabilityWatch || new RegExp(String.raw`\b${serverNamePattern()}\b`, 'i').test(line)) {
        return line;
      }

      return line.replace(/\bwhen it becomes available\b/i, `when it becomes available in ${serverName()}`);
    })
    .join('\n');
}

export function markTruncatedGaryResponse(text: string) {
  const trimmed = text.trim();
  if (trimmed.length < 240 || /[.!?…:)\]}'”’]$/.test(trimmed)) return trimmed;
  if (!/\b(?:anything|and|or|but|because|that|the|a|an|to|with|without|if|when)$/i.test(trimmed)) return trimmed;
  return `${trimmed}\n\nMy answer was cut off before it was complete—please ask me to continue.`;
}

function scrubCasualMediaStatusReport(text: string) {
  const hasMediaStatusLeak = /\b(?:media-request|requestId|request\s+\d+|One-line summary|English (?:audio\/subtitles|subtitles\/audio))\b/i.test(text);
  const looksSingleTitleStatus =
    /\b(?:available|streamable|not available|not streamable|already requested|approved\s*\/\s*processing)\b/i.test(text)
    && !/\b1[.)][\s\S]*\b2[.)]/.test(text);

  if (!hasMediaStatusLeak || !looksSingleTitleStatus) {
    return text;
  }

  const titleMatch = text.match(/^\s*(?:Re-check complete:\s*)?(.+?\(\d{4}\))/i)
    || text.match(/\b(?:summary:\s*)?(.+?\(\d{4}\))/i);
  const title = titleMatch?.[1]?.trim();

  if (!title) {
    return text;
  }

  const episodeMatch = text.match(/\b(\d+)\s+episodes?\s+(?:available|are there|imported|files? present)\b/i)
    || text.match(/\b(\d+)\s+episode\s+files?\b/i);
  const episodeText = episodeMatch
    ? ` Looks like ${episodeMatch[1]} episodes are there.`
    : '';

  if (new RegExp(String.raw`\b(?:present and streamable|available to stream|available in (?:your )?${serverNamePattern()} library|streamable in (?:your )?${serverNamePattern()} library)\b`, 'i').test(text)) {
    return `${title} is available in ${serverName()}.${episodeText}`;
  }

  if (/\b(?:not available|not present|not streamable|not watchable|has not been imported|has not landed)\b/i.test(text)
    && /\b(?:already requested|approved(?:\s+and\s+|\s*\/\s*|\s*\/\s*in\s+)progress|requestId|request\s+\d+|media-request)\b/i.test(text)) {
    return `Not yet - ${title} is already requested but has not landed in ${serverName()}. Want me to dig into why it is stalled?`;
  }

  return text;
}

export function scrubInternalMechanics(text: string) {
  let scrubbed = text;

  for (const pattern of internalMechanicSentencePatterns) {
    scrubbed = scrubbed.replace(pattern, '');
  }

  for (const pattern of internalMechanicLinePatterns) {
    scrubbed = scrubbed.replace(pattern, '');
  }

  if (isInvitationDraft(scrubbed)) {
    return scrubbed
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  const scrubbedMediaText = scrubCasualMediaCommandDetails(
    scrubCasualMediaStatusReport(
      normalizeRequestedVersusAvailableWording(
        scrubMediaRequestReceipt(
          normalizeAvailabilityWatchWording(scrubUnsupportedTimedRecheck(scrubUnsupportedMediaFollowups(scrubbed))),
        ),
      ),
    ),
  );

  return markTruncatedGaryResponse((allowsTechnicalMediaTerms(scrubbedMediaText) ? scrubbedMediaText : sanitizeFriendFacingMediaTerms(scrubbedMediaText))
    .replace(new RegExp(String.raw`\bshould be watchable in (?:the )?${serverNamePattern()} library\b`, 'gi'), `is already available in ${serverName()}`))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s*What I just did\s*\n(?=\n|What can be done now)/gim, '')
    .trim();
}

export function enforceCompactGaryResponse(text: string) {
  const normalized = text.trim()
    .replace(/(?:^|\n)[^\n.!?]*(?:Great choice|Excellent choice|Awesome choice|Love that|Absolutely!)[^\n.!?]*[.!?]\s*/gi, '\n')
    .replace(/\n{3,}/g, '\n\n');
  // Concision belongs in generation. Deleting paragraphs, questions or source
  // lines here can hide a pending approval or silently truncate a title list.
  return normalized.trim();
}

function scrubMessageText(message: ProcessOutputResultArgs['messages'][number]) {
  if (message.role !== 'assistant') {
    return message;
  }

  const content = message.content;
  const parts = content.parts.map((part) => {
    if (part.type !== 'text' || typeof part.text !== 'string') {
      return part;
    }

    return {
      ...part,
      text: enforceCompactGaryResponse(scrubInternalMechanics(part.text)),
    };
  });

  return {
    ...message,
    content: {
      ...content,
      content: typeof content.content === 'string'
        ? enforceCompactGaryResponse(scrubInternalMechanics(content.content))
        : content.content,
      parts,
    },
  };
}

function messageText(message: ProcessOutputResultArgs['messages'][number]) {
  return message.content.parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.type === 'text' ? part.text : '')
    .join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function boundedActionReceiptsFromMessages(
  messages: ProcessOutputResultArgs['messages'],
) {
  const receipts: BoundedActionReceipt[] = [];
  for (const message of messages) {
    for (const part of message.content.parts) {
      if (part.type !== 'tool-invocation' || part.toolInvocation.state !== 'result') continue;
      const result = isRecord(part.toolInvocation.result) ? part.toolInvocation.result : {};
      const status = typeof result.status === 'string'
        ? result.status
        : typeof result.outcome === 'string'
          ? result.outcome
          : undefined;
      const resultRows = Array.isArray(result.results)
        ? result.results.filter(isRecord) as Array<Record<string, unknown>>
        : [];
      receipts.push({
        toolName: part.toolInvocation.toolName,
        status,
        ...(typeof result.summary === 'string' && { summary: result.summary.slice(0, 1_000) }),
        requestIdPresent: typeof result.requestId === 'string' || typeof result.requestId === 'number'
          || (resultRows.some((row) => row.status === 'created') && resultRows
            .filter((row) => row.status === 'created')
            .every((row) => typeof row.requestId === 'string' || typeof row.requestId === 'number')),
        available: result.available === true
          || result.streamable === true
          || status === 'available'
          || status === 'already-available'
          || resultRows.some((row) => row.status === 'available'),
      });
    }
  }
  return receipts;
}

export function enforceReceiptBackedActionClaims(
  text: string,
  receipts: BoundedActionReceipt[],
) {
  const result = actionClaimGate({ text, receipts });
  return result.allowed ? text : result.fallback || text;
}

function recommendationEvidenceText(
  text: string,
  userText: string,
  sourceUrls: string[],
) {
  if (!/\b(recommend|recommendation|shows? .*good|what .*watch)\b/i.test(userText)) {
    return text;
  }

  let next = text
    .replace(new RegExp(String.raw`[^.!?\n]*\b(?:${serverNamePattern()} library|household|Plex)[^.!?\n]*\b(?:watched history|watch history|viewing history|what (?:you|we) watched)\b[^.!?\n]*[.!?]?`, 'gi'), '')
    .replace(/\n?[A-D]\)\s*Check (?:public )?streaming platforms?[^.\n]*(?:[.\n]|$)/gi, '\n')
    .replace(/\n?-\s*(?:Or )?I can check (?:public )?streaming platforms?[^.\n]*(?:[.\n]|$)/gi, '\n')
    .replace(new RegExp(String.raw`[^.!?\n]*\b(?:mark|set|add)\b[^.!?\n]*\bfavorites?\b[^.!?\n]*\b${serverNamePattern()}(?: library)?\b[^.!?\n]*[.!?]?`, 'gi'), '')
    .replace(new RegExp(String.raw`\b${serverNamePattern()}\/${serverNamePattern()} library(?: library)?\b`, 'gi'), `${serverName()} library`)
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const asksForViewingHistory = /\b(?:what (?:we(?:'ve| have)|you(?:'ve| have)) (?:already )?watched|viewing history|watch history)\b/i.test(userText);
  const hasViewingSignals = /Canonical recommendation context:[\s\S]*"viewingSignals"\s*:\s*\{/i.test(userText);
  if (asksForViewingHistory && !hasViewingSignals && !/\b(?:viewing|watch) history\b.*\b(?:not verified|not available|unavailable|cannot|can't)\b/i.test(next)) {
    next = `I did not verify viewing history for this response, so I will not make watched/unwatched claims.\n\n${next}`;
  }

  if (!/https?:\/\//i.test(next) && sourceUrls.length > 0) {
    next = `${next}\n\nSources: ${sourceUrls.slice(0, 5).join(' ')}`;
  }

  return next;
}

export function processMessages<T extends ProcessOutputResultArgs['messages']>(messages: T): T {
  return processMessagesWithReceipts(messages);
}

function receiptKey(receipt: BoundedActionReceipt) {
  return `${receipt.toolName}:${receipt.status || ''}:${receipt.requestIdPresent ? 'request' : ''}:${receipt.available ? 'available' : ''}`;
}

function mergeReceipts(...groups: BoundedActionReceipt[][]) {
  return [...new Map(groups.flat().map((receipt) => [receiptKey(receipt), receipt])).values()];
}

export function processMessagesWithReceipts<T extends ProcessOutputResultArgs['messages']>(
  messages: T,
  priorReceipts: BoundedActionReceipt[] = [],
): T {
  const userText = [...messages]
    .reverse()
    .find((message) => message.role === 'user')
    ? messageText([...messages].reverse().find((message) => message.role === 'user')!)
    : '';
  const sourceUrls = Array.from(
    new Set(
      (JSON.stringify(messages).match(/https?:\/\/[^\s"\\]+/g) || [])
        .map((url) => url.replace(/[),.;]+$/, ''))
        .filter((url) => !/auth\.openai\.com|mastra\.ai\/contact/i.test(url)),
    ),
  );
  const actionReceipts = mergeReceipts(priorReceipts, boundedActionReceiptsFromMessages(messages));

  return messages.map((message) => {
    const scrubbed = scrubMessageText(message);
    if (scrubbed.role !== 'assistant') return scrubbed;
    return {
      ...scrubbed,
      content: {
        ...scrubbed.content,
        content: typeof scrubbed.content.content === 'string'
          ? enforceReceiptBackedActionClaims(
              recommendationEvidenceText(scrubbed.content.content, userText, sourceUrls),
              actionReceipts,
            )
          : scrubbed.content.content,
        parts: scrubbed.content.parts.map((part) =>
          part.type === 'text' && typeof part.text === 'string'
            ? {
                ...part,
                text: enforceReceiptBackedActionClaims(
                  recommendationEvidenceText(part.text, userText, sourceUrls),
                  actionReceipts,
                ),
              }
            : part
        ),
      },
    };
  }) as T;
}

export const responseHygieneProcessor: OutputProcessor = {
  id: 'response-hygiene',
  name: 'Response Hygiene',
  description: 'Removes internal memory/thread/tool mechanics from user-facing assistant text.',
  processOutputStep(args: ProcessOutputStepArgs) {
    const prior = Array.isArray(args.state.garyActionReceipts)
      ? args.state.garyActionReceipts as BoundedActionReceipt[]
      : [];
    const receipts = mergeReceipts(prior, boundedActionReceiptsFromMessages(args.messages));
    args.state.garyActionReceipts = receipts;
    return processMessagesWithReceipts(args.messages, receipts);
  },
  processOutputResult(args: ProcessOutputResultArgs) {
    return processMessages(args.messages);
  },
};
