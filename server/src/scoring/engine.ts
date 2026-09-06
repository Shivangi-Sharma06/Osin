import {
  evaluateBioSignal,
  evaluateNameSignal,
  evaluateProfileExistence,
  evaluateUsernameSignal,
  type CandidateRef,
} from './signals.js';
import type { ExplanationEntry, ScoringIdentifier, ScoringInput, ScoreResult } from './types.js';

function extractValueCandidates(
  identifiers: ScoringIdentifier[],
  identifierType: string,
): CandidateRef[] {
  const out: CandidateRef[] = [];
  for (const identifier of identifiers) {
    if (identifier.identifier_type !== identifierType) continue;
    const value = typeof identifier.value === 'string' ? identifier.value.trim() : '';
    if (value) out.push({ value, platform: identifier.platform });
  }
  return out;
}

function extractMetadataCandidates(
  identifiers: ScoringIdentifier[],
  metadataField: string,
): CandidateRef[] {
  const out: CandidateRef[] = [];
  for (const identifier of identifiers) {
    const raw = identifier.metadata?.[metadataField];
    if (typeof raw === 'string' && raw.trim()) {
      out.push({ value: raw, platform: identifier.platform });
    }
  }
  return out;
}

/**
 * Pure scoring engine: combines evaluated signals into a 0..100 confidence
 * percentage plus an ordered explanation. NO DB calls — input in, result out.
 * Contradicting signals contribute negative points and are preserved in the
 * explanation so the UI can show why confidence was reduced.
 */
export function scoreCluster(input: ScoringInput): ScoreResult {
  const entries: ExplanationEntry[] = [];
  const searched = input.input_value.trim();
  const reference = input.reference_metadata ?? {};

  const existence = evaluateProfileExistence(input.evidence);
  if (existence) entries.push(existence);

  const usernameEntry = evaluateUsernameSignal(
    searched,
    extractValueCandidates(input.identifiers, 'username'),
  );
  if (usernameEntry) entries.push(usernameEntry);

  const metadataName = typeof reference.name === 'string' ? reference.name : null;
  const referenceName = metadataName?.trim()
    ? metadataName
    : input.input_type === 'name'
      ? searched
      : null;
  const nameEntry = evaluateNameSignal(referenceName, extractValueCandidates(input.identifiers, 'name'));
  if (nameEntry) entries.push(nameEntry);

  const metadataBio = typeof reference.bio === 'string' ? reference.bio : null;
  const bioEntry = evaluateBioSignal(
    metadataBio,
    extractMetadataCandidates(input.identifiers, 'bio'),
  );
  if (bioEntry) entries.push(bioEntry);

  const rawTotal = entries.reduce((acc, e) => acc + e.points, 0);
  const score = Math.round(Math.min(100, Math.max(0, rawTotal)) * 10) / 10;

  // Ordered most-influential-first (stable sort keeps insertion order on ties).
  const explanation_json = [...entries].sort(
    (a, b) => Math.abs(b.points) - Math.abs(a.points),
  );

  return { score, explanation_json };
}
