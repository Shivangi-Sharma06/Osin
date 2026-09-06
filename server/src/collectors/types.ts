/** Input types the system accepts (explicit tabs in the UI — never auto-detected). */
export type InputType = 'username' | 'name' | 'phone' | 'email' | 'domain';

export type IdentifierType = 'username' | 'name' | 'email' | 'phone' | 'domain';

/** Normalized output matching the `identifiers` table schema. */
export interface IdentifierDraft {
  identifier_type: IdentifierType;
  value: string;
  platform: string;
  url?: string | null;
  metadata?: Record<string, unknown>;
}

/** Normalized evidence matching the `evidence_signals` table schema. */
export interface EvidenceDraft {
  signal_type: string;
  source_platform: string;
  raw_data?: Record<string, unknown>;
}

export interface CollectorInput {
  input_type: InputType;
  input_value: string;
  investigation_id?: string | null;
}

/**
 * A collector NEVER returns raw unscored output to the user — it returns
 * normalized drafts that flow through normalizer → scoring engine →
 * match_clusters. What the UI shows comes exclusively from scored clusters.
 */
export interface CollectorResult {
  collector: string;
  platform: string;
  input_type: InputType;
  input_value: string;
  found: boolean;
  /** Set when found=false (e.g. "unavailable via public/official access"). */
  unavailable_reason?: string;
  identifiers: IdentifierDraft[];
  evidence: EvidenceDraft[];
  duration_ms: number;
}

/** Every collector implements this interface (Task 2; reused in Tasks 9/11). */
export interface Collector {
  /** Platform identifier, e.g. 'github'. */
  platform: string;
  /** Input types this collector can serve. */
  appliesTo: InputType[];
  /** Configured rate limit (requests/minute) — enforced via RateLimiter. */
  rateLimitPerMinute: number;
  /** Config toggle — disabled collectors are never invoked. */
  isEnabled(): boolean;
  fetch(input: CollectorInput): Promise<CollectorResult>;
}

export class RateLimitError extends Error {
  constructor(
    public platform: string,
    public retryAfterSec?: number,
  ) {
    super(`${platform}: rate limit exceeded`);
    this.name = 'RateLimitError';
  }
}
