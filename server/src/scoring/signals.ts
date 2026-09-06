import { cosineSimilarity, embedText, normalizeText, normalizedSimilarity } from './textSimilarity.js';
import type { ExplanationEntry, ScoringEvidence } from './types.js';

export interface CandidateRef {
  value: string;
  platform: string;
}

// ---- Weights (single source of truth for signal scoring) ----
export const WEIGHTS = {
  existence: 20,
  phoneValid: 30,
  usernameFull: 40,
  usernameMismatch: -8,
  usernameSimilarityFloor: 0.6,
  bioFull: 30,
  bioPositiveFloor: 0.55,
  bioContradictionCeiling: 0.35,
  bioContradictionPoints: -12,
  bioMinCharsForContradiction: 40,
  nameFull: 10,
  namePartial: 5,
  nameMismatch: -10,
  domainExact: 35,
  domainEvidence: 45,
} as const;

/** Positive base signal: a real public profile/record exists for the searched identifier. */
export function evaluateProfileExistence(evidence: ScoringEvidence[]): ExplanationEntry | null {
  const EXISTENCE_SIGNALS = new Set(['platform_profile_exists', 'email_profile_exists']);
  const platforms = evidence
    .filter((e) => EXISTENCE_SIGNALS.has(e.signal_type))
    .map((e) => e.source_platform);
  const unique = [...new Set(platforms)];
  if (unique.length === 0) return null;
  return {
    signal_type: 'platform_profile_exists',
    points: WEIGHTS.existence,
    human_readable_reason: `Verified public record${unique.length > 1 ? 's' : ''} ${unique.length > 1 ? 'exist' : 'exists'} on ${unique.join(', ')}.`,
  };
}

export function evaluateDomainSignals(
  searched: string,
  candidates: CandidateRef[],
  evidence: ScoringEvidence[],
): ExplanationEntry[] {
  const entries: ExplanationEntry[] = [];
  const normalized = searched.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  const exact = candidates.find((c) => c.value.toLowerCase().replace(/^www\./, '') === normalized);
  if (exact) {
    entries.push({
      signal_type: 'domain_match',
      points: WEIGHTS.domainExact,
      human_readable_reason: `Domain "${exact.value}" was confirmed by ${exact.platform}.`,
    });
  }

  const domainSignals = [
    'domain_dns_records',
    'domain_whois_rdap',
    'domain_certificate_transparency',
    'domain_tech_stack',
  ];
  const seen = evidence.filter((e) => domainSignals.includes(e.signal_type));
  if (seen.length > 0) {
    const platforms = [...new Set(seen.map((e) => e.source_platform))];
    entries.push({
      signal_type: 'domain_public_evidence',
      points: Math.min(WEIGHTS.domainEvidence, platforms.length * 12),
      human_readable_reason: `Public domain evidence was collected from ${platforms.join(', ')}.`,
    });
  }
  return entries;
}

/**
 * Phone normalization signal (Task 9): a valid E.164-normalized number that
 * matches the searched digits supports the match with structured evidence.
 */
export function evaluatePhoneSignal(
  searched: string,
  candidates: Array<{ value: string; platform: string; country: string | null }>,
): ExplanationEntry | null {
  if (!searched.trim() || candidates.length === 0) return null;
  const digits = (s: string): string => s.replace(/[^\d]/g, '');
  const searchedDigits = digits(searched);
  const match = candidates.find((c) => digits(c.value) === searchedDigits);
  if (!match) return null;
  return {
    signal_type: 'phone_normalized_match',
    points: WEIGHTS.phoneValid,
    human_readable_reason: `Phone number is valid and normalized to ${match.value}${match.country ? ` (country: ${match.country})` : ''}.`,
  };
}

/**
 * Username edit-distance signal (Levenshtein + Jaro-Winkler).
 * Strong similarity supports the match; substantial difference is a
 * contradicting signal with negative weight.
 */
export function evaluateUsernameSignal(
  searched: string,
  candidates: CandidateRef[],
): ExplanationEntry | null {
  if (!searched.trim() || candidates.length === 0) return null;

  let best: { sim: number; candidate: CandidateRef } | null = null;
  for (const candidate of candidates) {
    const sim = normalizedSimilarity(normalizeText(searched), normalizeText(candidate.value));
    if (!best || sim > best.sim) best = { sim, candidate };
  }
  if (!best) return null;

  if (best.sim >= 0.999) {
    return {
      signal_type: 'username_match',
      points: WEIGHTS.usernameFull,
      human_readable_reason: `Username "${best.candidate.value}" on ${best.candidate.platform} matches the searched username exactly.`,
    };
  }
  if (best.sim >= WEIGHTS.usernameSimilarityFloor) {
    return {
      signal_type: 'username_similarity',
      points: Math.round(WEIGHTS.usernameFull * best.sim),
      human_readable_reason: `Username "${best.candidate.value}" on ${best.candidate.platform} closely resembles the searched username "${searched}" (similarity ${best.sim.toFixed(2)}).`,
    };
  }
  return {
    signal_type: 'username_mismatch',
    points: WEIGHTS.usernameMismatch,
    human_readable_reason: `Best matching username "${best.candidate.value}" on ${best.candidate.platform} differs substantially from "${searched}" (similarity ${best.sim.toFixed(2)}), which argues against this being the same person.`,
  };
}

