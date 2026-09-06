import { pool, type Queryable } from '../db/pool.js';

export interface AuditEntry {
  investigation_id?: string | null;
  actor: string;
  action: string;
  subject?: string | null;
  status_code?: number | null;
  details?: Record<string, unknown>;
}

/** Append-only audit write; every collector HTTP call must land here. */
export async function recordAudit(entry: AuditEntry, exec: Queryable = pool): Promise<void> {
  await exec.query(
    `INSERT INTO audit_log (investigation_id, actor, action, subject, status_code, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      entry.investigation_id ?? null,
      entry.actor,
      entry.action,
      entry.subject ?? null,
      entry.status_code ?? null,
      JSON.stringify(entry.details ?? {}),
    ],
  );
}
