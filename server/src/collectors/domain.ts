import dns from 'node:dns/promises';
import { config } from '../config.js';
import { recordAudit } from '../services/audit.js';
import { RateLimiter } from './rateLimiter.js';
import type {
  Collector,
  CollectorInput,
  CollectorResult,
  EvidenceDraft,
  IdentifierDraft,
  InputType,
} from './types.js';

const DOMAIN_RE = /^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

function cleanDomain(value: string): string | null {
  const raw = value.trim().toLowerCase();
  if (!raw) return null;
  try {
    const parsed = raw.includes('://') ? new URL(raw) : new URL(`https://${raw}`);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return DOMAIN_RE.test(raw) ? raw.replace(/^www\./, '') : null;
  }
}

function baseResult(input: CollectorInput, started: number, reason: string): CollectorResult {
  return {
    collector: 'domain',
    platform: 'domain',
    input_type: input.input_type,
    input_value: input.input_value,
    found: false,
    unavailable_reason: reason,
    identifiers: [],
    evidence: [],
    duration_ms: Date.now() - started,
  };
}

function domainIdentifier(domain: string, platform: string, metadata: Record<string, unknown>): IdentifierDraft {
  return {
    identifier_type: 'domain',
    value: domain,
    platform,
    url: `https://${domain}`,
    metadata: { ...metadata, source: platform },
  };
}

function validCertificateDomain(name: string, rootDomain: string): string | null {
  const cleaned = name.trim().toLowerCase().replace(/^\*\./, '');
  const underRoot = cleaned === rootDomain || cleaned.endsWith(`.${rootDomain}`);
  if (!underRoot || cleaned.includes('@')) return null;
  return DOMAIN_RE.test(cleaned) ? cleaned : null;
}

abstract class DomainCollectorBase implements Collector {
  abstract platform: string;
  appliesTo: InputType[] = ['domain'];
  abstract configKey: string;
  abstract collect(domain: string): Promise<{ identifiers: IdentifierDraft[]; evidence: EvidenceDraft[] }>;

  private readonly limiter: RateLimiter;

  constructor() {
    this.limiter = new RateLimiter(this.rateLimitPerMinute);
  }

  get rateLimitPerMinute(): number {
    return config.collectors[this.configKey]?.requestsPerMinute ?? 10;
  }

  isEnabled(): boolean {
    return config.collectors[this.configKey]?.enabled ?? true;
  }

  async fetch(input: CollectorInput): Promise<CollectorResult> {
    const started = Date.now();
    const domain = cleanDomain(input.input_value);
    if (!domain) return baseResult(input, started, 'invalid_domain_format');

    await this.limiter.acquire();
    try {
      const collected = await this.collect(domain);
      const found = collected.identifiers.length > 0 || collected.evidence.length > 0;
      await recordAudit({
        investigation_id: input.investigation_id ?? null,
        actor: `collector:${this.platform}`,
        action: 'collector_run',
        subject: domain,
        details: { found, identifiers: collected.identifiers.length, evidence: collected.evidence.length },
      });
      return {
        collector: this.platform,
        platform: this.platform,
        input_type: input.input_type,
        input_value: domain,
        found,
        unavailable_reason: found ? undefined : 'no_public_domain_records_found',
        identifiers: collected.identifiers,
        evidence: collected.evidence,
        duration_ms: Date.now() - started,
      };
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      await recordAudit({
        investigation_id: input.investigation_id ?? null,
        actor: `collector:${this.platform}`,
        action: 'collector_error',
        subject: domain,
        details: { error: message },
      });
      return baseResult(input, started, `unavailable via public access: ${message}`);
    }
  }
}

export class DnsCollector extends DomainCollectorBase {
  platform = 'dns';
  configKey = 'domain_dns';

