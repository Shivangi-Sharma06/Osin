import type { GraphResponse, InputType, InvestigationResponse, SelfAuditJob } from './types';

const BASE = '/api';

export async function createInvestigation(
  input: string,
  inputType: InputType,
): Promise<string> {
  const res = await fetch(`${BASE}/investigations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input, input_type: inputType }),
  });
  const body = (await res.json()) as { investigation_id?: string; message?: string; error?: string };
  if (!res.ok || !body.investigation_id) {
    throw new Error(body.message ?? body.error ?? `Request failed (HTTP ${res.status})`);
  }
  return body.investigation_id;
}

export async function getInvestigation(id: string): Promise<InvestigationResponse> {
  const res = await fetch(`${BASE}/investigations/${id}`);
  if (!res.ok) throw new Error(`Failed to fetch investigation (HTTP ${res.status})`);
  return (await res.json()) as InvestigationResponse;
}

export async function getEntityGraph(entityId: string, depth = 1): Promise<GraphResponse> {
  const res = await fetch(`${BASE}/entity/${entityId}/graph?depth=${depth}`);
  if (!res.ok) throw new Error(`Failed to fetch graph (HTTP ${res.status})`);
  return (await res.json()) as GraphResponse;
}

export interface ClusterSummaryResponse {
  cluster_id: string;
  summary: string | null;
  model: string | null;
  cached: boolean;
  error: string | null;
}

export async function getClusterSummary(
  clusterId: string,
  refresh = false,
): Promise<ClusterSummaryResponse> {
  const res = await fetch(
    `${BASE}/clusters/${clusterId}/summary${refresh ? '?refresh=1' : ''}`,
  );
  if (!res.ok) throw new Error(`Failed to fetch AI summary (HTTP ${res.status})`);
  return (await res.json()) as ClusterSummaryResponse;
}

export async function createSelfAudit(
  identifiers: Array<{ input: string; input_type: InputType }>,
): Promise<SelfAuditJob[]> {
  const res = await fetch(`${BASE}/self-audit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifiers }),
  });
  const body = (await res.json()) as { jobs?: SelfAuditJob[]; message?: string; error?: string };
  if (!res.ok || !body.jobs) {
    throw new Error(body.message ?? body.error ?? `Request failed (HTTP ${res.status})`);
  }
  return body.jobs;
}
