import type { MediaServiceName, ServiceEndpoint } from '../config/gary-config';

type FetchLike = typeof fetch;
type Probe = (endpoint: ServiceEndpoint, fetchFn: FetchLike) => Promise<string>;

async function getJson<T>(fetchFn: FetchLike, url: string, headers?: Record<string, string>): Promise<T> {
  const response = await fetchFn(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json() as T;
}

const arrStatus = (apiVersion: 'v1' | 'v3'): Probe => async ({ url, apiKey }, fetchFn) =>
  (await getJson<{ version?: string }>(fetchFn, `${url}/api/${apiVersion}/system/status`, { 'X-Api-Key': apiKey })).version || 'unknown version';

// Each probe is one or two GET requests that prove the URL answers and the
// credential is accepted, and returns the service version.
export const SERVICE_PROBES: Record<MediaServiceName, Probe> = {
  seerr: async ({ url, apiKey }, fetchFn) => {
    await getJson(fetchFn, `${url}/api/v1/auth/me`, { 'X-Api-Key': apiKey });
    return (await getJson<{ version?: string }>(fetchFn, `${url}/api/v1/status`)).version || 'unknown version';
  },
  sonarr: arrStatus('v3'),
  radarr: arrStatus('v3'),
  prowlarr: arrStatus('v1'),
  plex: async ({ url, apiKey }, fetchFn) =>
    (await getJson<{ MediaContainer?: { version?: string } }>(fetchFn, `${url}/`, { 'X-Plex-Token': apiKey })).MediaContainer?.version || 'unknown version',
  tautulli: async ({ url, apiKey }, fetchFn) => {
    const query = new URLSearchParams({ apikey: apiKey, cmd: 'get_tautulli_info' });
    const body = await getJson<{ response?: { result?: string; message?: string; data?: { tautulli_version?: string } } }>(fetchFn, `${url}/api/v2?${query}`);
    if (body.response?.result !== 'success') throw new Error(body.response?.message || 'request failed');
    return body.response.data?.tautulli_version || 'unknown version';
  },
  sabnzbd: async ({ url, apiKey }, fetchFn) => {
    const query = new URLSearchParams({ mode: 'queue', output: 'json', limit: '0', apikey: apiKey });
    const body = await getJson<{ queue?: { version?: string }; error?: string }>(fetchFn, `${url}/api?${query}`);
    if (!body.queue) throw new Error(body.error || 'no queue in response');
    return body.queue.version || 'unknown version';
  },
};

export function describeProbeError(error: unknown, secret: string) {
  const cause = error instanceof Error && error.cause instanceof Error ? ` (${(error.cause as Error & { code?: string }).code || error.cause.message})` : '';
  const text = `${error instanceof Error ? error.message : String(error)}${cause}`;
  return text.split(secret).join('[redacted]');
}

export async function probeService(name: MediaServiceName, endpoint: ServiceEndpoint, fetchFn: FetchLike = fetch) {
  try {
    return { ok: true as const, version: await SERVICE_PROBES[name](endpoint, fetchFn) };
  } catch (error) {
    return { ok: false as const, error: describeProbeError(error, endpoint.apiKey) };
  }
}
