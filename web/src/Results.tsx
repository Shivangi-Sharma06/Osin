import { useState } from 'react';
import type { ClusterResult, InvestigationResponse } from './types';

function scoreBand(score: number): 'high' | 'medium' | 'low' {
  if (score >= 75) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

function Cluster({
  cluster,
  onOpenGraph,
}: {
  cluster: ClusterResult;
  onOpenGraph: (entity: { id: string; label: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const band = scoreBand(cluster.score);
  return (
    <article className={`cluster band-${band}`}>
      <div className="cluster-head">
        <div className="score" aria-label={`Confidence ${Math.round(cluster.score)} percent`}>
          {Math.round(cluster.score)}
          <span className="score-pct">%</span>
        </div>
        <div className="cluster-title">
          <strong>{cluster.primary_entity?.label ?? 'Unknown entity'}</strong>
          <span className={`confidence confidence-${band}`}>{band} confidence</span>
        </div>
        <div className="cluster-actions">
          {cluster.primary_entity && (
            <button
              className="expand-btn"
              onClick={() => onOpenGraph(cluster.primary_entity!)}
            >
              Evidence graph
            </button>
          )}
          <button className="expand-btn" onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide explanation' : 'Why this score?'}
          </button>
        </div>
      </div>

      {open && (
        <div className="explanation">
          <ol className="explanation-list">
            {cluster.explanation.map((e, i) => (
              <li
                key={i}
                className={e.points < 0 ? 'negative' : e.points > 0 ? 'positive' : 'neutral'}
              >
                <span className="points">{e.points > 0 ? `+${e.points}` : e.points}</span>
                <span className="signal">{e.signal_type}</span>
                <span className="reason">{e.human_readable_reason}</span>
              </li>
            ))}
          </ol>
          <div className="identifier-chips">
            {cluster.matched_identifiers.map((m, i) => (
              <span className="chip" key={i}>
                {m.identifier_type}: <strong>{m.value}</strong> ({m.platform})
                {m.url && (
                  <a href={m.url} target="_blank" rel="noreferrer">
                    ↗
                  </a>
                )}
              </span>
            ))}
          </div>
        </div>
      )}
    </article>
  );
}

export function Results({
  result,
  onOpenGraph,
}: {
  result: InvestigationResponse;
  onOpenGraph: (entity: { id: string; label: string }) => void;
}) {
  if (result.status === 'failed') {
    return (
      <p className="status error">
        Investigation failed: {result.error ?? 'unknown error'}
      </p>
    );
  }
  const clusters = result.results ?? [];
  if (clusters.length === 0) {
    return <p className="status">No public traces found for “{result.input_value}”. Try another identifier.</p>;
  }
  return (
    <section className="results">
      <h2>Results for “{result.input_value}”</h2>
      {clusters.map((c) => (
        <Cluster key={c.cluster_id} cluster={c} onOpenGraph={onOpenGraph} />
      ))}
    </section>
  );
}
