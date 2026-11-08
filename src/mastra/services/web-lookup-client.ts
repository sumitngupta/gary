import {
  type WebFetchOutput,
  type WebSearchOutput,
  type WebFetchedPage,
  type WebSearchResult,
} from '../schemas/web-lookup';
import { garyConfig } from '../config/gary-config';

const EXA_SEARCH_URL = 'https://api.exa.ai/search';
const EXA_CONTENTS_URL = 'https://api.exa.ai/contents';
const BRIGHTDATA_REQUEST_URL = 'https://api.brightdata.com/request';

const DEFAULT_SEARCH_RESULTS = 5;
const MAX_SEARCH_RESULTS = 10;
const DEFAULT_TEXT_CHARACTERS = 12000;
const MAX_TEXT_CHARACTERS = 20000;

export type WebSearchRequest = {
  query: string;
  maxResults?: number;
  searchType?: 'auto' | 'fast' | 'instant' | 'deep-lite' | 'deep' | 'deep-reasoning';
  includeDomains?: string[];
  excludeDomains?: string[];
  useBrightDataFallback?: boolean;
};

export type WebFetchRequest = {
  url: string;
  query?: string;
  contentMode?: 'highlights' | 'text';
  maxCharacters?: number;
  useBrightDataFallback?: boolean;
};

type ExaSearchResult = {
  title?: string | null;
  url?: string | null;
  publishedDate?: string | null;
  author?: string | null;
  highlights?: string[] | null;
  highlightScores?: number[] | null;
  text?: string | null;
  summary?: string | null;
  score?: number | null;
};

type ExaSearchResponse = {
  results?: ExaSearchResult[];
  costDollars?: {
    total?: number;
  };
};

type BrightDataOrganicResult = {
  title?: string;
  link?: string;
  url?: string;
  description?: string;
  rank?: number;
  global_rank?: number;
};

function clampInteger(value: number | undefined, fallback: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.floor(value as number)));
}

function exaApiKey() {
  return garyConfig().webLookup.exaApiKey;
}

function brightDataConfig() {
  return garyConfig().webLookup.brightData;
}

