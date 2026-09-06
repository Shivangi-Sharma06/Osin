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

const USERNAME_RE = /^[a-zA-Z0-9_]{1,15}$/;

export interface OfficialSocialOptions {
  fetchImpl?: typeof fetch;
  audit?: typeof recordAudit;
}

/**
 * Instagram / Facebook / X / LinkedIn access via OFFICIAL APIs or public
 * pages WITHOUT login — and nothing else. Platforms that block anonymous
 * access are reported as "unavailable via public/official access"; there is
 * no bypass logic in this codebase, ever.
 *
 * X uses the official v2 API when X_BEARER_TOKEN is configured.
 * Instagram / Facebook / LinkedIn have no keyless official lookup here, so
 * they always report the explicit unavailability reason.
 */
export class OfficialSocialCollector implements Collector {
  platform = 'official_social';
  appliesTo: InputType[] = ['username'];
  rateLimitPerMinute = config.collectors.official_social.requestsPerMinute;

  private readonly limiter = new RateLimiter(this.rateLimitPerMinute);
  private readonly fetchImpl: typeof fetch;
  private readonly audit: typeof recordAudit;

  constructor(options: OfficialSocialOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.audit = options.audit ?? recordAudit;
  }

  isEnabled(): boolean {
    return config.collectors.official_social.enabled;
  }

  private async checkViaXApi(
    username: string,
    input: CollectorInput,
    started: number,
  ): Promise<{ found: boolean; identifier: IdentifierDraft | null; evidence: EvidenceDraft | null; reason: string | null }> {
    const url = `https://api.x.com/2/users/by/username/${encodeURIComponent(username)}`;
    await this.limiter.acquire();
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { authorization: `Bearer ${config.xBearerToken}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      await this.audit({
        investigation_id: input.investigation_id ?? null,
        actor: 'collector:official_social',
        action: 'http_request',
        subject: url,
        status_code: null,
        details: { error: (err as Error).message, duration_ms: Date.now() - started },
      });
      return { found: false, identifier: null, evidence: null, reason: 'x api request failed' };
    }

    await this.audit({
      investigation_id: input.investigation_id ?? null,
      actor: 'collector:official_social',
      action: 'http_request',
      subject: url,
      status_code: res.status,
      details: { platform: 'x', duration_ms: Date.now() - started },
    });

    if (res.status === 200) {
      const body = (await res.json()) as { data?: { id: string; username: string; name?: string } };
      if (body.data?.username) {
        return {
          found: true,
          identifier: {
            identifier_type: 'username',
            value: body.data.username,
            platform: 'x',
            url: `https://x.com/${body.data.username}`,
            metadata: { name: body.data.name ?? null, source: 'official_x_api' },
          },
          evidence: {
            signal_type: 'platform_profile_exists',
            source_platform: 'x',
            raw_data: { x_id: body.data.id, username: body.data.username, via: 'official_api' },
          },
          reason: null,
        };
      }
      return { found: false, identifier: null, evidence: null, reason: 'not_found' };
    }
    if (res.status === 404) {
      return { found: false, identifier: null, evidence: null, reason: 'not_found' };
    }
    return { found: false, identifier: null, evidence: null, reason: `x api status ${res.status}` };
  }

  async fetch(input: CollectorInput): Promise<CollectorResult> {
    const started = Date.now();
    if (!this.appliesTo.includes(input.input_type)) {
      throw new Error(`OfficialSocialCollector does not apply to input_type=${input.input_type}`);
    }
    const username = input.input_value.trim();
    const base = {
      collector: this.platform,
      platform: this.platform,
      input_type: input.input_type,
      input_value: username,
    };

    const blocked = ['instagram', 'facebook', 'linkedin'];
    const identifiers: IdentifierDraft[] = [];
    const evidence: EvidenceDraft[] = [];
    const notes: string[] = [];

    if (config.xBearerToken && USERNAME_RE.test(username)) {
      const x = await this.checkViaXApi(username.toLowerCase(), input, started);
      if (x.found && x.identifier && x.evidence) {
        identifiers.push(x.identifier);
        evidence.push(x.evidence);
      } else if (x.reason) {
        notes.push(`x: ${x.reason}`);
      }
    } else if (!config.xBearerToken) {
      notes.push('x: official API credentials not configured');
    }

    const unavailableReason = `unavailable via public/official access (${[...blocked, ...(notes.length ? ['x'] : [])].join(', ')})`;

    await this.audit({
      investigation_id: input.investigation_id ?? null,
      actor: 'collector:official_social',
      action: 'collector_run',
      subject: username,
      details: {
        found: identifiers.length > 0,
        unavailable: [...blocked, 'x (unless API key configured)'],
        duration_ms: Date.now() - started,
      },
    });

    return {
      ...base,
      found: identifiers.length > 0,
      unavailable_reason: identifiers.length > 0 ? undefined : unavailableReason,
      identifiers,
      evidence,
      duration_ms: Date.now() - started,
    };
  }
}