/** Name token-overlap signal; disjoint names are a contradicting signal. */
export function evaluateNameSignal(
  referenceName: string | null,
  candidates: CandidateRef[],
): ExplanationEntry | null {
  if (!referenceName?.trim() || candidates.length === 0) return null;

  const refTokens = normalizeText(referenceName).split(' ').filter(Boolean);
  let best: { jaccard: number; candidate: CandidateRef } | null = null;
  for (const candidate of candidates) {
    const tokens = normalizeText(candidate.value).split(' ').filter(Boolean);
    const overlap = refTokens.filter((t) => tokens.includes(t)).length;
    const union = new Set([...refTokens, ...tokens]).size;
    const jaccard = union === 0 ? 0 : overlap / union;
    if (!best || jaccard > best.jaccard) best = { jaccard, candidate };
  }
  if (!best) return null;

  if (best.jaccard >= 0.999) {
    return {
      signal_type: 'name_match',
      points: WEIGHTS.nameFull,
      human_readable_reason: `Profile name "${best.candidate.value}" on ${best.candidate.platform} matches the reference name "${referenceName.trim()}".`,
    };
  }
  if (best.jaccard >= 0.5) {
    return {
      signal_type: 'name_partial_match',
      points: WEIGHTS.namePartial,
      human_readable_reason: `Profile name "${best.candidate.value}" on ${best.candidate.platform} partially overlaps the reference name "${referenceName.trim()}".`,
    };
  }
  return {
    signal_type: 'name_mismatch',
    points: WEIGHTS.nameMismatch,
    human_readable_reason: `Profile name "${best.candidate.value}" on ${best.candidate.platform} shares nothing with the reference name "${referenceName.trim()}" — evidence against a match.`,
  };
}

/**
 * Bio text-similarity signal: hashed-n-gram embeddings + cosine similarity.
 * Very low similarity between substantial bios is treated as contradicting.
 */
export function evaluateBioSignal(
  referenceBio: string | null,
  candidates: CandidateRef[],
): ExplanationEntry | null {
  if (candidates.length === 0) return null;

  if (!referenceBio?.trim()) {
    return {
      signal_type: 'bio_similarity',
      points: 0,
      human_readable_reason: `Candidate profile bio(s) available on ${candidates.map((c) => c.platform).join(', ')}, but no reference bio was provided for comparison.`,
    };
  }

  const refVec = embedText(referenceBio);
  let best: { sim: number; candidate: CandidateRef } | null = null;
  for (const candidate of candidates) {
    const sim = cosineSimilarity(refVec, embedText(candidate.value));
    if (!best || sim > best.sim) best = { sim, candidate };
  }
  if (!best) return null;

  const pct = best.sim.toFixed(2);
  if (best.sim >= WEIGHTS.bioPositiveFloor) {
    return {
      signal_type: 'bio_similarity',
      points: Math.round(WEIGHTS.bioFull * best.sim),
      human_readable_reason: `Bio text on ${best.candidate.platform} strongly resembles the reference bio (cosine similarity ${pct}).`,
    };
  }
  if (best.sim >= WEIGHTS.bioContradictionCeiling) {
    return {
      signal_type: 'bio_similarity',
      points: 0,
      human_readable_reason: `Bio on ${best.candidate.platform} only weakly resembles the reference bio (cosine similarity ${pct}) — inconclusive.`,
    };
  }
  if (
    referenceBio.trim().length >= WEIGHTS.bioMinCharsForContradiction &&
    best.candidate.value.trim().length >= WEIGHTS.bioMinCharsForContradiction
  ) {
    return {
      signal_type: 'bio_contradiction',
      points: WEIGHTS.bioContradictionPoints,
      human_readable_reason: `Bio on ${best.candidate.platform} is substantially different from the reference bio (cosine similarity ${pct}) — the two profiles describe different people.`,
    };
  }
  return {
    signal_type: 'bio_similarity',
    points: 0,
    human_readable_reason: `Bio on ${best.candidate.platform} differs from the (short) reference bio (cosine similarity ${pct}) — inconclusive.`,
  };
}
