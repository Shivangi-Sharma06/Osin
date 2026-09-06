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
  // New collectors (Tasks 9/11) add their keys here.
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

  // Edges below this confidence % are hidden in the graph by default (Task 6).
  edgeVisibilityThreshold: 40,

  // Every collector is individually togglable + rate-limited via config only.
  collectors: {
    github: {
      enabled: boolEnv('OSIN_COLLECTOR_GITHUB_ENABLED', true),
      requestsPerMinute: numEnv('OSIN_COLLECTOR_GITHUB_RPM', 15),
    },
  } as CollectorsConfig,
};
