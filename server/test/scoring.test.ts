import { describe, expect, it } from 'vitest';
import { scoreCluster } from '../src/scoring/engine.js';
import type { ScoringInput } from '../src/scoring/types.js';

const REF_BIO = 'ML engineer. Kaggle grandmaster. Writes about transformers and open source.';
const OTHER_BIO = 'Sourdough baker and ceramic artist based in Lisbon. I teach weekend classes.';

function baseInput(overrides: Partial<ScoringInput> = {}): ScoringInput {
  return {
    input_type: 'username',
    input_value: 'sarah_codes',
    reference_metadata: { name: 'Sarah Chen', bio: REF_BIO },
    identifiers: [],
    evidence: [],
    ...overrides,
  };
}

describe('scoreCluster — clear match', () => {
  const input = baseInput({
    identifiers: [
      {
        identifier_type: 'username',
        value: 'sarah_codes',
        platform: 'github',
        metadata: { bio: REF_BIO },
      },
    ],
    evidence: [{ signal_type: 'platform_profile_exists', source_platform: 'github' }],
  });
  const result = scoreCluster(input);

  it('produces a high confidence score', () => {
    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('explains the exact username match', () => {
    const entry = result.explanation_json.find((e) => e.signal_type === 'username_match');
    expect(entry?.points).toBe(40);
    expect(entry?.human_readable_reason).toContain('sarah_codes');
  });

  it('explains the strong bio similarity', () => {
    const entry = result.explanation_json.find((e) => e.signal_type === 'bio_similarity');
    expect(entry?.points).toBeGreaterThanOrEqual(25);
  });

  it('orders the explanation most-influential-first', () => {
    const points = result.explanation_json.map((e) => Math.abs(e.points));
    const sorted = [...points].sort((a, b) => b - a);
    expect(points).toEqual(sorted);
  });
});

describe('scoreCluster — clear non-match', () => {
  const input = baseInput({
    identifiers: [
      {
        identifier_type: 'username',
        value: 'greg_ttv',
        platform: 'github',
        metadata: { bio: 'Fantasy football commissioner. Dad joke enthusiast.' },
      },
    ],
    evidence: [{ signal_type: 'platform_profile_exists', source_platform: 'github' }],
  });
  const result = scoreCluster(input);

  it('produces a low confidence score', () => {
    expect(result.score).toBeLessThanOrEqual(25);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it('includes the contradicting username signal', () => {
    const entry = result.explanation_json.find((e) => e.signal_type === 'username_mismatch');
    expect(entry?.points).toBeLessThan(0);
    expect(entry?.human_readable_reason).toContain('greg_ttv');
  });

  it('notes the bio could not be compared without a reference', () => {
    // reference_metadata.bio was overridden to be absent from candidates' perspective:
    // the candidate bio exists but no reference bio was provided in this scenario.
    const noRefInput: ScoringInput = {
      input_type: 'username',
      input_value: 'sarah_codes',
      reference_metadata: null,
      identifiers: [
        { identifier_type: 'username', value: 'greg_ttv', platform: 'github', metadata: { bio: 'x' } },
      ],
      evidence: [],
    };
    const r = scoreCluster(noRefInput);
    const entry = r.explanation_json.find((e) => e.signal_type === 'bio_similarity');
    expect(entry?.points).toBe(0);
    expect(entry?.human_readable_reason).toContain('no reference bio');
  });
});

describe('scoreCluster — contradiction case', () => {
  const input = baseInput({
    identifiers: [
      {
        identifier_type: 'username',
        value: 'sarah_codes',
        platform: 'github',
        metadata: { bio: OTHER_BIO },
      },
      { identifier_type: 'name', value: 'Marco Rossi', platform: 'github' },
    ],
    evidence: [{ signal_type: 'platform_profile_exists', source_platform: 'github' }],
  });
  const result = scoreCluster(input);

  it('reduces the score below 50 despite the exact username match', () => {
    expect(result.score).toBeLessThan(50);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it('carries negative bio contradiction points', () => {
    const entry = result.explanation_json.find((e) => e.signal_type === 'bio_contradiction');
    expect(entry?.points).toBe(-12);
    expect(entry?.human_readable_reason).toContain('different people');
  });

  it('carries negative name mismatch points', () => {
    const entry = result.explanation_json.find((e) => e.signal_type === 'name_mismatch');
    expect(entry?.points).toBe(-10);
  });
});

describe('scoreCluster — edge cases', () => {
  it('returns 0 with empty explanation when nothing is known', () => {
    const result = scoreCluster(baseInput({ identifiers: [], evidence: [] }));
    expect(result.score).toBe(0);
    expect(result.explanation_json).toEqual([]);
  });

  it('is deterministic for identical inputs', () => {
    const input = baseInput({
      identifiers: [{ identifier_type: 'username', value: 'sarah_codes', platform: 'github' }],
      evidence: [{ signal_type: 'platform_profile_exists', source_platform: 'github' }],
    });
    expect(scoreCluster(input)).toEqual(scoreCluster(input));
  });

  it('never leaves the 0..100 range', () => {
    const result = scoreCluster(baseInput({ identifiers: [], evidence: [] }));
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});
