import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChevronRight, Eye, GitBranch, RefreshCw, Search, ShieldCheck } from "lucide-react";
import "./styles.css";

type LookupScope = "self_audit" | "consented" | "public_figure";

type ExplanationItem = {
  signal_type: string;
  points: number;
  human_readable_reason: string;
  raw_score: number;
  weight: number;
};

type Cluster = {
  confidence_score: number;
  explanation_json: ExplanationItem[];
  computed_at: string;
};

type GraphNode = {
  id: string;
  kind: "entity" | "identifier";
  label: string;
  entity_id: number;
  platform?: string;
  handle?: string;
  source_url?: string;
  raw_profile_json?: Record<string, unknown>;
};

type GraphEdge = {
  id: string;
  source: string;
  target: string;
  confidence: number;
  label: string;
};

type SearchResponse = {
  entity: { id: number; canonical_name: string; type: string };
  identifiers: Array<Record<string, unknown>>;
  cluster: Cluster;
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
};

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";

function App() {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<LookupScope>("self_audit");
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [graph, setGraph] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] }>({ nodes: [], edges: [] });
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [includeLowConfidence, setIncludeLowConfidence] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function runSearch(event?: React.FormEvent) {
    event?.preventDefault();
    setLoading(true);
    setError("");
    setSelectedNode(null);
    try {
      const response = await fetch(`${API_BASE}/api/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, lookup_scope: scope }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail ?? "Search failed.");
      setResult(payload);
      setGraph(payload.graph);
      setSelectedNode(payload.graph.nodes[0] ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed.");
    } finally {
      setLoading(false);
    }
  }

  async function expandGraph(depth = 1, nextIncludeLowConfidence = includeLowConfidence) {
    if (!result) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(
        `${API_BASE}/api/entity/${result.entity.id}/graph?depth=${depth}&include_low_confidence=${nextIncludeLowConfidence}`,
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail ?? "Could not expand graph.");
      setGraph(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not expand graph.");
    } finally {
      setLoading(false);
    }
  }

  const confidence = result?.cluster.confidence_score ?? 0;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">novi</p>
          <h1>Evidence-first identity correlation</h1>
        </div>
        <div className="status-pill">
          <ShieldCheck size={18} />
          GitHub API only
        </div>
      </header>

      <section className="lookup-band">
        <form className="lookup-form" onSubmit={runSearch}>
          <div className="field">
            <label htmlFor="query">GitHub handle</label>
            <div className="input-row">
              <Search size={20} />
              <input
                id="query"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="octocat"
                autoComplete="off"
              />
            </div>
          </div>

          <div className="field">
            <label>Lookup scope</label>
            <div className="segmented">
              {[
                ["self_audit", "Self-audit"],
                ["consented", "Consented"],
                ["public_figure", "Public figure"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={scope === value ? "active" : ""}
                  onClick={() => setScope(value as LookupScope)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <button className="primary-btn" disabled={loading || !query.trim()}>
            {loading ? <RefreshCw className="spin" size={18} /> : <Eye size={18} />}
            Audit
          </button>
        </form>
        {error ? <p className="error">{error}</p> : null}
      </section>

      <section className="workspace">
        <GraphPanel
          graph={graph}
          confidence={confidence}
          selectedNode={selectedNode}
          onSelect={setSelectedNode}
          onExpand={() => expandGraph(1)}
          includeLowConfidence={includeLowConfidence}
          onToggleLowConfidence={() => {
            const nextValue = !includeLowConfidence;
            setIncludeLowConfidence(nextValue);
            if (result) expandGraph(1, nextValue);
          }}
        />
        <DetailPanel result={result} selectedNode={selectedNode} />
      </section>
    </main>
  );
}

function GraphPanel({
  graph,
  confidence,
  selectedNode,
  onSelect,
  onExpand,
  includeLowConfidence,
  onToggleLowConfidence,
}: {
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  confidence: number;
  selectedNode: GraphNode | null;
  onSelect: (node: GraphNode) => void;
  onExpand: () => void;
  includeLowConfidence: boolean;
  onToggleLowConfidence: () => void;
}) {
  const positioned = useMemo(() => layoutNodes(graph.nodes), [graph.nodes]);

  return (
    <section className="graph-surface">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Evidence graph</p>
          <h2>{graph.nodes.length ? `${graph.nodes.length} rendered node${graph.nodes.length === 1 ? "" : "s"}` : "Ready"}</h2>
        </div>
        <div className="toolbar">
          <label className="toggle">
            <input type="checkbox" checked={includeLowConfidence} onChange={onToggleLowConfidence} />
            <span>Low confidence</span>
          </label>
          <button className="icon-text-btn" onClick={onExpand} disabled={!graph.nodes.length}>
            <GitBranch size={18} />
            Expand
          </button>
        </div>
      </div>

      <svg className="graph-canvas" viewBox="0 0 760 460" role="img" aria-label="Evidence graph">
        <defs>
          <linearGradient id="edgeGradient" x1="0" x2="1">
            <stop offset="0%" stopColor="#1b998b" />
            <stop offset="100%" stopColor="#3867d6" />
          </linearGradient>
        </defs>
        {graph.edges.map((edge) => {
          const source = positioned.find((node) => node.id === edge.source);
          const target = positioned.find((node) => node.id === edge.target);
          if (!source || !target) return null;
          return (
            <g key={edge.id}>
              <line x1={source.x} y1={source.y} x2={target.x} y2={target.y} className="edge" />
              <text x={(source.x + target.x) / 2} y={(source.y + target.y) / 2 - 10} className="edge-label">
                {Math.round(edge.confidence)}%
              </text>
            </g>
          );
        })}
        {positioned.map((node) => (
          <g
            key={node.id}
            className={`graph-node ${node.kind} ${selectedNode?.id === node.id ? "selected" : ""}`}
            onClick={() => onSelect(node)}
            tabIndex={0}
          >
            <circle cx={node.x} cy={node.y} r={node.kind === "entity" ? 48 : 38} />
            <text x={node.x} y={node.y - 4}>
              {trimLabel(node.label, 18)}
            </text>
            <text x={node.x} y={node.y + 17} className="node-meta">
              {node.kind === "entity" ? `${Math.round(confidence)}%` : node.platform}
            </text>
          </g>
        ))}
      </svg>
    </section>
  );
}

function DetailPanel({ result, selectedNode }: { result: SearchResponse | null; selectedNode: GraphNode | null }) {
  const explanation = result?.cluster.explanation_json ?? [];
  const profile = selectedNode?.raw_profile_json ?? {};

  return (
    <aside className="detail-panel">
      <div className="panel-header compact">
        <div>
          <p className="eyebrow">Confidence</p>
          <h2>{result ? `${result.cluster.confidence_score}%` : "No scan yet"}</h2>
        </div>
      </div>

      {selectedNode ? (
        <div className="node-detail">
          <p className="label">Selected node</p>
          <h3>{selectedNode.label}</h3>
          {selectedNode.source_url ? (
            <a href={selectedNode.source_url} target="_blank" rel="noreferrer">
              Open source URL <ChevronRight size={16} />
            </a>
          ) : null}
          {"created_at" in profile ? <p>GitHub created: {String(profile.created_at)}</p> : null}
          {"location" in profile && profile.location ? <p>Location: {String(profile.location)}</p> : null}
          {"company" in profile && profile.company ? <p>Company: {String(profile.company)}</p> : null}
        </div>
      ) : (
        <p className="muted">Search a public GitHub handle to create the first entity node.</p>
      )}

      <div className="explanation-list">
        {explanation.map((item) => (
          <article className="explanation-item" key={item.signal_type}>
            <div>
              <p className="label">{item.signal_type.replaceAll("_", " ")}</p>
              <strong>{item.points.toFixed(2)} pts</strong>
            </div>
            <p>{item.human_readable_reason}</p>
          </article>
        ))}
      </div>
    </aside>
  );
}

function layoutNodes(nodes: GraphNode[]) {
  if (nodes.length <= 1) {
    return nodes.map((node) => ({ ...node, x: 380, y: 230 }));
  }
  const [root, ...rest] = nodes;
  const radius = 150;
  return [
    { ...root, x: 380, y: 230 },
    ...rest.map((node, index) => {
      const angle = (index / rest.length) * Math.PI * 2 - Math.PI / 2;
      return {
        ...node,
        x: 380 + Math.cos(angle) * radius,
        y: 230 + Math.sin(angle) * radius,
      };
    }),
  ];
}

function trimLabel(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

createRoot(document.getElementById("root")!).render(<App />);
