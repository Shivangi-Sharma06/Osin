import { describe, expect, it, vi } from 'vitest';
import { RateLimiter } from '../src/collectors/rateLimiter.js';
import {
  extractDomain,
  githubProfileToDrafts,
  GithubCollector,
  isValidGithubUsername,
} from '../src/collectors/github.js';
import type { GithubProfile } from '../src/collectors/github.js';

describe('isValidGithubUsername', () => {
  it.each([
    ['torvalds', true],
    ['a', true],
    ['user-name', true],
    ['a-b-c', true],
    ['User123', true],
    ['-abc', false],
    ['abc-', false],
    ['has space', false],
    ['dot.name', false],
    ['', false],
    ['a'.repeat(39), true],
    ['a'.repeat(40), false],
  ])('%j → %j', (value, expected) => {
    expect(isValidGithubUsername(value)).toBe(expected);
  });
});

describe('extractDomain', () => {
  it.each([
    ['https://example.com', 'example.com'],
    ['http://blog.example.io/path', 'blog.example.io'],
    ['example.com', 'example.com'],
    ['sub.domain.org/', 'sub.domain.org'],
    ['', null],
    [null, null],
    ['://bad', null],
  ])('%j → %j', (input, expected) => {
    expect(extractDomain(input)).toBe(expected);
  });
});

const fullProfile: GithubProfile = {
  login: 'torvalds',
  id: 1024025,
  name: 'Linus Torvalds',
  bio: 'Software engineer, kernel hacker.',
  company: 'Linux Foundation',
  blog: 'https://github-blog.example.com',
  location: 'Portland, OR',
  email: null,
  twitter_username: 'Linus__Torvalds',
  public_repos: 8,
  followers: 200000,
  following: 0,
  created_at: '2011-09-20T16:27:38Z',
  updated_at: '2024-01-01T00:00:00Z',
  avatar_url: 'https://avatars.githubusercontent.com/u/1024025?v=4',
  html_url: 'https://github.com/torvalds',
  type: 'User',
};

describe('githubProfileToDrafts', () => {
  it('maps a full profile into normalized identifier drafts', () => {
    const { identifiers, evidence } = githubProfileToDrafts(fullProfile);

    const byKey = new Map(identifiers.map((d) => [`${d.identifier_type}:${d.platform}`, d]));

    const ghUser = byKey.get('username:github')!;
    expect(ghUser.value).toBe('torvalds');
    expect(ghUser.url).toBe('https://github.com/torvalds');
    expect(ghUser.metadata!.bio).toBe('Software engineer, kernel hacker.');

    expect(byKey.get('name:github')!.value).toBe('Linus Torvalds');
    expect(byKey.get('username:x')!.value).toBe('Linus__Torvalds');
    expect(byKey.get('domain:github')!.value).toBe('github-blog.example.com');

    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.signal_type).toBe('platform_profile_exists');
    expect(evidence[0]!.source_platform).toBe('github');
    expect(evidence[0]!.raw_data!.github_id).toBe(1024025);
  });

  it('emits only the username identifier for a minimal profile', () => {
    const minimal: GithubProfile = {
      ...fullProfile,
      name: null,
      bio: null,
      blog: null,
      twitter_username: null,
    };
    const { identifiers, evidence } = githubProfileToDrafts(minimal);
    expect(identifiers).toHaveLength(1);
    expect(identifiers[0]!.identifier_type).toBe('username');
    expect(evidence).toHaveLength(1);
  });
});

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const noopAudit = vi.fn(async () => {});

function makeCollector(fetchImpl: typeof fetch): GithubCollector {
  return new GithubCollector({
    fetchImpl,
    audit: noopAudit as unknown as typeof import('../src/services/audit.js').recordAudit,
  });
}

describe('GithubCollector.fetch', () => {
  it('returns found=false with no drafts for a 404 profile', async () => {
    const collector = makeCollector(async () => jsonResponse(404, { message: 'Not Found' }));
    const result = await collector.fetch({ input_type: 'username', input_value: 'no-such-user-xyz' });
    expect(result.found).toBe(false);
    expect(result.unavailable_reason).toBe('profile_not_found');
    expect(result.identifiers).toHaveLength(0);
    expect(result.evidence).toHaveLength(0);
    expect(noopAudit).toHaveBeenCalledTimes(2); // http_request + collector_run
  });

  it('maps a 200 profile into found=true with normalized drafts', async () => {
    const collector = makeCollector(async () =>
      jsonResponse(200, fullProfile, { 'x-ratelimit-remaining': '59' }),
    );
    const result = await collector.fetch({ input_type: 'username', input_value: 'torvalds' });
    expect(result.found).toBe(true);
    expect(result.identifiers.length).toBeGreaterThanOrEqual(2);
    expect(result.evidence[0]!.signal_type).toBe('platform_profile_exists');
  });

  it('rejects invalid usernames without any HTTP call', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, fullProfile));
    const collector = makeCollector(fetchMock as unknown as typeof fetch);
    const result = await collector.fetch({ input_type: 'username', input_value: 'bad user!' });
    expect(result.found).toBe(false);
    expect(result.unavailable_reason).toBe('invalid_github_username_format');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws RateLimitError on 403/429', async () => {
    const collector = makeCollector(async () =>
      jsonResponse(403, { message: 'API rate limit exceeded' }),
    );
    await expect(
      collector.fetch({ input_type: 'username', input_value: 'torvalds' }),
    ).rejects.toThrow(/rate limit exceeded/);
  });

  it('refuses input types it does not apply to', async () => {
    const collector = makeCollector(async () => jsonResponse(200, fullProfile));
    await expect(collector.fetch({ input_type: 'email', input_value: 'x@y.com' })).rejects.toThrow(
      /does not apply/,
    );
  });
});

describe('RateLimiter', () => {
  it('enforces the minimum interval using injectable clock/sleep', async () => {
    let now = 1_000_000;
    const sleeps: number[] = [];
    const limiter = new RateLimiter(60, {
      nowFn: () => now,
      sleepFn: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });

    await limiter.acquire(); // first call: no wait
    expect(sleeps).toEqual([]);

    now += 100; // only 100ms passed; interval for 60rpm is 1000ms
    await limiter.acquire();
    expect(sleeps).toEqual([900]);

    now += 5000; // plenty of time passed; no wait needed
    await limiter.acquire();
    expect(sleeps).toEqual([900]);
  });
});
