/**
 * Scoring domain types. The engine is PURE: no DB, no network, no config —
 * input in, ScoreResult out. This keeps it isolated and unit-testable.
 */

export type ScoringInputType = 'username' | 'name' | 'phone' | 'email' | 'domain';

export interface ScoringIdentifier {
  identifier_type: string;
  value: string;
  platform: string;
  metadata?: Record<string, unknown> | null;
}

export interface ScoringEvidence {
  signal_type: string;
  source_platform: string;
  raw_data?: Record<string, unknown> | null;
}

/** One ordered entry of explanation_json (stored in match_clusters.explanation). */
export interface ExplanationEntry {
  signal_type: string;
  /** Signed contribution to the total score (negative = contradicting evidence). */
  points: number;
  human_readable_reason: string;
}

export interface ScoringInput {
  input_type: ScoringInputType;
  input_value: string;
  /** Optional known facts about the search subject (bio, name, ...) to compare against. */
  reference_metadata?: Record<string, unknown> | null;
  identifiers: ScoringIdentifier[];
  evidence: ScoringEvidence[];
}

export interface ScoreResult {
  /** Final confidence percentage, clamped to 0..100, 1 decimal. */
  score: number;
  /** Ordered (most influential first) list of scored signals. */
  explanation_json: ExplanationEntry[];
}
