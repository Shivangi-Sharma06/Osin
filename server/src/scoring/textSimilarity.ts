/**
 * Pure string-similarity primitives for the scoring engine.
 * No I/O, no DB, fully deterministic.
 */

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev: number[] = new Array(b.length + 1);
  let curr: number[] = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

export function jaro(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aFlags: boolean[] = new Array(a.length).fill(false);
  const bFlags: boolean[] = new Array(b.length).fill(false);
  let matches = 0;

  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, b.length);
    for (let j = start; j < end; j++) {
      if (!bFlags[j] && a[i] === b[j]) {
        aFlags[i] = true;
        bFlags[j] = true;
        matches++;
        break;
      }
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aFlags[i]) continue;
    while (!bFlags[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions /= 2;

  return (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;
}

export function jaroWinkler(a: string, b: string): number {
  const j = jaro(a, b);
  if (j === 0) return 0;
  const maxPrefix = Math.min(4, a.length, b.length);
  let prefix = 0;
  while (prefix < maxPrefix && a[prefix] === b[prefix]) prefix++;
  return j + prefix * 0.1 * (1 - j);
}

/** Best of Jaro-Winkler and length-normalized Levenshtein. 1 = identical. */
export function normalizedSimilarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const jw = jaroWinkler(a, b);
  const levSim = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  return Math.max(jw, levSim);
}

export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

const EMBED_DIM = 256;

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic local text embedding (no external API): feature-hashed
 * word unigrams + character trigrams, L2-normalized. Cosine of two
 * embedded texts approximates lexical similarity.
 */
export function embedText(text: string): Float64Array {
  const vec = new Float64Array(EMBED_DIM);
  const norm = normalizeText(text);
  if (!norm) return vec;

  const addFeature = (feature: string, weight: number): void => {
    const idx = fnv1a(feature) % EMBED_DIM;
    vec[idx] = (vec[idx] ?? 0) + weight;
  };

  for (const word of norm.split(' ')) {
    addFeature(`w:${word}`, 1);
    const padded = `^${word}$`;
    for (let i = 0; i + 3 <= padded.length; i++) {
      addFeature(`t:${padded.slice(i, i + 3)}`, 0.5);
    }
  }

  let sq = 0;
  for (let i = 0; i < EMBED_DIM; i++) sq += (vec[i] ?? 0) * (vec[i] ?? 0);
  const normLen = Math.sqrt(sq);
  if (normLen > 0) {
    for (let i = 0; i < EMBED_DIM; i++) vec[i] = (vec[i] ?? 0) / normLen;
  }
  return vec;
}

/** Cosine similarity; inputs are expected L2-normalized (as produced by embedText). */
export function cosineSimilarity(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}
