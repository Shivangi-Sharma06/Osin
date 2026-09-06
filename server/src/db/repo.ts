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
 * Insert-or-update an identifier for a specific entity, keyed by
 * (identifier_type, value, platform, entity_id). Two entities may carry the
 * SAME observable — that shared observable is what draws an evidence-graph
 * edge between them (Task 6).
 */
export async function upsertIdentifierForEntity(
  entity_id: string,
  draft: IdentifierDraft,
  exec: Queryable = pool,
): Promise<{ id: string }> {
  const res = await exec.query<{ id: string }>(
    `INSERT INTO identifiers (entity_id, identifier_type, value, platform, url, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (identifier_type, value, platform, entity_id) DO UPDATE
       SET url = COALESCE(EXCLUDED.url, identifiers.url),
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

// ---- Evidence graph (Task 6): depth-limited recursive CTE, never a full dump ----

export interface GraphNode {
  id: string;
  label: string;
  entity_type: string;
  investigation_id: string | null;
  identifiers: Array<{ identifier_type: string; value: string; platform: string; url: string | null }>;
}

export interface GraphEdge {
  source: string;
  target: string;
  shared_identifier: { identifier_type: string; value: string; platform: string };
  confidence: number;
}

export interface EntityGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  depth: number;
  truncated: boolean;
}

export async function getEntityGraph(
  rootEntityId: string,
  depth: number,
  limit: number,
  exec: Queryable = pool,
): Promise<EntityGraph> {
  // Depth-limited walk across shared identifiers. UNION (not ALL) prevents
  // cycles; DISTINCT + LIMIT keeps the payload bounded (progressive disclosure).
  const { rows: idRows } = await exec.query<{ entity_id: string }>(
    `WITH RECURSIVE nearby(entity_id, d) AS (
        SELECT $1::uuid, 0
      UNION
        SELECT i2.entity_id, nearby.d + 1
        FROM nearby
        JOIN identifiers i1 ON i1.entity_id = nearby.entity_id
        JOIN identifiers i2 ON i2.identifier_type = i1.identifier_type
           AND i2.value = i1.value
           AND i2.platform = i1.platform
           AND i2.entity_id <> nearby.entity_id
        WHERE nearby.d < $2::int
      )
      SELECT DISTINCT entity_id FROM nearby LIMIT $3::int`,
    [rootEntityId, depth, limit],
  );
  const { rows: countRows } = await exec.query<{ total: string }>(
    `WITH RECURSIVE nearby(entity_id, d) AS (
        SELECT $1::uuid, 0
      UNION
        SELECT i2.entity_id, nearby.d + 1
        FROM nearby
        JOIN identifiers i1 ON i1.entity_id = nearby.entity_id
        JOIN identifiers i2 ON i2.identifier_type = i1.identifier_type
           AND i2.value = i1.value
           AND i2.platform = i1.platform
           AND i2.entity_id <> nearby.entity_id
        WHERE nearby.d < $2::int
      )
      SELECT count(DISTINCT entity_id)::text AS total FROM nearby`,
    [rootEntityId, depth],
  );

  const entityIds = idRows.map((r) => r.entity_id);
  if (entityIds.length === 0) {
    return { nodes: [], edges: [], depth, truncated: false };
  }

  const nodesRes = await exec.query<{
    id: string;
    label: string;
    entity_type: string;
    investigation_id: string | null;
  }>(
    `SELECT id, label, entity_type, investigation_id FROM entities WHERE id = ANY($1::uuid[])`,
    [entityIds],
  );
  const identsRes = await exec.query<{
    entity_id: string;
    identifier_type: string;
    value: string;
    platform: string;
    url: string | null;
  }>(
    `SELECT entity_id, identifier_type, value, platform, url FROM identifiers
     WHERE entity_id = ANY($1::uuid[]) ORDER BY identifier_type, value`,
    [entityIds],
  );

  const nodes: GraphNode[] = nodesRes.rows.map((n) => ({
    id: n.id,
    label: n.label,
    entity_type: n.entity_type,
    investigation_id: n.investigation_id,
    identifiers: identsRes.rows
      .filter((i) => i.entity_id === n.id)
      .map((i) => ({
        identifier_type: i.identifier_type,
        value: i.value,
        platform: i.platform,
        url: i.url,
      })),
  }));

  // Edges = entities in the set sharing an observable identifier.
  const sharedRes = await exec.query<{
    source: string;
    target: string;
    identifier_type: string;
    value: string;
    platform: string;
  }>(
    `SELECT i1.entity_id AS source, i2.entity_id AS target,
            i1.identifier_type, i1.value, i1.platform
     FROM identifiers i1
     JOIN identifiers i2
       ON i2.identifier_type = i1.identifier_type
      AND i2.value = i1.value
      AND i2.platform = i1.platform
      AND i2.entity_id <> i1.entity_id
     WHERE i1.entity_id = ANY($1::uuid[]) AND i2.entity_id = ANY($1::uuid[])`,
    [entityIds],
  );

  // Edge confidence is limited by the weaker endpoint's best cluster score.
  const scoreRes = await exec.query<{ entity_id: string; best: string }>(
    `SELECT primary_entity_id AS entity_id, MAX(score)::text AS best
     FROM match_clusters
     WHERE primary_entity_id = ANY($1::uuid[])
     GROUP BY primary_entity_id`,
    [entityIds],
  );
  const bestScore = new Map(scoreRes.rows.map((r) => [r.entity_id, Number(r.best)]));

  const edges: GraphEdge[] = [];
  const seenPairs = new Set<string>();
  for (const row of sharedRes.rows) {
    const key = [row.source, row.target].sort().join('|');
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    const confidence = Math.min(bestScore.get(row.source) ?? 0, bestScore.get(row.target) ?? 0);
    edges.push({
      source: row.source,
      target: row.target,
      shared_identifier: {
        identifier_type: row.identifier_type,
        value: row.value,
        platform: row.platform,
      },
      confidence,
    });
  }

  const total = Number(countRows[0]?.total ?? entityIds.length);
  return {
    nodes,
    edges,
    depth,
    truncated: total > entityIds.length,
  };
}

// ---- Cluster AI summary (Task 8) ----

export interface ClusterForSummary {
  id: string;
  score: number;
  explanation: Array<{ signal_type: string; points: number; human_readable_reason: string }>;
  ai_summary: string | null;
  ai_summary_model: string | null;
  input_type: string;
  input_value: string;
}

export async function getClusterForSummary(
  cluster_id: string,
  exec: Queryable = pool,
): Promise<ClusterForSummary | null> {
  const res = await exec.query<
    ClusterForSummary & Record<string, unknown>
  >(
    `SELECT c.id, c.score::text AS score, c.explanation, c.ai_summary, c.ai_summary_model,
            i.input_type, i.input_value
     FROM match_clusters c
     JOIN investigations i ON i.id = c.investigation_id
     WHERE c.id = $1`,
    [cluster_id],
  );
  const row = res.rows[0];
  if (!row) return null;
  return { ...row, score: Number(row.score) };
}

export async function saveClusterSummary(
  cluster_id: string,
  summary: string,
  model: string,
  exec: Queryable = pool,
): Promise<void> {
  await exec.query(
    `UPDATE match_clusters
     SET ai_summary = $2, ai_summary_model = $3, ai_summary_at = now()
     WHERE id = $1`,
    [cluster_id, summary, model],
  );
}

export interface EntityTimeline {
  entity_id: string;
  snapshots: Array<{
    id: string;
    url: string;
    source: string;
    captured_at: Date;
    data: Record<string, unknown>;
  }>;
  current_observations: Array<{
    platform: string;
    value: string;
    url: string | null;
    first_seen: Date;
    last_seen: Date;
    metadata: Record<string, unknown>;
  }>;
}

export async function getEntityTimeline(
  entity_id: string,
  exec: Queryable = pool,
): Promise<EntityTimeline | null> {
  const exists = await exec.query<{ id: string }>('SELECT id FROM entities WHERE id = $1', [entity_id]);
  if (!exists.rows[0]) return null;
  const snapshots = await exec.query<EntityTimeline['snapshots'][number]>(
    `SELECT id, url, source, captured_at, data FROM snapshots
     WHERE entity_id = $1 ORDER BY captured_at DESC LIMIT 50`,
    [entity_id],
  );
  const current = await exec.query<EntityTimeline['current_observations'][number]>(
    `SELECT platform, value, url, first_seen, last_seen, metadata
     FROM identifiers WHERE entity_id = $1 ORDER BY last_seen DESC LIMIT 50`,
    [entity_id],
  );
  return { entity_id, snapshots: snapshots.rows, current_observations: current.rows };
}
