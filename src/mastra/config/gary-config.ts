import { z } from 'zod';

export const MEDIA_SERVICES = {
  seerr: { label: 'Seerr', url: 'SEERR_URL', key: 'SEERR_API_KEY' },
  sonarr: { label: 'Sonarr', url: 'SONARR_URL', key: 'SONARR_API_KEY' },
  radarr: { label: 'Radarr', url: 'RADARR_URL', key: 'RADARR_API_KEY' },
  plex: { label: 'Plex', url: 'PLEX_URL', key: 'PLEX_TOKEN' },
  tautulli: { label: 'Tautulli', url: 'TAUTULLI_URL', key: 'TAUTULLI_API_KEY' },
  prowlarr: { label: 'Prowlarr', url: 'PROWLARR_URL', key: 'PROWLARR_API_KEY' },
  sabnzbd: { label: 'SABnzbd', url: 'SABNZBD_URL', key: 'SABNZBD_API_KEY' },
} as const;

export type MediaServiceName = keyof typeof MEDIA_SERVICES;
export type ServiceEndpoint = { url: string; apiKey: string };

export const DEFAULT_LLM_MODEL = 'openai/gpt-5.6-luna';
const DEFAULT_OPENAI_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';

const text = z.string().optional();
const url = z.url({ protocol: /^https?$/, error: 'must be an http:// or https:// URL' }).optional();
const flag = (fallback: boolean) => z.stringbool().default(fallback);
const count = (fallback: number) => z.coerce.number().int().nonnegative().default(fallback);
const positive = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const csv = z.string().default('').transform((value) => value.split(',').map((item) => item.trim()).filter(Boolean));

const envSchema = z.object({
  GARY_DATA_DIR: z.string().default('./data'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4111),
  GARY_SERVER_NAME: z.string().default('the media server'),
  GARY_ADMIN_NAME: z.string().default('the admin'),
  GARY_PUBLIC_URL: url,
  GARY_ADMIN_TOKEN: text,
  GARY_MEDIA_EVENTS_TOKEN: text,
  GARY_ALLOW_REQUESTS: flag(true),
  GARY_READ_ONLY: flag(false),
  GARY_MEDIA_OWNER_ACTORS: csv,
  GARY_ADMIN_WHATSAPP: text,
  GARY_CONFIRMATION_TTL_MINUTES: positive(15),
  GARY_BATCH_THROTTLE_MS: z.coerce.number().int().min(0).max(10_000).default(500),
  GARY_STALLED_ALERT_COOLDOWN_HOURS: z.coerce.number().positive().default(6),
  GARY_STORAGE_HEALTH_FILE: text,
  GARY_STORAGE_WARNING_PERCENT: z.coerce.number().min(0).max(100).default(85),
  GARY_STORAGE_CRITICAL_PERCENT: z.coerce.number().min(0).max(100).default(92),
  GARY_HARD_QUALITY_RADARR_PROFILE_ID: z.coerce.number().int().positive().optional(),
  GARY_HARD_QUALITY_SONARR_PROFILE_ID: z.coerce.number().int().positive().optional(),

  LLM_MODEL: z.string().default(DEFAULT_LLM_MODEL),
  LLM_API_KEY: text,
  OPENAI_API_KEY: text,
  LLM_BASE_URL: url,
  LLM_TRANSCRIBE_MODEL: text,

  SEERR_URL: url,
  SEERR_API_KEY: text,
  SONARR_URL: url,
  SONARR_API_KEY: text,
  RADARR_URL: url,
  RADARR_API_KEY: text,
  PLEX_URL: url,
  PLEX_TOKEN: text,
  TAUTULLI_URL: url,
  TAUTULLI_API_KEY: text,
  PROWLARR_URL: url,
  PROWLARR_API_KEY: text,
  SABNZBD_URL: url,
  SABNZBD_API_KEY: text,

  GARY_WHATSAPP_ENABLED: flag(false),
  GARY_WHATSAPP_ACCESS_TOKEN: text,
  GARY_WHATSAPP_APP_SECRET: text,
  GARY_WHATSAPP_PHONE_NUMBER_ID: text,
  GARY_WHATSAPP_VERIFY_TOKEN: text,
  GARY_WHATSAPP_GRAPH_VERSION: z.string().default('v25.0'),
  GARY_WHATSAPP_GROUPS_ENABLED: flag(false),
  GARY_WHATSAPP_ALLOWED_USERS: csv,
  GARY_WHATSAPP_MUTATIONS_ENABLED: flag(false),
  GARY_WHATSAPP_WEB_ENABLED: flag(true),
  GARY_WHATSAPP_SCHEDULING_ENABLED: flag(false),
  GARY_WHATSAPP_DAILY_MUTATION_LIMIT: count(10),
  GARY_WHATSAPP_DAILY_LIST_LIMIT: count(100),
  GARY_WHATSAPP_HOURLY_WEB_LIMIT: count(100),
  GARY_WHATSAPP_HOURLY_INBOUND_LIMIT: count(120),
  GARY_WHATSAPP_GLOBAL_CONCURRENCY: positive(3),
  GARY_WHATSAPP_MEDIA_AVAILABLE_TEMPLATE: z.string().default('gary_media_available'),
  GARY_WHATSAPP_MEDIA_BATCH_TEMPLATE: z.string().default('gary_tracked_titles_available'),
  GARY_TELEGRAM_BOT_TOKEN: text,
  SLACK_BOT_TOKEN: text,

  EXA_API_KEY: text,
  BRIGHTDATA_API_TOKEN: text,
  BRIGHTDATA_SERP_ZONE: z.string().default('serp_api1'),
  BRIGHTDATA_WEB_UNLOCKER_ZONE: text,
});

