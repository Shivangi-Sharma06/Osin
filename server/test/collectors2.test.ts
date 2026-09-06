import { describe, expect, it, vi } from 'vitest';
import { RateLimiter } from '../src/collectors/rateLimiter.js';
import { UsernameFanoutCollector } from '../src/collectors/usernameFanout.js';
import {
  extractCandidateUsernames,
  NameSearchCollector,
} from '../src/collectors/nameSearch.js';
import { gravatarHash, EmailCollector } from '../src/collectors/emailHolehe.js';
import { OfficialSocialCollector } from '../src/collectors/officialSocial.js';
import { PhoneCollector } from '../src/collectors/phoneInfoga.js';
import { config } from '../src/config.js';

describe('extractCandidateUsernames (name dorking)', () => {
  it('extracts profile handles from DuckDuckGo-style results and filters reserved ones', () => {
    const html = `
      <a class="result" href="/l/?uddg=https%3A%2F%2Fgithub.com%2Ftorvalds&rut=abc">Linux</a>
      <a class="result" href="/l/?uddg=https%3A%2F%2Fwww.reddit.com%2Fuser%2Ftorvalds%2F&rut=def">Reddit</a>
      <a class="result" href="/l/?uddg=https%3A%2F%2Fgithub.com%2Fabout&rut=ghi">About (reserved)</a>
      <a class="result" href="/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fx&rut=jkl">Internal (skipped)</a>
      <a href="https://mastodon.social/@someone">Mastodon</a>
    `;
    const candidates = extractCandidateUsernames(html);
    const names = candidates.map((c) => c.username);
    expect(names).toContain('torvalds');
    expect(names).toContain('someone');
    expect(names).not.toContain('about');
    const torvalds = candidates.find((c) => c.username === 'torvalds')!;
    expect(torvalds.platform_hint).toBe('github');
    expect(torvalds.source_url).toBe('https://github.com/torvalds');
  });
});

describe('gravatarHash', () => {
  it('computes md5 of the trimmed, lowercased address (gravatar docs vector)', () => {
    expect(gravatarHash('Example@Example.com ')).toBe('23463b99b62a72f26ed677cc556c44e8');
  });
});

describe('PhoneCollector', () => {
  const collector = new PhoneCollector({ audit: vi.fn(async () => {}) });

  it('parses and normalizes a valid number', async () => {
    const result = await collector.fetch({ input_type: 'phone', input_value: '+1 503 555 0100' });
    expect(result.found).toBe(true);
    const phone = result.identifiers.find((i) => i.identifier_type === 'phone')!;
    expect(phone.value).toBe('+15035550100');
    expect(phone.metadata!.country).toBe('US');
    expect(result.evidence[0]!.signal_type).toBe('phone_number_parsed');
  });

  it('rejects unparseable numbers', async () => {
    const result = await collector.fetch({ input_type: 'phone', input_value: '123' });
    expect(result.found).toBe(false);
    expect(result.unavailable_reason).toBe('invalid_or_unparseable_phone_number');
  });

  it('refuses input types it does not apply to', async () => {
    await expect(
      collector.fetch({ input_type: 'username', input_value: 'x' }),
    ).rejects.toThrow(/does not apply/);
  });
});

describe('EmailCollector', () => {
  it('rejects invalid email format without any HTTP call', async () => {
    const fetchMock = vi.fn();
    const collector = new EmailCollector({
      fetchImpl: fetchMock as unknown as typeof fetch,
      audit: vi.fn(async () => {}),
    });
    const result = await collector.fetch({ input_type: 'email', input_value: 'not-an-email' });
    expect(result.found).toBe(false);
    expect(result.unavailable_reason).toBe('invalid_email_format');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('OfficialSocialCollector', () => {
  it('reports explicit unavailability for login-walled platforms without any bypass', async () => {
    const original = config.xBearerToken;
    (config as { xBearerToken: string }).xBearerToken = '';
    try {
      const fetchMock = vi.fn();
      const collector = new OfficialSocialCollector({
        fetchImpl: fetchMock as unknown as typeof fetch,
        audit: vi.fn(async () => {}),
      });
      const result = await collector.fetch({ input_type: 'username', input_value: 'torvalds' });
      expect(result.found).toBe(false);
      expect(result.unavailable_reason).toMatch(/unavailable via public\/official access/);
      expect(result.unavailable_reason).toContain('instagram');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      (config as { xBearerToken: string }).xBearerToken = original;
    }
  });
});

describe('UsernameFanoutCollector', () => {
  it('sanitizes invalid usernames before any network call', async () => {
    const fetchMock = vi.fn();
    const collector = new UsernameFanoutCollector({
      fetchImpl: fetchMock as unknown as typeof fetch,
      audit: vi.fn(async () => {}),
    });
    const result = await collector.fetch({ input_type: 'username', input_value: 'a b c!' });
    expect(result.found).toBe(false);
    expect(result.unavailable_reason).toBe('invalid_username_format');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