function isHttpUrl(value: unknown) {
  if (typeof value !== 'string' || !value) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function warningFrom(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function readJsonResponse<T>(response: Response, label: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${warningFrom(error)}`);
  }
}

function mapExaSearchResults(results: ExaSearchResult[] | undefined, maxResults: number): WebSearchResult[] {
  return (results || [])
    .slice(0, maxResults)
    .flatMap((result, index) => {
      const resultUrl = result.url;
      if (!resultUrl || !isHttpUrl(resultUrl) || !result.title) {
        return [];
      }

      const snippet = result.summary || result.text?.slice(0, 500) || result.highlights?.[0];
      return [{
        title: result.title,
        url: resultUrl,
        ...(snippet ? { snippet } : {}),
        highlights: result.highlights ?? [],
        ...(result.publishedDate ? { publishedDate: result.publishedDate } : {}),
        ...(result.author ? { author: result.author } : {}),
        rank: index + 1,
        ...(typeof result.score === 'number'
          ? { score: result.score }
          : typeof result.highlightScores?.[0] === 'number'
            ? { score: result.highlightScores[0] }
            : {}),
        provider: 'exa' as const,
      }];
    });
}

async function searchExa(request: WebSearchRequest, maxResults: number) {
  const apiKey = exaApiKey();
  if (!apiKey) {
    throw new Error('EXA_API_KEY is not configured.');
  }

  const body: Record<string, unknown> = {
    query: request.query,
    type: request.searchType || 'auto',
    numResults: maxResults,
    userLocation: 'US',
    contents: {
      highlights: true,
    },
  };

  if (request.includeDomains?.length) {
    body.includeDomains = request.includeDomains;
  }

  if (request.excludeDomains?.length) {
    body.excludeDomains = request.excludeDomains;
  }

  const response = await fetch(EXA_SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  const payload = await readJsonResponse<ExaSearchResponse>(response, 'Exa search');
  return {
    results: mapExaSearchResults(payload.results, maxResults),
    costDollars: payload.costDollars?.total,
  };
}

function parseBrightDataBody(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  const body = (payload as { body?: unknown }).body;
  if (typeof body !== 'string') {
    return body;
  }

  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function normalizeBrightDataLink(link: string | undefined) {
  if (!link) {
    return undefined;
  }

  if (isHttpUrl(link)) {
    return link;
  }

  if (link.startsWith('/url?') || link.startsWith('/search?')) {
    try {
      const parsed = new URL(link, 'https://www.google.com');
      const direct = parsed.searchParams.get('q') || parsed.searchParams.get('url');
      return isHttpUrl(direct || undefined) ? direct || undefined : undefined;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function mapBrightDataSearchResults(body: unknown, maxResults: number): WebSearchResult[] {
  if (!body || typeof body !== 'object') {
    return [];
  }

  const record = body as {
    organic?: BrightDataOrganicResult[];
    organic_results?: BrightDataOrganicResult[];
    results?: BrightDataOrganicResult[];
  };
  const organic = record.organic || record.organic_results || record.results || [];

  return organic.flatMap((result, index) => {
    const url = normalizeBrightDataLink(result.link || result.url);
    if (!url || !result.title) {
      return [];
    }

    return [{
      title: result.title,
      url,
      snippet: result.description,
      highlights: result.description ? [result.description] : [],
      rank: result.rank || result.global_rank || index + 1,
      provider: 'brightdata' as const,
    }];
  }).slice(0, maxResults);
}

async function searchBrightData(request: WebSearchRequest, maxResults: number) {
  const { apiToken, serpZone } = brightDataConfig();
  if (!apiToken) {
    throw new Error('BRIGHTDATA_API_TOKEN is not configured.');
  }

  const url = new URL('https://www.google.com/search');
  url.searchParams.set('q', request.query);

  const tryDataFormat = async (dataFormat: 'parsed_light' | 'parsed') => {
    const response = await fetch(BRIGHTDATA_REQUEST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({
        zone: serpZone,
        url: url.toString(),
        format: 'json',
        data_format: dataFormat,
      }),
    });

    const payload = await readJsonResponse<unknown>(response, 'Bright Data SERP');
    const body = parseBrightDataBody(payload);
    return mapBrightDataSearchResults(body, maxResults);
  };

  const lightResults = await tryDataFormat('parsed_light');
  if (lightResults.length > 0) {
    return lightResults;
  }

  return tryDataFormat('parsed');
}

function missingSearchConfig() {
  const { apiToken } = brightDataConfig();
  return !exaApiKey() && !apiToken;
}

export async function searchWeb(request: WebSearchRequest): Promise<WebSearchOutput> {
  const maxResults = clampInteger(request.maxResults, DEFAULT_SEARCH_RESULTS, 1, MAX_SEARCH_RESULTS);
  const warnings: string[] = [];

  if (missingSearchConfig()) {
    return {
      status: 'missing-config',
      query: request.query,
      fallbackUsed: false,
      mutation: false,
      results: [],
      warnings: ['Configure EXA_API_KEY or BRIGHTDATA_API_TOKEN before live web search.'],
      summary: 'Web search is not configured.',
    };
  }

  if (exaApiKey()) {
    try {
      const exa = await searchExa(request, maxResults);
      if (exa.results.length > 0) {
        return {
          status: 'ok',
          query: request.query,
          provider: 'exa',
          fallbackUsed: false,
          mutation: false,
          results: exa.results,
          warnings,
          summary: `Found ${exa.results.length} web result(s) with Exa. No web pages were changed.`,
          costDollars: exa.costDollars,
        };
      }
      warnings.push('Exa search returned no usable results.');
    } catch (error) {
      warnings.push(`Exa search failed: ${warningFrom(error)}`);
    }
  }

  if (request.useBrightDataFallback === false || !brightDataConfig().apiToken) {
    return {
      status: 'error',
      query: request.query,
      fallbackUsed: false,
      mutation: false,
      results: [],
      warnings,
      summary: 'Web search did not return usable results.',
    };
  }

  try {
    const results = await searchBrightData(request, maxResults);
    return {
      status: results.length ? 'ok' : 'error',
      query: request.query,
      provider: 'brightdata',
      fallbackUsed: Boolean(exaApiKey()),
      mutation: false,
      results,
      warnings,
      summary: results.length
        ? `Found ${results.length} web result(s) with Bright Data. No web pages were changed.`
        : 'Bright Data search did not return usable direct links.',
    };
  } catch (error) {
    warnings.push(`Bright Data search failed: ${warningFrom(error)}`);
    return {
      status: 'error',
      query: request.query,
      fallbackUsed: Boolean(exaApiKey()),
      mutation: false,
      results: [],
      warnings,
      summary: 'Web search failed.',
    };
  }
}

function mapExaFetchedPage(result: ExaSearchResult | undefined, url: string): WebFetchedPage | undefined {
  if (!result) {
    return undefined;
  }

  const resultUrl = result.url && isHttpUrl(result.url) ? result.url : url;
  if (!isHttpUrl(resultUrl)) {
    return undefined;
  }

  return {
    url: resultUrl,
    ...(result.title ? { title: result.title } : {}),
    ...(result.text || result.summary ? { content: result.text || result.summary || undefined } : {}),
    highlights: result.highlights ?? [],
    ...(result.publishedDate ? { publishedDate: result.publishedDate } : {}),
    ...(result.author ? { author: result.author } : {}),
    provider: 'exa',
  };
}

async function fetchExa(request: WebFetchRequest) {
  const apiKey = exaApiKey();
  if (!apiKey) {
    throw new Error('EXA_API_KEY is not configured.');
  }

  const contentMode = request.contentMode || 'highlights';
  const body: Record<string, unknown> = {
    urls: [request.url],
  };

  if (contentMode === 'text') {
    body.text = {
      maxCharacters: clampInteger(request.maxCharacters, DEFAULT_TEXT_CHARACTERS, 500, MAX_TEXT_CHARACTERS),
    };
  } else {
    body.highlights = request.query ? { query: request.query } : true;
  }

  const response = await fetch(EXA_CONTENTS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  const payload = await readJsonResponse<ExaSearchResponse>(response, 'Exa contents');
  return {
    page: mapExaFetchedPage(payload.results?.[0], request.url),
    costDollars: payload.costDollars?.total,
  };
}

function htmlToText(html: string) {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function pageTitleFromHtml(html: string) {
  const match = html.match(/<title[^>]*>(.*?)<\/title>/is);
  return match?.[1]?.replace(/\s+/g, ' ').trim();
}

async function fetchBrightData(request: WebFetchRequest): Promise<WebFetchedPage> {
  const { apiToken, webUnlockerZone } = brightDataConfig();
  if (!apiToken) {
    throw new Error('BRIGHTDATA_API_TOKEN is not configured.');
  }
  if (!webUnlockerZone) {
    throw new Error('BRIGHTDATA_WEB_UNLOCKER_ZONE is not configured.');
  }

  const response = await fetch(BRIGHTDATA_REQUEST_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiToken}`,
    },
    body: JSON.stringify({
      zone: webUnlockerZone,
      url: request.url,
      format: 'raw',
    }),
  });

  const html = await response.text();
  if (!response.ok) {
    throw new Error(`Bright Data Web Unlocker failed with HTTP ${response.status}: ${html.slice(0, 300)}`);
  }

  const maxCharacters = clampInteger(request.maxCharacters, DEFAULT_TEXT_CHARACTERS, 500, MAX_TEXT_CHARACTERS);
  const content = htmlToText(html).slice(0, maxCharacters);
  return {
    url: request.url,
    title: pageTitleFromHtml(html),
    content,
    highlights: content ? [content.slice(0, 1000)] : [],
    provider: 'brightdata',
  };
}

