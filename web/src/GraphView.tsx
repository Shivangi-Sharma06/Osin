import { useEffect, useRef, useState } from 'react';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import { getEntityGraph } from './api';
import type { GraphResponse } from './types';

const WIDTH = 660;
const HEIGHT = 440;
const MAX_NODES = 40;

interface GNode extends SimulationNodeDatum {
  id: string;
  label: string;
  expanded: boolean;
  isRoot: boolean;
}

interface GLink extends SimulationLinkDatum<GNode> {
  source: string | GNode;
  target: string | GNode;
  shared: string;
  confidence: number;
}

interface GraphState {
  nodes: GNode[];
  links: GLink[];
}

export function GraphView({
  root,
  onClose,
}: {
  root: { id: string; label: string };
  onClose: () => void;
}) {
  const stateRef = useRef<GraphState>({
    nodes: [
      {
        id: root.id,
        label: root.label,
        expanded: false,
        isRoot: true,
        x: WIDTH / 2,
        y: HEIGHT / 2,
      },
    ],
    links: [],
  });
  const simRef = useRef<Simulation<GNode, GLink> | null>(null);
  const [threshold, setThreshold] = useState(40);
  const [showWeak, setShowWeak] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);

  useEffect(() => {
    const sim = forceSimulation<GNode, GLink>(stateRef.current.nodes)
      .force(
        'link',
        forceLink<GNode, GLink>(stateRef.current.links)
          .id((d) => d.id)
          .distance(110)
          .strength(0.35),
      )
      .force('charge', forceManyBody().strength(-280))
      .force('center', forceCenter(WIDTH / 2, HEIGHT / 2))
      .force('collide', forceCollide<GNode>(30))
      .on('tick', () => setTick((t) => t + 1));
    simRef.current = sim;
    return () => {
      sim.stop();
    };
  }, []);

  const reheat = (): void => {
    const sim = simRef.current;
    if (!sim) return;
    sim.nodes(stateRef.current.nodes);
    const linkForce = sim.force('link');
    if (linkForce) {
      (linkForce as ReturnType<typeof forceLink<GNode, GLink>>).links(stateRef.current.links);
    }
    sim.alpha(0.8).restart();
  };

  const expand = async (node: GNode): Promise<void> => {
    if (node.expanded || busy) return;
    const state = stateRef.current;
    if (state.nodes.length >= MAX_NODES) {
      setNotice(`Graph is capped at ${MAX_NODES} simultaneously rendered nodes.`);
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const g: GraphResponse = await getEntityGraph(node.id, 1);
      setThreshold(g.confidence_threshold);

      const byId = new Map<string, GNode>(state.nodes.map((n) => [n.id, n]));
      const src = byId.get(node.id);
      const added: GNode[] = [];
      let capped = false;
      for (const dto of g.nodes) {
        if (byId.has(dto.id)) continue;
        if (state.nodes.length + added.length >= MAX_NODES) {
          capped = true;
          break;
        }
        const fresh: GNode = {
          id: dto.id,
          label: dto.label,
          expanded: false,
          isRoot: false,
          x: (src?.x ?? WIDTH / 2) + (Math.random() - 0.5) * 80,
          y: (src?.y ?? HEIGHT / 2) + (Math.random() - 0.5) * 80,
        };
        added.push(fresh);
        byId.set(dto.id, fresh);
      }

      const seen = new Set(
        state.links.map((l) => [String(l.source), String(l.target), l.shared].sort().join('|')),
      );
      const addedLinks: GLink[] = [];
      for (const e of g.edges) {
        const a = byId.get(e.source);
        const b = byId.get(e.target);
        if (!a || !b) continue;
        const shared = `${e.shared_identifier.identifier_type}: ${e.shared_identifier.value} (${e.shared_identifier.platform})`;
        const key = [e.source, e.target, shared].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        addedLinks.push({ source: e.source, target: e.target, shared, confidence: e.confidence });
      }

      state.nodes = [...state.nodes, ...added];
      state.links = [...state.links, ...addedLinks];
      const expandedNode = byId.get(node.id);
      if (expandedNode) expandedNode.expanded = true;

      if (g.truncated || capped) {
        setNotice('Some connections were omitted (depth / render cap). Keep expanding node by node.');
      }
      reheat();
    } catch (err) {
      setNotice((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const { nodes, links } = stateRef.current;

  return (
    <section className="graph-panel">
      <div className="graph-toolbar">
        <h2>Evidence graph</h2>
        <label className="weak-toggle">
          <input
            type="checkbox"
            checked={showWeak}
            onChange={(e) => setShowWeak(e.target.checked)}
          />
          Show weak edges (&lt; {threshold}%)
        </label>
        <button className="expand-btn" onClick={onClose}>
          Close graph
        </button>
      </div>
      <p className="graph-hint">
        Click a node to fetch and expand its direct connections only. Edges below {threshold}%
        confidence are hidden by default.
      </p>
      {notice && <p className="status">{notice}</p>}
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="graph-svg"
        role="img"
        aria-label="Evidence graph"
      >
        {links.map((l, i) => {
          const s = l.source as GNode;
          const t = l.target as GNode;
          if (typeof s.x !== 'number' || typeof t.x !== 'number') return null;
          const weak = l.confidence < threshold;
          if (weak && !showWeak) return null;
          return (
            <line
              key={i}
              x1={s.x}
              y1={s.y}
              x2={t.x}
              y2={t.y}
              className={weak ? 'edge weak' : 'edge'}
              strokeDasharray={weak ? '4 4' : undefined}
            >
              <title>{`${l.shared} — ${l.confidence}% confidence`}</title>
            </line>
          );
        })}
        {nodes.map((n) => (
          <g
            key={n.id}
            transform={`translate(${n.x ?? 0},${n.y ?? 0})`}
            className={n.expanded ? 'node expanded' : 'node'}
            onClick={() => void expand(n)}
          >
            <circle
              r={n.isRoot ? 18 : 14}
              className={n.isRoot ? 'node-circle root' : 'node-circle'}
            >
              <title>{n.expanded ? n.label : `${n.label} — click to expand connections`}</title>
            </circle>
            <text y={30} textAnchor="middle" className="node-label">
              {n.label}
            </text>
          </g>
        ))}
      </svg>
      {busy && <p className="status">Fetching connections…</p>}
      <div className="graph-legend">
        <span>
          <span className="dot root-dot" /> searched node
        </span>
        <span>
          <span className="dot plain-dot" /> candidate identity (click to expand)
        </span>
        <span>
          <span className="dot edge-dot" /> shared identifier
        </span>
      </div>
    </section>
  );
}
