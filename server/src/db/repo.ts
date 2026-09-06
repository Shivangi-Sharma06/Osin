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

export async function createMatchCluster(
  args: {
    investigation_id: string;
    primary_entity_id: string;
    score: number;
    explanation: unknown;
  },
  exec: Queryable = pool,
): Promise<{ id: string }> {
  const res = await exec.query<{ id: string }>(
    `INSERT INTO match_clusters (investigation_id, primary_entity_id, score, explanation, status)
     VALUES ($1, $2, $3, $4::jsonb, 'finalized') RETURNING id`,
    [args.investigation_id, args.primary_entity_id, args.score, JSON.stringify(args.explanation)],
  );
  return res.rows[0]!;
}

/** Evidence only becomes user-visible once attached to a scored cluster. */
export async function attachEvidenceToCluster(
  investigation_id: string,
  cluster_id: string,
  exec: Queryable = pool,
): Promise<void> {
  await exec.query(
    `UPDATE evidence_signals SET cluster_id = $2, status = 'scored'
     WHERE investigation_id = $1`,
    [investigation_id, cluster_id],
  );
}

export interface ClusterResult {
  cluster_id: string;
  score: number;
  status: string;
  explanation: Array<{ signal_type: string; points: number; human_readable_reason: string }>;
  primary_entity: { id: string; label: string } | null;
  matched_identifiers: Array<{
    identifier_type: string;
    value: string;
    platform: string;
    url: string | null;
  }>;
}

export async function getInvestigationResults(
  investigation_id: string,
  exec: Queryable = pool,
): Promise<ClusterResult[]> {
  const clusters = await exec.query<{
    cluster_id: string;
    score: string;
    status: string;
    explanation: ClusterResult['explanation'];
    entity_id: string | null;
    entity_label: string | null;
  }>(
    `SELECT c.id AS cluster_id, c.score::text AS score, c.status, c.explanation,
            e.id AS entity_id, e.label AS entity_label
     FROM match_clusters c
     LEFT JOIN entities e ON e.id = c.primary_entity_id
     WHERE c.investigation_id = $1
     ORDER BY c.score DESC, c.created_at ASC`,
    [investigation_id],
  );

  const results: ClusterResult[] = [];
  for (const row of clusters.rows) {
    let matched: ClusterResult['matched_identifiers'] = [];
    if (row.entity_id) {
      const idents = await exec.query<{
        identifier_type: string;
        value: string;
        platform: string;
        url: string | null;
      }>(
        `SELECT identifier_type, value, platform, url FROM identifiers
         WHERE entity_id = $1 ORDER BY identifier_type, value`,
        [row.entity_id],
      );
      matched = idents.rows;
    }
    results.push({
      cluster_id: row.cluster_id,
      score: Number(row.score),
      status: row.status,
      explanation: row.explanation ?? [],
      primary_entity: row.entity_id
        ? { id: row.entity_id, label: row.entity_label ?? '' }
        : null,
      matched_identifiers: matched,
    });
  }
  return results;
}

export async function listInvestigations(
  limit = 50,
  exec: Queryable = pool,
): Promise<Array<Pick<InvestigationRow, 'id' | 'input_type' | 'input_value' | 'status' | 'created_at'>>> {
  const res = await exec.query<
    Pick<InvestigationRow, 'id' | 'input_type' | 'input_value' | 'status' | 'created_at'>
  >(
    `SELECT id, input_type, input_value, status, created_at FROM investigations
     ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return res.rows;
}