function missingFetchConfig() {
  const { apiToken, webUnlockerZone } = brightDataConfig();
  return !exaApiKey() && (!apiToken || !webUnlockerZone);
}

export async function fetchWebPage(request: WebFetchRequest): Promise<WebFetchOutput> {
  const warnings: string[] = [];

  if (missingFetchConfig()) {
    return {
      status: 'missing-config',
      url: request.url,
      fallbackUsed: false,
      mutation: false,
      warnings: ['Configure EXA_API_KEY or Bright Data Web Unlocker before live web fetch.'],
      summary: 'Web fetch is not configured.',
    };
  }

  if (exaApiKey()) {
    try {
      const exa = await fetchExa(request);
      if (exa.page && (exa.page.content || exa.page.highlights.length > 0)) {
        return {
          status: 'ok',
          url: request.url,
          provider: 'exa',
          fallbackUsed: false,
          mutation: false,
          page: exa.page,
          warnings,
          summary: `Fetched ${exa.page.url} with Exa. No web pages were changed.`,
          costDollars: exa.costDollars,
        };
      }
      warnings.push('Exa contents returned no usable text or highlights.');
    } catch (error) {
      warnings.push(`Exa contents failed: ${warningFrom(error)}`);
    }
  }

  if (request.useBrightDataFallback === false) {
    return {
      status: 'error',
      url: request.url,
      fallbackUsed: false,
      mutation: false,
      warnings,
      summary: 'Web fetch did not return usable page content.',
    };
  }

  try {
    const page = await fetchBrightData(request);
    return {
      status: page.content || page.highlights.length ? 'ok' : 'error',
      url: request.url,
      provider: 'brightdata',
      fallbackUsed: Boolean(exaApiKey()),
      mutation: false,
      page,
      warnings,
      summary: `Fetched ${page.url} with Bright Data Web Unlocker. No web pages were changed.`,
    };
  } catch (error) {
    warnings.push(`Bright Data Web Unlocker failed: ${warningFrom(error)}`);
    return {
      status: 'error',
      url: request.url,
      fallbackUsed: Boolean(exaApiKey()),
      mutation: false,
      warnings,
      summary: 'Web fetch failed.',
    };
  }
}
