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

const USERNAME_RE = /^[a-zA-Z0-9._-]{2,40}$/;

export function sanitizeCandidateUsername(value: string): string | null {
  const v = value.trim();
  return USERNAME_RE.test(v) ? v : null;
}

interface PlatformSpec {
  platform: string;
  profileUrl: (username: string) => string;
  /** Public, login-free endpoint that reliably distinguishes exists vs not. */
  checkUrl: (username: string) => string;
  /** 'json' inspects parsed body; 'status' relies on HTTP status codes. */
  kind: 'status' | 'json';
  /** For 'json': returns true when the body proves the profile exists. */
  jsonExists?: (body: unknown) => boolean;
  rpm: number;
}

/**
 * Sherlock/WhatsMyName-style fan-out over PUBLIC profile endpoints only.
 * No login walls, no anti-bot evasion: platforms that cannot be checked
 * without bypassing something are not in this list at all.
 */
export const FANOUT_PLATFORMS: PlatformSpec[] = [
  {
    platform: 'gitlab',
    rpm: 10,
    kind: 'json',
    jsonExists: (b) => Array.isArray(b) && b.length > 0,
    profileUrl: (u) => `https://gitlab.com/${u}`,
    checkUrl: (u) => `https://gitlab.com/api/v4/users?username=${encodeURIComponent(u)}`,
  },
  {
    platform: 'reddit',
    rpm: 8,
    kind: 'json',
    jsonExists: (b) => typeof b === 'object' && b !== null && 'data' in b,
    profileUrl: (u) => `https://www.reddit.com/user/${u}`,
    checkUrl: (u) => `https://www.reddit.com/user/${encodeURIComponent(u)}/about.json`,
  },
  {
    platform: 'mastodon',
    rpm: 10,
    kind: 'json',
    jsonExists: (b) => typeof b === 'object' && b !== null && 'id' in b,
    profileUrl: (u) => `https://mastodon.social/@${u}`,
    checkUrl: (u) => `https://mastodon.social/api/v1/accounts/lookup?acct=${encodeURIComponent(u)}`,
  },
  {
    platform: 'devto',
    rpm: 10,
    kind: 'json',
    jsonExists: (b) => typeof b === 'object' && b !== null && ('id' in b || 'username' in b),
    profileUrl: (u) => `https://dev.to/${u}`,
    checkUrl: (u) => `https://dev.to/api/users/by_username?url=${encodeURIComponent(u)}`,
  },
  {
    platform: 'keybase',
    rpm: 10,
    kind: 'status',
    profileUrl: (u) => `https://keybase.io/${u}`,
    checkUrl: (u) => `https://keybase.io/${encodeURIComponent(u)}`,
  },
  {
    platform: 'vimeo',
    rpm: 10,
    kind: 'status',
    profileUrl: (u) => `https://vimeo.com/${u}`,
    checkUrl: (u) => `https://vimeo.com/${encodeURIComponent(u)}`,
  },
];

export interface FanoutOptions {
  fetchImpl?: typeof fetch;
  audit?: typeof recordAudit;
}

interface CheckOutcome {
  platform: string;
  status: 'found' | 'not_found' | 'unavailable';
  profileUrl: string;
  detail?: Record<string, unknown>;
}