type GaryEnv = z.infer<typeof envSchema>;
const ENV_NAMES = Object.keys(envSchema.shape) as Array<keyof GaryEnv>;

export type ModelSettings = {
  model: string;
  apiKey?: string;
  baseUrl?: string;
  transcribeModel?: string;
};

export type GaryConfig = {
  dataDir: string;
  port: number;
  serverName: string;
  adminName: string;
  publicUrl?: string;
  adminToken?: string;
  mediaEventsToken?: string;
  readOnly: boolean;
  allowRequests: boolean;
  model: ModelSettings;
  services: Partial<Record<MediaServiceName, ServiceEndpoint>>;
  owners: { actors: string[]; adminWhatsApp?: string };
  requests: {
    confirmationTtlMinutes: number;
    batchThrottleMs: number;
    hardQualityProfiles: { movie?: number; tv?: number };
  };
  storage: { healthFile?: string; warningPercent: number; criticalPercent: number };
  stalledAlertCooldownHours: number;
  whatsapp: {
    enabled: boolean;
    accessToken?: string;
    appSecret?: string;
    phoneNumberId?: string;
    verifyToken?: string;
    graphVersion: string;
    groupsEnabled: boolean;
    allowedUsers: string[];
    mutationsEnabled: boolean;
    webEnabled: boolean;
    schedulingEnabled: boolean;
    dailyMutationLimit: number;
    dailyListLimit: number;
    hourlyWebLimit: number;
    hourlyInboundLimit: number;
    globalConcurrency: number;
    templates: { mediaAvailable: string; mediaBatch: string };
  };
  telegramBotToken?: string;
  slackBotToken?: string;
  webLookup: {
    exaApiKey?: string;
    brightData: { apiToken?: string; serpZone: string; webUnlockerZone?: string };
  };
};

export class GaryConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Gary configuration is invalid:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'GaryConfigError';
  }
}

function cleanEnv(env: Record<string, string | undefined>) {
  const cleaned: Record<string, string> = {};
  for (const name of ENV_NAMES) {
    const value = env[name]?.trim();
    if (value) cleaned[name] = value;
  }
  return cleaned;
}

