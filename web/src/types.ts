export type InputType = 'username' | 'name' | 'phone' | 'email';

export interface ExplanationEntry {
  signal_type: string;
  points: number;
  human_readable_reason: string;
}

export interface MatchedIdentifier {
  identifier_type: string;
  value: string;
  platform: string;
  url: string | null;
}

export interface ClusterResult {
  cluster_id: string;
  score: number;
  status: string;
  explanation: ExplanationEntry[];
  primary_entity: { id: string; label: string } | null;
  matched_identifiers: MatchedIdentifier[];
}

export interface InvestigationResponse {
  id: string;
  input_type: string;
  input_value: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  error: string | null;
  results: ClusterResult[] | null;
}

export interface GraphSharedIdentifier {
  identifier_type: string;
  value: string;
  platform: string;
}

export interface GraphNodeDTO {
  id: string;
  label: string;
  entity_type: string;
  investigation_id: string | null;
  identifiers: Array<{ identifier_type: string; value: string; platform: string; url: string | null }>;
}

export interface GraphEdgeDTO {
  source: string;
  target: string;
  shared_identifier: GraphSharedIdentifier;
  confidence: number;
}

export interface GraphResponse {
  nodes: GraphNodeDTO[];
  edges: GraphEdgeDTO[];
  depth: number;
  truncated: boolean;
  confidence_threshold: number;
}