  async collect(domain: string): Promise<{ identifiers: IdentifierDraft[]; evidence: EvidenceDraft[] }> {
    const [a, aaaa, mx, ns, txt] = await Promise.allSettled([
      dns.resolve4(domain),
      dns.resolve6(domain),
      dns.resolveMx(domain),
      dns.resolveNs(domain),
      dns.resolveTxt(domain),
    ]);
    const records = {
      a: a.status === 'fulfilled' ? a.value : [],
      aaaa: aaaa.status === 'fulfilled' ? aaaa.value : [],
      mx: mx.status === 'fulfilled' ? mx.value : [],
      ns: ns.status === 'fulfilled' ? ns.value : [],
      txt: txt.status === 'fulfilled' ? txt.value : [],
    };
    const count = records.a.length + records.aaaa.length + records.mx.length + records.ns.length + records.txt.length;
    if (count === 0) return { identifiers: [], evidence: [] };
    return {
      identifiers: [domainIdentifier(domain, 'dns', { record_count: count })],
      evidence: [{ signal_type: 'domain_dns_records', source_platform: 'dns', raw_data: records }],
    };
  }
}

export class RdapCollector extends DomainCollectorBase {
  platform = 'rdap';
  configKey = 'domain_whois';

  async collect(domain: string): Promise<{ identifiers: IdentifierDraft[]; evidence: EvidenceDraft[] }> {
    const url = `https://rdap.org/domain/${encodeURIComponent(domain)}`;
    const res = await fetch(url, { headers: { accept: 'application/rdap+json, application/json' } });
    await recordAudit({
      actor: 'collector:rdap',
      action: 'http_request',
      subject: url,
      status_code: res.status,
      details: { public_rdap: true },
    });
    if (res.status === 404) return { identifiers: [], evidence: [] };
    if (!res.ok) throw new Error(`RDAP returned HTTP ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    return {
      identifiers: [domainIdentifier(domain, 'rdap', { handle: body.handle, ldhName: body.ldhName })],
      evidence: [{ signal_type: 'domain_whois_rdap', source_platform: 'rdap', raw_data: body }],
    };
  }
}

export class CertificateTransparencyCollector extends DomainCollectorBase {
  platform = 'crtsh';
  configKey = 'domain_ct';

  async collect(domain: string): Promise<{ identifiers: IdentifierDraft[]; evidence: EvidenceDraft[] }> {
    const url = `https://crt.sh/?q=${encodeURIComponent(domain)}&output=json`;
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    await recordAudit({
      actor: 'collector:crtsh',
      action: 'http_request',
      subject: url,
      status_code: res.status,
      details: { public_ct: true },
    });
    if (!res.ok) throw new Error(`crt.sh returned HTTP ${res.status}`);
    const rows = (await res.json()) as Array<{ name_value?: string; issuer_name?: string; not_before?: string }>;
    const names = [
      ...new Set(
        rows
          .flatMap((r) => String(r.name_value ?? '').split('\n'))
          .map((name) => validCertificateDomain(name, domain))
          .filter((name): name is string => Boolean(name)),
      ),
    ].slice(0, 30);
    if (names.length === 0) return { identifiers: [], evidence: [] };
    return {
      identifiers: [
        domainIdentifier(domain, 'crtsh', { certificate_names: names.length }),
        ...names
          .filter((name) => name !== domain && name.endsWith(domain))
          .slice(0, 10)
          .map((name) => domainIdentifier(name.replace(/^\*\./, ''), 'crtsh', { source_domain: domain })),
      ],
      evidence: [{ signal_type: 'domain_certificate_transparency', source_platform: 'crtsh', raw_data: { names, sample_size: rows.length } }],
    };
  }
}

export class TechStackCollector extends DomainCollectorBase {
  platform = 'tech_stack';
  configKey = 'domain_tech';

  async collect(domain: string): Promise<{ identifiers: IdentifierDraft[]; evidence: EvidenceDraft[] }> {
    const url = `https://${domain}`;
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    const headers = Object.fromEntries([...res.headers.entries()].filter(([key]) => ['server', 'x-powered-by', 'via'].includes(key)));
    return {
      identifiers: [domainIdentifier(domain, 'tech_stack', { http_status: res.status, headers })],
      evidence: [{ signal_type: 'domain_tech_stack', source_platform: 'tech_stack', raw_data: { status: res.status, headers, final_url: res.url } }],
    };
  }
}
