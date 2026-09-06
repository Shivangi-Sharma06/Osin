import type { GraphResponse, InputType, InvestigationResponse } from './types';

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