function parseServices(env: GaryEnv, problems: string[]) {
  const services: GaryConfig['services'] = {};
  for (const [name, spec] of Object.entries(MEDIA_SERVICES) as Array<[MediaServiceName, (typeof MEDIA_SERVICES)[MediaServiceName]]>) {
    const url = env[spec.url];
    const apiKey = env[spec.key];
    if (url && apiKey) services[name] = { url: url.replace(/\/+$/, ''), apiKey };
    else if (url) problems.push(`${spec.key} is required when ${spec.url} is set.`);
    else if (apiKey) problems.push(`${spec.url} is required when ${spec.key} is set.`);
  }
  if (!services.seerr && !(services.sonarr && services.radarr)) {
    problems.push('No request backend is configured. Set SEERR_URL and SEERR_API_KEY, or set SONARR_URL, SONARR_API_KEY, RADARR_URL and RADARR_API_KEY.');
  }
  return services;
}

function parseModel(env: GaryEnv, problems: string[]): ModelSettings {
  const apiKey = env.LLM_API_KEY || env.OPENAI_API_KEY;
  if (env.LLM_BASE_URL) {
    return { model: env.LLM_MODEL, apiKey, baseUrl: env.LLM_BASE_URL.replace(/\/+$/, ''), transcribeModel: env.LLM_TRANSCRIBE_MODEL };
  }
  if (!/^[^/\s]+\/\S+$/.test(env.LLM_MODEL)) {
    problems.push(`LLM_MODEL must be a provider/model id such as ${DEFAULT_LLM_MODEL} unless LLM_BASE_URL is set.`);
  }
  if (!apiKey) problems.push('LLM_API_KEY is required (OPENAI_API_KEY is accepted as a fallback) unless LLM_BASE_URL points at an endpoint without auth.');
  const transcribeModel = env.LLM_TRANSCRIBE_MODEL
    || (env.LLM_MODEL.startsWith('openai/') ? DEFAULT_OPENAI_TRANSCRIBE_MODEL : undefined);
  return { model: env.LLM_MODEL, apiKey, transcribeModel };
}

