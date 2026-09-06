import { config } from '../config.js';
import type { ExplanationEntry } from '../scoring/types.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * The system prompt intentionally locks the model to the provided evidence:
 * no invention, no assumptions, explicit "insufficient evidence" statements.
 */
export const SYSTEM_PROMPT = [
  'You are an OSINT analysis assistant.',
  'You receive a JSON object containing the searched input, a confidence score, and explanation_json: an ordered list of scored evidence signals that justify the score for a candidate identity match.',
  'Rules, in strict priority order:',
  '1. Reason ONLY over the evidence in the provided JSON. Never invent, assume, or extrapolate any fact that is not present in it.',
  '2. If the evidence is insufficient to reach a conclusion, say so explicitly.',
  '3. Do not add new claims about the person or platforms; describe only what the signals state, including negative/contradicting signals.',
  '4. Write 2-4 short plain sentences. Name the strongest supporting signal and, if present, the contradicting signals.',
].join(' ');

export interface ClusterSummaryInput {
  input_type: string;
  input_value: string;
  score: number;
  explanation: ExplanationEntry[];
}

export interface ClusterSummaryResult {
  summary: string | null;
  model: string | null;
  error: string | null;
}

export async function summarizeCluster(
  input: ClusterSummaryInput,
  fetchImpl: typeof fetch = fetch,
): Promise<ClusterSummaryResult> {
  if (!config.groqApiKey) {
    return {
      summary: null,
      model: null,
      error: 'GROQ_API_KEY is not configured — AI summary unavailable.',
    };
  }
  if (!Array.isArray(input.explanation) || input.explanation.length === 0) {
    return {
      summary: null,
      model: null,
      error: 'No explanation signals available to summarize.',
    };
  }

  const body = {
    model: config.groqModel,
    temperature: 0,
    max_tokens: 300,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: JSON.stringify({
          input_type: input.input_type,
          searched_value: input.input_value,
          confidence_score: input.score,
          explanation_json: input.explanation,
        }),
      },
    ],
  };

  try {
    const res = await fetchImpl(GROQ_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.groqApiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        summary: null,
        model: null,
        error: `Groq API error ${res.status}: ${text.slice(0, 200)}`,
      };
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      model?: string;
    };
    const summary = data.choices?.[0]?.message?.content?.trim() ?? null;
    if (!summary) {
      return { summary: null, model: data.model ?? null, error: 'Groq returned an empty summary.' };
    }
    return { summary, model: data.model ?? config.groqModel, error: null };
  } catch (err) {
    return {
      summary: null,
      model: null,
      error: `Groq request failed: ${(err as Error).message}`,
    };
  }
}
