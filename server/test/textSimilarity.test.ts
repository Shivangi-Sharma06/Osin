import { describe, expect, it } from 'vitest';
import {
  cosineSimilarity,
  embedText,
  jaroWinkler,
  levenshtein,
  normalizedSimilarity,
} from '../src/scoring/textSimilarity.js';

describe('levenshtein', () => {
  it.each([
    ['kitten', 'sitting', 3],
    ['flaw', 'lawn', 2],
    ['', 'abc', 3],
    ['abc', '', 3],
    ['same', 'same', 0],
  ])('%j vs %j → %i', (a, b, expected) => {
    expect(levenshtein(a, b)).toBe(expected);
  });
});

describe('jaroWinkler', () => {
  it('scores transposed strings highly', () => {
    // Classic result: jaro=0.9444, common prefix "MAR" (3 chars) → 0.9611.
    expect(jaroWinkler('MARTHA', 'MARHTA')).toBeCloseTo(0.9611, 3);
  });
  it('returns 1 for identical strings and 0 for disjoint ones', () => {
    expect(jaroWinkler('dwayne', 'dwayne')).toBe(1);
    expect(jaroWinkler('abc', 'xyz')).toBe(0);
  });
});

describe('normalizedSimilarity', () => {
  it('is 1 for identical, 0 for empty-vs-filled', () => {
    expect(normalizedSimilarity('john', 'john')).toBe(1);
    expect(normalizedSimilarity('', 'john')).toBe(0);
  });
  it('keeps clearly different usernames below the similarity floor', () => {
    expect(normalizedSimilarity('sarah_codes', 'greg_ttv')).toBeLessThan(0.6);
  });
});

describe('embedText + cosineSimilarity', () => {
  it('gives cosine 1 for identical text (case/whitespace invariant)', () => {
    const a = embedText('ML engineer. Kaggle grandmaster.');
    const b = embedText('  ml ENGINEER.  kaggle   grandmaster. ');
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 6);
  });
  it('gives cosine 1 regardless of word order (bag of features)', () => {
    const a = embedText('loves sourdough and ceramics');
    const b = embedText('ceramics and sourdough loves');
    expect(cosineSimilarity(a, b)).toBeGreaterThan(0.9);
  });
  it('gives low cosine for unrelated texts', () => {
    const a = embedText('ML engineer. Kaggle grandmaster. Writes about transformers.');
    const b = embedText('Sourdough baker and ceramic artist based in Lisbon.');
    expect(cosineSimilarity(a, b)).toBeLessThan(0.35);
  });
  it('handles empty text as a zero vector (cosine 0)', () => {
    expect(cosineSimilarity(embedText(''), embedText('anything'))).toBe(0);
  });
  it('is deterministic', () => {
    expect(cosineSimilarity(embedText('same text'), embedText('same text'))).toBe(1);
  });
});
