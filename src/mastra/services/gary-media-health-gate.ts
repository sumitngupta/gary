import { readFile } from 'node:fs/promises';
import { readConfiguredXmlTag } from './media-service-config';
import { listSeerrRequests } from './seerr-readonly-client';

export type GaryMediaHealthGate = { healthy: boolean; checks: Record<string, { healthy: boolean; detail: string }> };
export function garyMediaHealthReady(checks: GaryMediaHealthGate['checks']) { return Object.values(checks).every((check) => check.healthy); }

async function reachable(name: string, url: string, headers?: Record<string, string>) {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) });
    return { healthy: response.status < 500, detail: `${name} responded (${response.status})` };
  } catch (error) { return { healthy: false, detail: `${name} unreachable: ${error instanceof Error ? error.message : String(error)}` }; }
}

type FetchLike = typeof fetch;

export async function checkSabnzbdHealth(options: {
  fetchFn?: FetchLike;
  readConfig?: () => Promise<string>;
} = {}) {
  const fetchFn = options.fetchFn || fetch;
  try {
    const configPath = process.env.GARY_SABNZBD_CONFIG;
    if (!options.readConfig && !configPath) return { healthy: false, detail: 'Usenet download queue is not configured' };
    const config = await (options.readConfig || (() => readFile(configPath!, 'utf8')))();
    const apiKey = config.match(/^api_key\s*=\s*(\S+)/m)?.[1]?.replace(/^"|"$/g, '');
    if (!apiKey) return { healthy: false, detail: 'Usenet download queue credentials unavailable' };
    const url = new URL('/api', process.env.GARY_SABNZBD_URL || 'http://sabnzbd:8080');
    url.search = new URLSearchParams({ mode: 'queue', output: 'json', apikey: apiKey }).toString();
    const response = await fetchFn(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return { healthy: false, detail: `Usenet download queue responded (${response.status})` };
    const body = await response.json() as { queue?: { status?: string; paused?: boolean } };
    const queue = body.queue;
    if (!queue || typeof queue.paused !== 'boolean' || typeof queue.status !== 'string') {
      return { healthy: false, detail: 'Usenet download queue returned no valid queue status' };
    }
    if (queue.paused || /paused/i.test(queue.status)) {
      return { healthy: false, detail: 'Usenet download queue is paused' };
    }
    return { healthy: true, detail: `Usenet download queue responded (${queue.status})` };
  } catch {
    // Fetch errors can include the URL and its API key; never surface them.
    return { healthy: false, detail: 'Usenet download queue unavailable' };
  }
}

export async function checkGaryMediaHealthGate(): Promise<GaryMediaHealthGate> {
  const seerr = await listSeerrRequests().then(() => ({ healthy: true, detail: 'request service responded' })).catch((error) => ({ healthy: false, detail: `request service unavailable: ${error instanceof Error ? error.message : String(error)}` }));
  const [sonarrKey, radarrKey, prowlarrKey] = await Promise.all([
    process.env.GARY_SONARR_API_KEY || readConfiguredXmlTag('GARY_SONARR_CONFIG_PATH', 'ApiKey').catch(() => undefined),
    process.env.GARY_RADARR_API_KEY || readConfiguredXmlTag('GARY_RADARR_CONFIG_PATH', 'ApiKey').catch(() => undefined),
    process.env.GARY_PROWLARR_API_KEY || readConfiguredXmlTag('GARY_PROWLARR_CONFIG_PATH', 'ApiKey').catch(() => undefined),
  ]);
  const [sonarr, radarr, sabnzbd, indexers] = await Promise.all([
    reachable('TV automation', 'http://sonarr:8989/ping'),
    reachable('movie automation', 'http://radarr:7878/ping'),
    // Usenet is the primary acquisition lane. An offline torrent fallback
    // must not block healthy Usenet requests.
    checkSabnzbdHealth(),
    prowlarrKey
      ? fetch('http://prowlarr:9696/api/v1/indexer', { headers: { 'X-Api-Key': prowlarrKey }, signal: AbortSignal.timeout(5_000) })
        .then(async (response) => {
          const rows = response.ok ? await response.json() as Array<{ enable?: boolean }> : [];
          const enabled = rows.filter((row) => row.enable !== false).length;
          return { healthy: response.ok && enabled > 0, detail: response.ok ? `${enabled} enabled indexer(s)` : `indexer service responded (${response.status})` };
        }).catch((error) => ({ healthy: false, detail: `indexer service unavailable: ${error instanceof Error ? error.message : String(error)}` }))
      : Promise.resolve({ healthy: false, detail: 'indexer API key unavailable' }),
  ]);
  const checks = { seerr, sonarr: sonarrKey ? sonarr : { healthy: false, detail: 'TV automation API key unavailable' }, radarr: radarrKey ? radarr : { healthy: false, detail: 'movie automation API key unavailable' }, indexers, sabnzbd };
  return { healthy: garyMediaHealthReady(checks), checks };
}
