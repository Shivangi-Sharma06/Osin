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
import { sanitizeCandidateUsername } from './usernameFanout.js';

const NAME_RE = /^[a-zA-Z .'\-]{3,80}$/;

export interface SearchCandidate {
  username: string;
  source_url: string;
  platform_hint: string | null;
}

/** URL patterns that hint at a profile with a usable username handle. */
const PROFILE_PATTERNS: Array<{ hint: string; re: RegExp; group: number }> = [
  { hint: 'github', re: /github\.com\/([A-Za-z0-9-]{1,39})/i, group: 1 },
  { hint: 'gitlab', re: /gitlab\.com\/([A-Za-z0-9_.-]{2,40})/i, group: 1 },
  { hint: 'reddit', re: /reddit\.com\/(?:user|u)\/([A-Za-z0-9_-]{2,40})/i, group: 1 },
  { hint: 'x', re: /(?:twitter|x)\.com\/([A-Za-z0-9_]{1,15})/i, group: 1 },
  { hint: 'mastodon', re: /mastodon\.social\/@([A-Za-z0-9_.-]{2,40})/i, group: 1 },
  { hint: 'devto', re: /dev\.to\/([A-Za-z0-9_.-]{2,40})/i, group: 1 },
  { hint: 'keybase', re: /keybase\.io\/([A-Za-z0-9_.-]{1,40})/i, group: 1 },
  { hint: 'medium', re: /medium\.com\/@([A-Za-z0-9_.-]{2,40})/i, group: 1 },
];

const RESERVED_HANDLES = new Set([
  'about', 'explore', 'home', 'login', 'search', 'settings', 'signup',
  'privacy', 'terms', 'topics', 'features', 'pricing', 'jobs', 'help',
]);

export function extractCandidateUsernames(html: string): SearchCandidate[] {
  const candidates = new Map<string, SearchCandidate>();

  // DuckDuckGo HTML results carry their target in /l/?uddg=<encoded-url>.
  const urls = new Set<string>();
  for (const m of html.matchAll(/uddg=([^&"']+)/g)) {
    try {
      urls.add(decodeURIComponent(m[1] ?? ''));
    } catch {
      // malformed encoding — skip
    }
  }
  for (const m of html.matchAll(/href="(https?:\/\/[^"]+)"/g)) {
    const href = m[1] ?? '';
    if (!href.includes('duckduckgo.com') && !href.includes('duck.co')) urls.add(href);
  }

  for (const url of urls) {
    for (const pattern of PROFILE_PATTERNS) {
      const match = pattern.re.exec(url);
      const raw = match?.[pattern.group];
      if (!raw) continue;
      const username = sanitizeCandidateUsername(raw.toLowerCase());
      if (!username || RESERVED_HANDLES.has(username)) continue;
      if (!candidates.has(username)) {
        candidates.set(username, { username, source_url: url, platform_hint: pattern.hint });
      }
      break; // one pattern per URL
    }
  }
  return [...candidates.values()];
}

/**
 * Search-engine dorking for PERSON NAMES. Per the spec this collector does
 * NOT directly produce results: it extracts candidate username handles from
 * public search results; the pipeline then feeds those candidates into the
 * username fan-out pipeline for real, scored checks.
 */
export class NameSearchCollector implements Collector {
  platform = 'name_search';
  appliesTo: InputType[] = ['name'];
  rateLimitPerMinute = config.collectors.name_search.requestsPerMinute;

  private readonly limiter = new RateLimiter(this.rateLimitPerMinute);
  private readonly fetchImpl: typeof fetch;
  private readonly audit: typeof recordAudit;

  constructor(options: { fetchImpl?: typeof fetch; audit?: typeof recordAudit } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.audit = options.audit ?? recordAudit;
  }

  isEnabled(): boolean {
    return config.collectors.name_search.enabled;
  }

  async fetch(input: CollectorInput): Promise<CollectorResult> {
    const started = Date.now();
    if (!this.appliesTo.includes(input.input_type)) {
      throw new Error(`NameSearchCollector does not apply to input_type=${input.input_type}`);
    }
    const name = input.input_value.trim();
    const base = {
      collector: this.platform,
      platform: this.platform,
      input_type: input.input_type,
      input_value: name,
    };
    if (!NAME_RE.test(name)) {
      return {
        ...base,
        found: false,
        unavailable_reason: 'invalid_name_format',
        identifiers: [],
        evidence: [],
        duration_ms: Date.now() - started,
      };
    }

    const query = `"${name}"`;
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    await this.limiter.acquire();
    let html: string | null = null;
    let status: number | null = null;
    try {
      const res = await this.fetchImpl(url, {
        headers: { 'user-agent': 'osin-scoring-tool/0.1', accept: 'text/html' },
        signal: AbortSignal.timeout(10_000),
      });
      status = res.status;
      await this.audit({
        investigation_id: input.investigation_id ?? null,
        actor: 'collector:name_search',
        action: 'http_request',
        subject: url,
        status_code: res.status,
        details: { duration_ms: Date.now() - started },
      });
      if (res.ok) html = await res.text();
    } catch (err) {
      await this.audit({
        investigation_id: input.investigation_id ?? null,
        actor: 'collector:name_search',
        action: 'http_request',
        subject: url,
        status_code: null,
        details: { error: (err as Error).message, duration_ms: Date.now() - started },
      });
    }

    if (html === null) {
      return {
        ...base,
        found: false,
        unavailable_reason:
          status === 403 || status === 429
            ? 'search engine unavailable (rate limited)'
            : 'search engine unavailable',
        identifiers: [],
        evidence: [],
        duration_ms: Date.now() - started,
      };
    }

    const candidates = extractCandidateUsernames(html).slice(0, 10);
    const identifiers: IdentifierDraft[] = []; // deliberately empty — no direct results
    const evidence: EvidenceDraft[] = [
      {
        signal_type: 'search_engine_candidates',
        source_platform: 'duckduckgo',
        raw_data: { query, candidates },
      },
    ];

    await this.audit({
      investigation_id: input.investigation_id ?? null,
      actor: 'collector:name_search',
      action: 'collector_run',
      subject: name,
      details: { candidates: candidates.length, duration_ms: Date.now() - started },
    });

    return {
      ...base,
      found: candidates.length > 0,
      unavailable_reason:
        candidates.length === 0 ? 'no candidate profiles in public search results' : undefined,
      identifiers,
      evidence,
      duration_ms: Date.now() - started,
    };
  }
}
