/**
 * Task 2 done-when check: runs the real GitHub collector against a real
 * username, persists normalized output, and prints the identifiers + audit rows.
 *
 * Usage: npm run check:github -- [username]
 */
import { pool } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  createEntity,
  createInvestigation,
  insertEvidenceSignals,
  updateInvestigationStatus,
  upsertIdentifierForEntity,
} from '../src/db/repo.js';
import { GithubCollector } from '../src/collectors/github.js';

async function main(): Promise<void> {
  await runMigrations();
  const input = process.argv[2] ?? 'torvalds';

  const collector = new GithubCollector();
  console.log(
    `collector platform=${collector.platform} enabled=${collector.isEnabled()} rpm=${collector.rateLimitPerMinute}`,
  );

  const inv = await createInvestigation('username', input, 'running');
  console.log(`investigation=${inv.id} (status=running)`);

  const result = await collector.fetch({
    input_type: 'username',
    input_value: input,
    investigation_id: inv.id,
  });

  console.log('=== normalized collector result ===');
  console.log(
    JSON.stringify(
      {
        collector: result.collector,
        platform: result.platform,
        input_type: result.input_type,
        input_value: result.input_value,
        found: result.found,
        unavailable_reason: result.unavailable_reason,
        duration_ms: result.duration_ms,
        identifiers: result.identifiers,
        evidence: result.evidence,
      },
      null,
      2,
    ),
  );

  try {
    if (!result.found) {
      console.log(`collector found nothing (${result.unavailable_reason}) — nothing persisted except audit rows`);
      await updateInvestigationStatus(inv.id, 'completed');
      return;
    }

    const entity = await createEntity(inv.id, 'person', input);
    for (const draft of result.identifiers) {
      await upsertIdentifierForEntity(entity.id, draft);
    }
    await insertEvidenceSignals({
      investigation_id: inv.id,
      entity_id: entity.id,
      collector: result.collector,
      drafts: result.evidence,
    });

    const dbIdents = await pool.query(
      `SELECT identifier_type, value, platform, url FROM identifiers
       WHERE entity_id = $1 ORDER BY identifier_type, value`,
      [entity.id],
    );
    const dbEvidence = await pool.query(
      `SELECT signal_type, source_platform, collector, status FROM evidence_signals
       WHERE investigation_id = $1`,
      [inv.id],
    );
    const dbAudit = await pool.query(
      `SELECT actor, action, subject, status_code FROM audit_log
       WHERE investigation_id = $1 ORDER BY id`,
      [inv.id],
    );

    console.log('=== identifiers persisted (matches identifiers schema) ===');
    console.table(dbIdents.rows);
    console.log('=== evidence_signals persisted ===');
    console.table(dbEvidence.rows);
    console.log('=== audit_log rows for this investigation ===');
    console.table(dbAudit.rows);

    await updateInvestigationStatus(inv.id, 'completed');
    console.log(
      `CHECK OK: investigation=${inv.id} identifiers=${dbIdents.rows.length} ` +
        `evidence=${dbEvidence.rows.length} audit_rows=${dbAudit.rows.length}`,
    );
  } catch (err) {
    await updateInvestigationStatus(inv.id, 'failed', (err as Error).message);
    throw err;
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('CHECK FAILED:', err);
  process.exit(1);
});
