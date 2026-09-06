/**
 * Task 1 done-when check: inserts a dummy row into every table (inside a
 * transaction), queries each back, then ROLLBACKs so the database stays clean.
 */
import { pool } from './pool.js';

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dummy = `osin_verify_${Date.now()}`;

    const inv = await client.query<{ id: string }>(
      `INSERT INTO investigations (input_type, input_value)
       VALUES ('username', $1) RETURNING id`,
      [dummy],
    );
    const invId = inv.rows[0]!.id;

    const ent = await client.query<{ id: string }>(
      `INSERT INTO entities (investigation_id, entity_type, label)
       VALUES ($1, 'person', $2) RETURNING id`,
      [invId, dummy],
    );
    const entId = ent.rows[0]!.id;

    const ident = await client.query<{ id: string }>(
      `INSERT INTO identifiers (entity_id, identifier_type, value, platform, url, metadata)
       VALUES ($1, 'username', $2, 'github', $3, $4::jsonb) RETURNING id`,
      [entId, dummy, `https://github.com/${dummy}`, JSON.stringify({ source: 'verify' })],
    );
    const identId = ident.rows[0]!.id;

    const cluster = await client.query<{ id: string }>(
      `INSERT INTO match_clusters (investigation_id, primary_entity_id, score, explanation)
       VALUES ($1, $2, 42, $3::jsonb) RETURNING id`,
      [
        invId,
        entId,
        JSON.stringify([
          { signal_type: 'self_check', points: 42, human_readable_reason: 'verification dummy' },
        ]),
      ],
    );
    const clusterId = cluster.rows[0]!.id;

    await client.query(
      `INSERT INTO evidence_signals
         (investigation_id, cluster_id, entity_id, source_identifier_id,
          signal_type, source_platform, collector, raw_data, status)
       VALUES ($1, $2, $3, $4, 'platform_profile_exists', 'github', 'verify', $5::jsonb, 'scored')`,
      [invId, clusterId, entId, identId, JSON.stringify({ ok: true })],
    );

    await client.query(
      `INSERT INTO snapshots (entity_id, url, source, captured_at, data)
       VALUES ($1, $2, 'wayback', now(), $3::jsonb)`,
      [entId, `https://example.com/${dummy}`, JSON.stringify({ status: 200 })],
    );

    await client.query(
      `INSERT INTO audit_log (investigation_id, actor, action, subject, status_code, details)
       VALUES ($1, 'verify', 'self_check', $2, 200, $3::jsonb)`,
      [invId, dummy, JSON.stringify({ ok: true })],
    );

    const tables = [
      'investigations',
      'entities',
      'identifiers',
      'match_clusters',
      'evidence_signals',
      'snapshots',
      'audit_log',
    ] as const;
    for (const table of tables) {
      const res = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table}`,
      );
      console.log(`verify: ${table.padEnd(17)} insert+query OK (rows in tx: ${res.rows[0]!.count})`);
    }

    await client.query('ROLLBACK');
    console.log('ALL TABLES VERIFIED (transaction rolled back — no dummy rows persisted)');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('VERIFY FAILED:', err);
  process.exit(1);
});
