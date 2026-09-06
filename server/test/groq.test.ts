import { afterEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_PROMPT, summarizeCluster } from '../src/ai/groq.js';
import { config } from '../src/config.js';
import type { ExplanationEntry } from '../src/scoring/types.js';

const explanation: ExplanationEntry[] = [
  {
    signal_type: 'username_match',
    points: 40,
    human_readable_reason: 'Username "torvalds" on github matches the searched username exactly.',
  },
  {
    signal_type: 'platform_profile_exists',
    points: 20,
    human_readable_reason: 'Verified public profile exists on github.',
  },
];

const withKey = async (fn: () => Promise<void>): Promise<void> => {
  const original = config.groqApiKey;
  (config as { groqApiKey: string }).groqApiKey = 'test-key';
  try {
    await fn();
  } finally {
    (config as { groqApiKey: string }).groqApiKey = original;
  }
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('summarizeCluster', () => {
  it('degrades gracefully when GROQ_API_KEY is not configured', async () => {
    const original = config.groqApiKey;
    (config as { groqApiKey: string }).groqApiKey = '';
    try {
      const fetchMock = vi.fn();
      const result = await summarizeCluster(
        {
          input_type: 'username',
          input_value: 'torvalds',
          score: 60,
          explanation,
        },
        fetchMock as unknown as typeof fetch,
      );
      expect(result.summary).toBeNull();
      expect(result.error).toMatch(/GROQ_API_KEY/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      (config as { groqApiKey: string }).groqApiKey = original;
    }
  });

  it('sends the evidence-only system prompt and the explanation as JSON', async () => {
    await withKey(async () => {
      const fetchMock = vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'Evidence indicates an exact username match.' } }],
            model: 'llama-3.3-70b-versatile',
          }),
          { status: 200 },
        ),
      );
      const result = await summarizeCluster(
        { input_type: 'username', input_value: 'torvalds', score: 60, explanation },
        fetchMock as unknown as typeof fetch,
      );

      expect(result.error).toBeNull();
      expect(result.summary).toBe('Evidence indicates an exact username match.');
      expect(result.model).toBe('llama-3.3-70b-versatile');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toContain('api.groq.com');
      const body = JSON.parse(String(init.body));
      expect(body.messages[0].content).toBe(SYSTEM_PROMPT);
      expect(body.messages[0].content).toMatch(/ONLY over the evidence/);
      expect(body.messages[0].content).toMatch(/Never invent/);
      expect(body.messages[0].content).toMatch(/insufficient/);
      const userPayload = JSON.parse(body.messages[1].content);
      expect(userPayload.explanation_json).toHaveLength(2);
      expect(userPayload.confidence_score).toBe(60);
      expect(userPayload.searched_value).toBe('torvalds');
    });
  });

  it('surfaces API errors without throwing', async () => {
    await withKey(async () => {
      const fetchMock = vi.fn(async () => new Response('unauthorized', { status: 401 }));
      const result = await summarizeCluster(
        { input_type: 'username', input_value: 'torvalds', score: 60, explanation },
        fetchMock as unknown as typeof fetch,
      );
      expect(result.summary).toBeNull();
      expect(result.error).toMatch(/Groq API error 401/);
    });
  });

  it('refuses to summarize without explanation signals', async () => {
    await withKey(async () => {
      const fetchMock = vi.fn();
      const result = await summarizeCluster(
        { input_type: 'username', input_value: 'torvalds', score: 0, explanation: [] },
        fetchMock as unknown as typeof fetch,
      );
      expect(result.summary).toBeNull();
      expect(result.error).toMatch(/No explanation signals/);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