export async function checkPlatform(
  spec: PlatformSpec,
  username: string,
  deps: {
    fetchImpl: typeof fetch;
    limiter: RateLimiter;
    audit: typeof recordAudit;
    investigationId: string | null;
  },
): Promise<CheckOutcome> {
  const url = spec.checkUrl(username);
  const profileUrl = spec.profileUrl(username);
  await deps.limiter.acquire();
  const started = Date.now();
  let res: Response;
  try {
    res = await deps.fetchImpl(url, {
      headers: {
        accept: 'application/json, text/html;q=0.8, */*;q=0.5',
        'user-agent': 'osin-scoring-tool/0.1',
      },
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    await deps.audit({
      investigation_id: deps.investigationId,
      actor: 'collector:username_fanout',
      action: 'http_request',
      subject: url,
      status_code: null,
      details: {
        platform: spec.platform,
        error: (err as Error).message,
        duration_ms: Date.now() - started,
      },
    });
    return { platform: spec.platform, status: 'unavailable', profileUrl };
  }

  await deps.audit({
    investigation_id: deps.investigationId,
    actor: 'collector:username_fanout',
    action: 'http_request',
    subject: url,
    status_code: res.status,
    details: { platform: spec.platform, duration_ms: Date.now() - started },
  });

  if (res.status === 404 || res.status === 410) {
    return { platform: spec.platform, status: 'not_found', profileUrl };
  }
  if (res.status === 403 || res.status === 429 || !res.ok) {
    return {
      platform: spec.platform,
      status: 'unavailable',
      profileUrl,
      detail: { status: res.status },
    };
  }

  if (spec.kind === 'status') {
    return { platform: spec.platform, status: 'found', profileUrl };
  }
  try {
    const body: unknown = await res.json();
    if (spec.jsonExists?.(body)) {
      return { platform: spec.platform, status: 'found', profileUrl, detail: { checked: url } };
    }
    return { platform: spec.platform, status: 'not_found', profileUrl };
  } catch {
    return { platform: spec.platform, status: 'unavailable', profileUrl };
  }
}

export class UsernameFanoutCollector implements Collector {
  platform = 'username_fanout';
  appliesTo: InputType[] = ['username'];
  rateLimitPerMinute = config.collectors.username_fanout.requestsPerMinute;

  private readonly limiter = new RateLimiter(this.rateLimitPerMinute);
  private readonly fetchImpl: typeof fetch;
  private readonly audit: typeof recordAudit;

  constructor(options: FanoutOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.audit = options.audit ?? recordAudit;
  }

  isEnabled(): boolean {
    return config.collectors.username_fanout.enabled;
  }

  async fetch(input: CollectorInput): Promise<CollectorResult> {
    const started = Date.now();
    if (!this.appliesTo.includes(input.input_type)) {
      throw new Error(`UsernameFanoutCollector does not apply to input_type=${input.input_type}`);
    }
    const username = sanitizeCandidateUsername(input.input_value);
    const base = {
      collector: this.platform,
      platform: this.platform,
      input_type: input.input_type,
      input_value: input.input_value.trim(),
    };
    if (!username) {
      return {
        ...base,
        found: false,
        unavailable_reason: 'invalid_username_format',
        identifiers: [],
        evidence: [],
        duration_ms: Date.now() - started,
      };
    }

    const identifiers: IdentifierDraft[] = [];
    const evidence: EvidenceDraft[] = [];
    const unavailable: string[] = [];
    let found = false;

    for (const spec of FANOUT_PLATFORMS) {
      const outcome = await checkPlatform(spec, username, {
        fetchImpl: this.fetchImpl,
        limiter: this.limiter,
        audit: this.audit,
        investigationId: input.investigation_id ?? null,
      });
      if (outcome.status === 'found') {
        found = true;
        identifiers.push({
          identifier_type: 'username',
          value: username,
          platform: outcome.platform,
          url: outcome.profileUrl,
          metadata: { source: 'username_fanout' },
        });
        evidence.push({
          signal_type: 'platform_profile_exists',
          source_platform: outcome.platform,
          raw_data: { username, profile_url: outcome.profileUrl, ...(outcome.detail ?? {}) },
        });
      } else if (outcome.status === 'unavailable') {
        unavailable.push(outcome.platform);
      }
    }

    await this.audit({
      investigation_id: input.investigation_id ?? null,
      actor: 'collector:username_fanout',
      action: 'collector_run',
      subject: username,
      details: {
        found,
        platforms_found: identifiers.length,
        unavailable,
        duration_ms: Date.now() - started,
      },
    });

    return {
      ...base,
      found,
      unavailable_reason:
        unavailable.length > 0
          ? `unavailable via public/official access: ${unavailable.join(', ')}`
          : undefined,
      identifiers,
      evidence,
      duration_ms: Date.now() - started,
    };
  }
}
