import { pool, query, type Queryable } from './pool.js';
import type { EvidenceDraft, IdentifierDraft } from '../collectors/types.js';

export interface InvestigationRow {
  id: string;
  input_type: string;
  input_value: string;
  status: string;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function createInvestigation(
  input_type: string,
  input_value: string,
  status: 'queued' | 'running' = 'queued',
  exec: Queryable = pool,
): Promise<InvestigationRow> {
  const res = await exec.query<InvestigationRow & Record<string, unknown>>(
    `INSERT INTO investigations (input_type, input_value, status)
     VALUES ($1, $2, $3)
     RETURNING id, input_type, input_value, status, error, created_at, updated_at`,
    [input_type, input_value, status],
  );
  return res.rows[0]!;
}

export async function updateInvestigationStatus(
  id: string,
  status: 'queued' | 'running' | 'completed' | 'failed',
  error: string | null = null,
  exec: Queryable = pool,
): Promise<void> {
  await exec.query(
    `UPDATE investigations SET status = $2, error = $3, updated_at = now() WHERE id = $1`,
    [id, status, error],
  );
}

export async function getInvestigation(id: string): Promise<InvestigationRow | null> {
  const res = await query<InvestigationRow & Record<string, unknown>>(
    `SELECT id, input_type, input_value, status, error, created_at, updated_at
     FROM investigations WHERE id = $1`,
    [id],
  );
  return res.rows[0] ?? null;
}

export async function createEntity(
  investigation_id: string,
  entity_type: 'person' | 'domain' | 'organization' | 'unknown',
  label: string,
  exec: Queryable = pool,
): Promise<{ id: string }> {
  const res = await exec.query<{ id: string }>(
    `INSERT INTO entities (investigation_id, entity_type, label)
     VALUES ($1, $2, $3) RETURNING id`,
    [investigation_id, entity_type, label],
  );
  return res.rows[0]!;
}

/**
 * Insert-or-update an identifier keyed by (identifier_type, value, platform).
 * If the identifier was seen before (possibly under another entity), the row is
 * re-pointed at the current entity, last_seen refreshed and metadata merged.
 */
export async function upsertIdentifierForEntity(
  entity_id: string,
  draft: IdentifierDraft,
  exec: Queryable = pool,
): Promise<{ id: string }> {
  const res = await exec.query<{ id: string }>(
    `INSERT INTO identifiers (entity_id, identifier_type, value, platform, url, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (identifier_type, value, platform) DO UPDATE
       SET entity_id = EXCLUDED.entity_id,
           url = COALESCE(EXCLUDED.url, identifiers.url),
           metadata = identifiers.metadata || EXCLUDED.metadata,
           last_seen = now()
     RETURNING id`,
    [
      entity_id,
      draft.identifier_type,
      draft.value,
      draft.platform,
      draft.url ?? null,
      JSON.stringify(draft.metadata ?? {}),
    ],
  );
  return res.rows[0]!;
}

export async function insertEvidenceSignals(
  args: {
    investigation_id: string;
    entity_id?: string | null;
    source_identifier_id?: string | null;
    collector: string;
    drafts: EvidenceDraft[];
  },
  exec: Queryable = pool,
): Promise<number> {
  for (const draft of args.drafts) {
    await exec.query(
      `INSERT INTO evidence_signals
         (investigation_id, entity_id, source_identifier_id, signal_type, source_platform, collector, raw_data, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'collected')`,
      [
        args.investigation_id,
        args.entity_id ?? null,
        args.source_identifier_id ?? null,
        draft.signal_type,
        draft.source_platform,
        args.collector,
        JSON.stringify(draft.raw_data ?? {}),
      ],
    );
  }
  return args.drafts.length;
}
