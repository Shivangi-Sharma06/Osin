import crypto from 'node:crypto';
import { config } from '../config.js';
import { recordAudit } from '../services/audit.js';
import { RateLimiter } from './rateLimiter.js';
import type {
  Collector,
  CollectorInput,
  CollectorResult,
  EvidenceDraft,
  IdentifierDraft,
  InputType,
} from './types.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function gravatarHash(email: string): string {
  return crypto.createHash('md5').update(email.trim().toLowerCase()).digest('hex');
}

interface GravatarProfile {
  entry?: Array<{
    hash?: string;
    displayName?: string;
    preferredUsername?: string;
    thumbnailUrl?: string;
    urls?: Array<{ value?: string; title?: string }>;
  }>;
}

/**
 * Holehe-style email existence checks over PUBLIC endpoints only:
 * - Gravatar public profile API (md5 of the address — no login, no bypass)
 * - GitHub public search API for accounts with that email attached publicly
 * No forgot-password abuse loops; blocked endpoints are reported, not bypassed.
 */
export class EmailCollector implements Collector {
  platform = 'email';
  appliesTo: InputType[] = ['email'];
  rateLimitPerMinute = config.collectors.email.requestsPerMinute;

  private readonly gravatarLimiter = new RateLimiter(10);
  private readonly githubLimiter = new RateLimiter(8);
  private readonly fetchImpl: typeof fetch;
  private readonly audit: typeof recordAudit;

  constructor(options: { fetchImpl?: typeof fetch; audit?: typeof recordAudit } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.audit = options.audit ?? recordAudit;
  }

  isEnabled(): boolean {
    return config.collectors.email.enabled;
  }

  private async fetchJson(
    url: string,
    headers: Record<string, string>,
    limiter: RateLimiter,
    platform: string,
    investigationId: string | null,
  ): Promise<{ status: number | null; body: unknown | null }> {
    await limiter.acquire();
    const started = Date.now();
    try {
      const res = await this.fetchImpl(url, {
        headers: {
          'user-agent': 'osin-scoring-tool/0.1',
          accept: 'application/json',
          ...headers,
        },
        signal: AbortSignal.timeout(8_000),
      });
      await this.audit({
        investigation_id: investigationId,
        actor: `collector:email:${platform}`,
        action: 'http_request',
        subject: url,
        status_code: res.status,
        details: { duration_ms: Date.now() - started },
      });
      if (!res.ok) return { status: res.status, body: null };
      return { status: res.status, body: await res.json() };
    } catch (err) {
      await this.audit({
        investigation_id: investigationId,
        actor: `collector:email:${platform}`,
        action: 'http_request',
        subject: url,
        status_code: null,
        details: { error: (err as Error).message, duration_ms: Date.now() - started },
      });
      return { status: null, body: null };
    }
  }

  async fetch(input: CollectorInput): Promise<CollectorResult> {
    const started = Date.now();
    if (!this.appliesTo.includes(input.input_type)) {
      throw new Error(`EmailCollector does not apply to input_type=${input.input_type}`);
    }
    const email = input.input_value.trim().toLowerCase();
    const base = {
      collector: this.platform,
      platform: this.platform,
      input_type: input.input_type,
      input_value: email,
    };
    if (!EMAIL_RE.test(email)) {
      return {
        ...base,
        found: false,
        unavailable_reason: 'invalid_email_format',
        identifiers: [],
        evidence: [],
        duration_ms: Date.now() - started,
      };
    }

    const identifiers: IdentifierDraft[] = [];
    const evidence: EvidenceDraft[] = [];
    const invId = input.investigation_id ?? null;

    // 1) Gravatar public profile (only exists when the owner made it public).
    const hash = gravatarHash(email);
    const grav = await this.fetchJson(
      `https://gravatar.com/${hash}.json`,
      {},
      this.gravatarLimiter,
      'gravatar',
      invId,
    );
    if (grav.status === 200) {
      const profile = grav.body as GravatarProfile;
      const entry = profile.entry?.[0];
      if (entry) {
        identifiers.push({
          identifier_type: 'username',
          value: entry.preferredUsername ?? entry.hash ?? hash,
          platform: 'gravatar',
          url: `https://gravatar.com/${hash}`,
          metadata: {
            display_name: entry.displayName ?? null,
            thumbnail_url: entry.thumbnailUrl ?? null,
            source: 'gravatar_profile',
          },
        });
        evidence.push({
          signal_type: 'email_profile_exists',
          source_platform: 'gravatar',
          raw_data: { display_name: entry.displayName ?? null, gravatar_hash: hash },
        });
      }
    }

    // 2) GitHub public search API: accounts that attached this email publicly.
    const gh = await this.fetchJson(
      `https://api.github.com/search/users?q=${encodeURIComponent(`${email} in:email`)}`,
      config.githubToken ? { authorization: `Bearer ${config.githubToken}` } : {},
      this.githubLimiter,
      'github',
      invId,
    );
    if (gh.status === 200) {
      const body = gh.body as {
        total_count?: number;
        items?: Array<{ login: string; html_url: string }>;
      };
      const item = body.items?.[0];
      if (item) {
        identifiers.push({
          identifier_type: 'username',
          value: item.login,
          platform: 'github',
          url: item.html_url,
          metadata: { source: 'github_public_email_search' },
        });
        evidence.push({
          signal_type: 'email_profile_exists',
          source_platform: 'github',
          raw_data: { login: item.login, via: 'public_email_search' },
        });
      }
    }

    await this.audit({
      investigation_id: invId,
      actor: 'collector:email',
      action: 'collector_run',
      subject: email,
      details: {
        found: identifiers.length > 0,
        identifiers: identifiers.length,
        duration_ms: Date.now() - started,
      },
    });

    return {
      ...base,
      found: identifiers.length > 0,
      unavailable_reason:
        identifiers.length > 0 ? undefined : 'no_public_email_profiles_found',
      identifiers,
      evidence,
      duration_ms: Date.now() - started,
    };
  }
}