export function parseGaryConfig(rawEnv: Record<string, string | undefined>): GaryConfig {
  const parsed = envSchema.safeParse(cleanEnv(rawEnv));
  if (!parsed.success) {
    throw new GaryConfigError(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`));
  }
  const env = parsed.data;
  const problems: string[] = [];
  const services = parseServices(env, problems);
  const model = parseModel(env, problems);
  if (problems.length) throw new GaryConfigError(problems);

  return {
    dataDir: env.GARY_DATA_DIR,
    port: env.PORT,
    serverName: env.GARY_SERVER_NAME,
    adminName: env.GARY_ADMIN_NAME,
    publicUrl: env.GARY_PUBLIC_URL,
    adminToken: env.GARY_ADMIN_TOKEN,
    mediaEventsToken: env.GARY_MEDIA_EVENTS_TOKEN,
    readOnly: env.GARY_READ_ONLY,
    allowRequests: env.GARY_ALLOW_REQUESTS,
    model,
    services,
    owners: { actors: env.GARY_MEDIA_OWNER_ACTORS, adminWhatsApp: env.GARY_ADMIN_WHATSAPP?.replace(/\D/g, '') || undefined },
    requests: {
      confirmationTtlMinutes: env.GARY_CONFIRMATION_TTL_MINUTES,
      batchThrottleMs: env.GARY_BATCH_THROTTLE_MS,
      hardQualityProfiles: { movie: env.GARY_HARD_QUALITY_RADARR_PROFILE_ID, tv: env.GARY_HARD_QUALITY_SONARR_PROFILE_ID },
    },
    storage: {
      healthFile: env.GARY_STORAGE_HEALTH_FILE,
      warningPercent: env.GARY_STORAGE_WARNING_PERCENT,
      criticalPercent: env.GARY_STORAGE_CRITICAL_PERCENT,
    },
    stalledAlertCooldownHours: env.GARY_STALLED_ALERT_COOLDOWN_HOURS,
    whatsapp: {
      enabled: env.GARY_WHATSAPP_ENABLED,
      accessToken: env.GARY_WHATSAPP_ACCESS_TOKEN,
      appSecret: env.GARY_WHATSAPP_APP_SECRET,
      phoneNumberId: env.GARY_WHATSAPP_PHONE_NUMBER_ID,
      verifyToken: env.GARY_WHATSAPP_VERIFY_TOKEN,
      graphVersion: env.GARY_WHATSAPP_GRAPH_VERSION,
      groupsEnabled: env.GARY_WHATSAPP_GROUPS_ENABLED,
      allowedUsers: env.GARY_WHATSAPP_ALLOWED_USERS,
      mutationsEnabled: env.GARY_WHATSAPP_MUTATIONS_ENABLED,
      webEnabled: env.GARY_WHATSAPP_WEB_ENABLED,
      schedulingEnabled: env.GARY_WHATSAPP_SCHEDULING_ENABLED,
      dailyMutationLimit: env.GARY_WHATSAPP_DAILY_MUTATION_LIMIT,
      dailyListLimit: env.GARY_WHATSAPP_DAILY_LIST_LIMIT,
      hourlyWebLimit: env.GARY_WHATSAPP_HOURLY_WEB_LIMIT,
      hourlyInboundLimit: env.GARY_WHATSAPP_HOURLY_INBOUND_LIMIT,
      globalConcurrency: env.GARY_WHATSAPP_GLOBAL_CONCURRENCY,
      templates: { mediaAvailable: env.GARY_WHATSAPP_MEDIA_AVAILABLE_TEMPLATE, mediaBatch: env.GARY_WHATSAPP_MEDIA_BATCH_TEMPLATE },
    },
    telegramBotToken: env.GARY_TELEGRAM_BOT_TOKEN,
    slackBotToken: env.SLACK_BOT_TOKEN,
    webLookup: {
      exaApiKey: env.EXA_API_KEY,
      brightData: { apiToken: env.BRIGHTDATA_API_TOKEN, serpZone: env.BRIGHTDATA_SERP_ZONE, webUnlockerZone: env.BRIGHTDATA_WEB_UNLOCKER_ZONE },
    },
  };
}

let cached: { fingerprint: string; config: GaryConfig } | undefined;

// The environment is fixed in a running server, so this parses once. Tests
// rewrite process.env between cases; the fingerprint picks those changes up.
export function garyConfig(): GaryConfig {
  const fingerprint = ENV_NAMES.map((name) => process.env[name] ?? '\u0001').join('\u0000');
  if (cached?.fingerprint !== fingerprint) cached = { fingerprint, config: parseGaryConfig(process.env) };
  return cached.config;
}

export class ServiceNotConfiguredError extends Error {
  constructor(service: MediaServiceName) {
    const spec = MEDIA_SERVICES[service];
    super(`${spec.label} is not configured on this server. Set ${spec.url} and ${spec.key} to enable it.`);
    this.name = 'ServiceNotConfiguredError';
  }
}

export function requireService(service: MediaServiceName, config = garyConfig()): ServiceEndpoint {
  const endpoint = config.services[service];
  if (!endpoint) throw new ServiceNotConfiguredError(service);
  return endpoint;
}

export type GaryMutation = 'request' | 'change' | 'message';

const REFUSED_ACTION: Record<GaryMutation, string> = {
  request: 'submit that request',
  change: 'change anything on the media server',
  message: 'send that message',
};

export function assertMutationAllowed(kind: GaryMutation, config = garyConfig()) {
  if (config.readOnly) {
    throw new Error(`Gary is running in read-only mode (GARY_READ_ONLY=true), so I did not ${REFUSED_ACTION[kind]}.`);
  }
  if (kind === 'request' && !config.allowRequests) {
    throw new Error('New media requests are turned off on this server (GARY_ALLOW_REQUESTS=false), so I did not submit that request.');
  }
}

export function mediaOwnerActors(config = garyConfig()) {
  const actors = new Set(config.owners.actors);
  if (config.owners.adminWhatsApp) actors.add(`whatsapp:${config.owners.adminWhatsApp}`);
  actors.add('admin-household');
  return actors;
}

export function hardQualityProfileId(mediaType: 'movie' | 'tv', config = garyConfig()) {
  const id = config.requests.hardQualityProfiles[mediaType];
  if (id === undefined) {
    const name = mediaType === 'movie' ? 'GARY_HARD_QUALITY_RADARR_PROFILE_ID' : 'GARY_HARD_QUALITY_SONARR_PROFILE_ID';
    throw new Error(`The hard 4K quality profile is not configured on this server. Set ${name} to enable it.`);
  }
  return id;
}
