import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Minimal .env loader (no dependency): sets process.env for keys not already present. */
function loadDotEnv(file: string = path.join(repoRoot, '.env')): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1] as string;
    let value = m[2] as string;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

function boolEnv(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes'].includes(v.toLowerCase());
}

function numEnv(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export interface CollectorConfig {
  enabled: boolean;
  requestsPerMinute: number;
}

export interface CollectorsConfig {
  github: CollectorConfig;
  username_fanout: CollectorConfig;
  official_social: CollectorConfig;
  email: CollectorConfig;
  phone: CollectorConfig;
  name_search: CollectorConfig;
  domain_dns: CollectorConfig;
  domain_whois: CollectorConfig;
  domain_ct: CollectorConfig;
  domain_tech: CollectorConfig;
  // New collectors add their keys here.
  [key: string]: CollectorConfig;
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  repoRoot,
  port: numEnv('PORT', 4000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://osin@127.0.0.1:5433/osin',
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',

  // Optional credentials (never required for the pipeline to run).
  githubToken: process.env.GITHUB_TOKEN ?? '',
  groqApiKey: process.env.GROQ_API_KEY ?? '',
  groqModel: process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile',
  /** Official X API bearer token (v2). Without it, X is reported as
   * "unavailable via public/official access" — never scraped. */
  xBearerToken: process.env.X_BEARER_TOKEN ?? '',

  // Edges below this confidence % are hidden in the graph by default (Task 6).
  edgeVisibilityThreshold: 40,

  // Every collector is individually togglable + rate-limited via config only.
  collectors: {
    github: {
      enabled: boolEnv('OSIN_COLLECTOR_GITHUB_ENABLED', true),
      requestsPerMinute: numEnv('OSIN_COLLECTOR_GITHUB_RPM', 15),
    },
    username_fanout: {
      enabled: boolEnv('OSIN_COLLECTOR_USERNAME_FANOUT_ENABLED', true),
      requestsPerMinute: numEnv('OSIN_COLLECTOR_USERNAME_FANOUT_RPM', 10),
    },
    official_social: {
      enabled: boolEnv('OSIN_COLLECTOR_OFFICIAL_SOCIAL_ENABLED', true),
      requestsPerMinute: numEnv('OSIN_COLLECTOR_OFFICIAL_SOCIAL_RPM', 10),
    },
    email: {
      enabled: boolEnv('OSIN_COLLECTOR_EMAIL_ENABLED', true),
      requestsPerMinute: numEnv('OSIN_COLLECTOR_EMAIL_RPM', 10),
    },
    phone: {
      enabled: boolEnv('OSIN_COLLECTOR_PHONE_ENABLED', true),
      requestsPerMinute: numEnv('OSIN_COLLECTOR_PHONE_RPM', 20),
    },
    name_search: {
      enabled: boolEnv('OSIN_COLLECTOR_NAME_SEARCH_ENABLED', true),
      requestsPerMinute: numEnv('OSIN_COLLECTOR_NAME_SEARCH_RPM', 10),
    },
    domain_dns: {
      enabled: boolEnv('OSIN_COLLECTOR_DOMAIN_DNS_ENABLED', true),
      requestsPerMinute: numEnv('OSIN_COLLECTOR_DOMAIN_DNS_RPM', 20),
    },
    domain_whois: {
      enabled: boolEnv('OSIN_COLLECTOR_DOMAIN_WHOIS_ENABLED', true),
      requestsPerMinute: numEnv('OSIN_COLLECTOR_DOMAIN_WHOIS_RPM', 10),
    },
    domain_ct: {
      enabled: boolEnv('OSIN_COLLECTOR_DOMAIN_CT_ENABLED', true),
      requestsPerMinute: numEnv('OSIN_COLLECTOR_DOMAIN_CT_RPM', 6),
    },
    domain_tech: {
      enabled: boolEnv('OSIN_COLLECTOR_DOMAIN_TECH_ENABLED', true),
      requestsPerMinute: numEnv('OSIN_COLLECTOR_DOMAIN_TECH_RPM', 10),
    },
  } as CollectorsConfig,
};
