import { config } from '../config.js';
import { recordAudit } from '../services/audit.js';
import { RateLimiter } from './rateLimiter.js';
import { RateLimitError } from './types.js';
import type {
  Collector,
  CollectorInput,
  CollectorResult,
  EvidenceDraft,
  IdentifierDraft,
  InputType,
} from './types.js';

const GITHUB_USERNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;

export function isValidGithubUsername(value: string): boolean {
  return GITHUB_USERNAME_RE.test(value);
}

/** Minimal shape of GET https://api.github.com/users/{username} that we consume. */
export interface GithubProfile {
  login: string;
  id: number;
  name: string | null;
  bio: string | null;
  company: string | null;
  blog: string | null;
  location: string | null;
  email: string | null;
  twitter_username: string | null;
  public_repos: number;
  followers: number;
  following: number;
  created_at: string;
  updated_at: string;
  avatar_url: string;
  html_url: string;
  type: string;
}

export function extractDomain(blog: string | null): string | null {
  if (!blog) return null;
  const candidate = blog.includes('://') ? blog : `https://${blog}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Pure mapping: GitHub profile → normalized drafts matching the
 * `identifiers` / `evidence_signals` schemas.
 */
export function githubProfileToDrafts(profile: GithubProfile): {
  identifiers: IdentifierDraft[];
  evidence: EvidenceDraft[];
} {
  const identifiers: IdentifierDraft[] = [];
  const evidence: EvidenceDraft[] = [];

  identifiers.push({
    identifier_type: 'username',
    value: profile.login,
    platform: 'github',
    url: profile.html_url,
    metadata: {
      name: profile.name,
      bio: profile.bio,
      company: profile.company,
      location: profile.location,
      avatar_url: profile.avatar_url,
      account_type: profile.type,
      public_repos: profile.public_repos,
      followers: profile.followers,
      following: profile.following,
      account_created_at: profile.created_at,
      account_updated_at: profile.updated_at,
      source: 'profile',
    },
  });

  if (profile.name && profile.name.trim().length > 0) {
    identifiers.push({
      identifier_type: 'name',
      value: profile.name.trim(),
      platform: 'github',
      url: null,
      metadata: { source: 'profile_field' },
    });
  }

  if (profile.twitter_username) {
    identifiers.push({
      identifier_type: 'username',
      value: profile.twitter_username,
      platform: 'x',
      url: `https://x.com/${profile.twitter_username}`,
      metadata: { source: 'github_profile_twitter_field' },
    });
  }

  const domain = extractDomain(profile.blog);
  if (domain) {
    identifiers.push({
      identifier_type: 'domain',
      value: domain,
      platform: 'github',
      url: profile.blog,
      metadata: { source: 'profile_blog_field' },
    });
  }

  evidence.push({
    signal_type: 'platform_profile_exists',
    source_platform: 'github',
    raw_data: {
      login: profile.login,
      github_id: profile.id,
      name: profile.name,
      bio: profile.bio,
      company: profile.company,
      blog: profile.blog,
      location: profile.location,
      twitter_username: profile.twitter_username,
      public_repos: profile.public_repos,
      followers: profile.followers,
      following: profile.following,
      created_at: profile.created_at,
      updated_at: profile.updated_at,
      profile_url: profile.html_url,
    },
  });

  return { identifiers, evidence };
}

export interface GithubCollectorOptions {
  fetchImpl?: typeof fetch;
  audit?: typeof recordAudit;
}

/** Official public GitHub REST API — no auth-wall bypass, ever. */
export class GithubCollector implements Collector {
  platform = 'github';
  appliesTo: InputType[] = ['username'];
  rateLimitPerMinute = config.collectors.github.requestsPerMinute;

  private readonly limiter: RateLimiter;
  private readonly fetchImpl: typeof fetch;
  private readonly audit: typeof recordAudit;

  constructor(options: GithubCollectorOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.audit = options.audit ?? recordAudit;
    this.limiter = new RateLimiter(this.rateLimitPerMinute);
  }

  isEnabled(): boolean {
    return config.collectors.github.enabled;
  }

  async fetch(input: CollectorInput): Promise<CollectorResult> {
    const started = Date.now();
    if (!this.appliesTo.includes(input.input_type)) {
      throw new Error(`GithubCollector does not apply to input_type=${input.input_type}`);
    }
    const username = input.input_value.trim();
    const base = {
      collector: 'github',
      platform: this.platform,
      input_type: input.input_type,
      input_value: username,
    };

    if (!isValidGithubUsername(username)) {
      return {
        ...base,
        found: false,
        unavailable_reason: 'invalid_github_username_format',
        identifiers: [],
        evidence: [],
        duration_ms: Date.now() - started,
      };
    }

    const url = `https://api.github.com/users/${encodeURIComponent(username)}`;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'osin-scoring-tool/0.1',
    };
    if (config.githubToken) headers.Authorization = `Bearer ${config.githubToken}`;

    await this.limiter.acquire();
    const res = await this.fetchImpl(url, { headers });
    const duration_ms = Date.now() - started;

    await this.audit({
      investigation_id: input.investigation_id ?? null,
      actor: 'collector:github',
      action: 'http_request',
      subject: url,
      status_code: res.status,
      details: {
        duration_ms,
        authenticated: Boolean(config.githubToken),
        rate_limit_remaining: res.headers.get('x-ratelimit-remaining'),
      },
    });

    const runAudit = (details: Record<string, unknown>): Promise<void> =>
      this.audit({
        investigation_id: input.investigation_id ?? null,
        actor: 'collector:github',
        action: 'collector_run',
        subject: username,
        status_code: res.status,
        details: { ...details, duration_ms },
      });

    if (res.status === 404) {
      await runAudit({ found: false, reason: 'profile_not_found' });
      return {
        ...base,
        found: false,
        unavailable_reason: 'profile_not_found',
        identifiers: [],
        evidence: [],
        duration_ms,
      };
    }

    if (res.status === 403 || res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after')) || undefined;
      await runAudit({ found: false, reason: 'rate_limited' });
      throw new RateLimitError('github', retryAfter);
    }

    if (!res.ok) {
      await runAudit({ found: false, reason: 'unexpected_status' });
      throw new Error(`GitHub API returned unexpected status ${res.status}`);
    }

    const profile = (await res.json()) as GithubProfile;
    const { identifiers, evidence } = githubProfileToDrafts(profile);
    await runAudit({ found: true, identifiers: identifiers.length, evidence: evidence.length });
    return { ...base, found: true, identifiers, evidence, duration_ms };
  }
}
