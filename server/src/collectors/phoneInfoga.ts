import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { config } from '../config.js';
import { recordAudit } from '../services/audit.js';
import type {
  Collector,
  CollectorInput,
  CollectorResult,
  EvidenceDraft,
  IdentifierDraft,
  InputType,
} from './types.js';

/**
 * PhoneInfoga-style phone parsing/normalization (libphonenumber): E.164
 * normalization, country + line-type detection. External enrichment
 * scanners (numverify etc.) require API keys — without a key no carrier
 * lookup is attempted, and nothing is ever scraped from blocked sources.
 */
export class PhoneCollector implements Collector {
  platform = 'phone';
  appliesTo: InputType[] = ['phone'];
  rateLimitPerMinute = config.collectors.phone.requestsPerMinute;

  private readonly audit: typeof recordAudit;

  constructor(options: { audit?: typeof recordAudit } = {}) {
    this.audit = options.audit ?? recordAudit;
  }

  isEnabled(): boolean {
    return config.collectors.phone.enabled;
  }

  async fetch(input: CollectorInput): Promise<CollectorResult> {
    const started = Date.now();
    if (!this.appliesTo.includes(input.input_type)) {
      throw new Error(`PhoneCollector does not apply to input_type=${input.input_type}`);
    }
    const raw = input.input_value.trim();
    const base = {
      collector: this.platform,
      platform: this.platform,
      input_type: input.input_type,
      input_value: raw,
    };

    const parsed = parsePhoneNumberFromString(raw);
    if (!parsed || !parsed.isValid()) {
      await this.audit({
        investigation_id: input.investigation_id ?? null,
        actor: 'collector:phone',
        action: 'collector_run',
        subject: raw,
        details: { found: false, reason: 'invalid_or_unparseable_number' },
      });
      return {
        ...base,
        found: false,
        unavailable_reason: 'invalid_or_unparseable_phone_number',
        identifiers: [],
        evidence: [],
        duration_ms: Date.now() - started,
      };
    }

    const e164 = parsed.number;
    const lineType = parsed.getType() ?? 'unknown';
    const metadata = {
      country: parsed.country ?? null,
      country_calling_code: parsed.countryCallingCode,
      line_type: lineType,
      national_format: parsed.formatNational(),
      international_format: parsed.formatInternational(),
      valid: parsed.isValid(),
    };

    const identifiers: IdentifierDraft[] = [
      {
        identifier_type: 'phone',
        value: e164,
        platform: 'phone',
        url: null,
        metadata: { ...metadata, source: 'libphonenumber_parse' },
      },
    ];
    const evidence: EvidenceDraft[] = [
      {
        signal_type: 'phone_number_parsed',
        source_platform: 'phone',
        raw_data: { e164, ...metadata },
      },
    ];

    await this.audit({
      investigation_id: input.investigation_id ?? null,
      actor: 'collector:phone',
      action: 'collector_run',
      subject: e164,
      details: { found: true, country: metadata.country, line_type: lineType },
    });

    return {
      ...base,
      found: true,
      identifiers,
      evidence,
      duration_ms: Date.now() - started,
    };
  }
}
