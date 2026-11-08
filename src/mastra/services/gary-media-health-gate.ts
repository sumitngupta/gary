import { garyConfig, type MediaServiceName, type ServiceEndpoint } from '../config/gary-config';
import { probeService } from './media-service-probes';

type HealthCheck = { healthy: boolean; detail: string };
export type GaryMediaHealthGate = { healthy: boolean; checks: Record<string, HealthCheck> };
export function garyMediaHealthReady(checks: GaryMediaHealthGate['checks']) { return Object.values(checks).every((check) => check.healthy); }

type FetchLike = typeof fetch;

const reachable = (service: MediaServiceName, label: string) => async (endpoint: ServiceEndpoint, fetchFn: FetchLike = fetch): Promise<HealthCheck> => {
  const result = await probeService(service, endpoint, fetchFn);
  return result.ok ? { healthy: true, detail: `${label} responded` } : { healthy: false, detail: `${label} unavailable: ${result.error}` };
};

export async function checkIndexerHealth({ url, apiKey }: ServiceEndpoint, fetchFn: FetchLike = fetch): Promise<HealthCheck> {
  try {
    const response = await fetchFn(`${url}/api/v1/indexer`, { headers: { 'X-Api-Key': apiKey }, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return { healthy: false, detail: `indexer service responded (${response.status})` };
    const enabled = (await response.json() as Array<{ enable?: boolean }>).filter((row) => row.enable !== false).length;
    return { healthy: enabled > 0, detail: `${enabled} enabled indexer(s)` };
  } catch {
    return { healthy: false, detail: 'indexer service unavailable' };
  }
}

export async function checkSabnzbdHealth({ url, apiKey }: ServiceEndpoint, fetchFn: FetchLike = fetch): Promise<HealthCheck> {
  try {
    const query = new URLSearchParams({ mode: 'queue', output: 'json', apikey: apiKey });
    const response = await fetchFn(`${url}/api?${query}`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return { healthy: false, detail: `Usenet download queue responded (${response.status})` };
    const queue = (await response.json() as { queue?: { status?: string; paused?: boolean } }).queue;
    if (!queue || typeof queue.paused !== 'boolean' || typeof queue.status !== 'string') {
      return { healthy: false, detail: 'Usenet download queue returned no valid queue status' };
    }
    if (queue.paused || /paused/i.test(queue.status)) {
      return { healthy: false, detail: 'Usenet download queue is paused' };
    }
    return { healthy: true, detail: `Usenet download queue responded (${queue.status})` };
  } catch {
    return { healthy: false, detail: 'Usenet download queue unavailable' };
  }
}

const GATE_CHECKS: Partial<Record<MediaServiceName, (endpoint: ServiceEndpoint) => Promise<HealthCheck>>> = {
  seerr: reachable('seerr', 'request service'),
  sonarr: reachable('sonarr', 'TV automation'),
  radarr: reachable('radarr', 'movie automation'),
  prowlarr: checkIndexerHealth,
  sabnzbd: checkSabnzbdHealth,
};

export async function checkGaryMediaHealthGate(config = garyConfig()): Promise<GaryMediaHealthGate> {
  const configured = (Object.entries(GATE_CHECKS) as Array<[MediaServiceName, (endpoint: ServiceEndpoint) => Promise<HealthCheck>]>)
    .flatMap(([name, check]) => {
      const endpoint = config.services[name];
      return endpoint ? [[name, check(endpoint)] as const] : [];
    });
  const checks = Object.fromEntries(await Promise.all(configured.map(async ([name, check]) => [name, await check] as const)));
  return { healthy: garyMediaHealthReady(checks), checks };
}
