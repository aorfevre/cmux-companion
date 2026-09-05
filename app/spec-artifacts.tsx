"use client";

import { useId } from "react";

// Every string in these artifacts comes from a planner model. The renderers
// therefore treat all of it as untrusted text: it reaches the DOM only as a
// React child. No dangerouslySetInnerHTML, no artifact-provided href, no
// artifact-provided style, and no artifact-provided coordinate. Geometry and
// marker identifiers are computed here, so a hostile label can change what a
// diagram says and nothing else.

export type FlowNodeKind = "start" | "step" | "decision" | "end";
export type FlowNode = { id: string; label: string; kind?: FlowNodeKind | string };
export type FlowEdge = { from: string; to: string; label?: string };
export type ScreenElementChange = "added" | "changed" | "removed" | "unchanged";
export type ScreenElementKind = "header" | "text" | "input" | "button" | "list" | "image" | "note";
export type ScreenElement = { id: string; label: string; kind?: ScreenElementKind | string; change?: ScreenElementChange | string; note?: string };
export type ScreenData = { name: string; elements?: ScreenElement[] };
export type FlowArtifactData = { id: string; kind: "flow"; title?: string; summary?: string; nodes?: FlowNode[]; edges?: FlowEdge[] };
export type ScreenArtifactData = { id: string; kind: "screen"; title?: string; summary?: string; screen?: ScreenData };
export type DesignArtifact = FlowArtifactData | ScreenArtifactData;

const NODE_WIDTH = 168;
const NODE_HEIGHT = 56;
const GAP_X = 26;
const GAP_Y = 60;
const PADDING = 14;
const LINE_LENGTH = 22;
const LINE_COUNT = 2;
const EDGE_LABEL_LENGTH = 24;

const CHANGE_LABELS: Record<string, string> = { added: "Added", changed: "Changed", removed: "Removed", unchanged: "Unchanged" };

type PlacedNode = { node: FlowNode; layer: number; column: number; x: number; y: number };

// Layers come from the edges, not from a physics pass, so the same artifact
// always draws the same picture. A cycle has no topological order, so its
// members are placed after the resolvable nodes instead of being dropped or
// looped over forever.
export function flowLayout(nodeValues: FlowNode[], edgeValues: FlowEdge[]) {
  const nodes = nodeValues.filter((node) => node && typeof node.id === "string" && node.id !== "");
  const known = new Set(nodes.map((node) => node.id));
  const edges = edgeValues.filter((edge) => edge && known.has(edge.from) && known.has(edge.to));
  const layerById = new Map<string, number>();
  // A self edge never blocks its own node, and a duplicated edge adds nothing.
  const incoming = new Map<string, string[]>(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    const sources = incoming.get(edge.to);
    if (sources && !sources.includes(edge.from)) sources.push(edge.from);
  }

  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const node of nodes) {
      if (layerById.has(node.id)) continue;
      const sources = incoming.get(node.id) || [];
      if (!sources.every((source) => layerById.has(source))) continue;
      const layer = sources.length ? Math.max(...sources.map((source) => layerById.get(source) as number)) + 1 : 0;
      layerById.set(node.id, layer);
      progressed = true;
    }
  }

  // Whatever is left sits on a cycle. Each remaining node takes its own
  // fallback row, in input order, below every resolved layer.
  let fallback = layerById.size ? Math.max(...layerById.values()) + 1 : 0;
  for (const node of nodes) {
    if (layerById.has(node.id)) continue;
    layerById.set(node.id, fallback);
    fallback += 1;
  }

  const counters = new Map<number, number>();
  const placed: PlacedNode[] = nodes.map((node) => {
    const layer = layerById.get(node.id) as number;
    const column = counters.get(layer) || 0;
    counters.set(layer, column + 1);
    return { node, layer, column, x: PADDING + column * (NODE_WIDTH + GAP_X), y: PADDING + layer * (NODE_HEIGHT + GAP_Y) };
  });
  const widest = placed.reduce((total, item) => Math.max(total, item.column + 1), 0);
  const rows = placed.reduce((total, item) => Math.max(total, item.layer + 1), 0);
  return {
    placed,
    edges,
    width: Math.max(PADDING * 2 + NODE_WIDTH, PADDING * 2 + widest * NODE_WIDTH + Math.max(0, widest - 1) * GAP_X),
    height: Math.max(PADDING * 2 + NODE_HEIGHT, PADDING * 2 + rows * NODE_HEIGHT + Math.max(0, rows - 1) * GAP_Y),
  };
}

// Long labels are wrapped, then the overflow is cut. A word longer than one
// line is cut rather than left to escape its box.
export function wrapLabel(text: string) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= LINE_LENGTH) { current = candidate; continue; }
    if (current) lines.push(current);
    current = word.length > LINE_LENGTH ? `${word.slice(0, LINE_LENGTH - 1)}…` : word;
    if (lines.length >= LINE_COUNT) break;
  }
  if (current && lines.length < LINE_COUNT) lines.push(current);
  if (!lines.length) return ["Untitled step"];
  return lines.slice(0, LINE_COUNT);
}

function truncate(text: string, limit: number) {
  const value = String(text || "").trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}

function anchors(from: PlacedNode, to: PlacedNode) {
  if (to.y > from.y) return { x1: from.x + NODE_WIDTH / 2, y1: from.y + NODE_HEIGHT, x2: to.x + NODE_WIDTH / 2, y2: to.y };
  if (to.y < from.y) return { x1: from.x + NODE_WIDTH / 2, y1: from.y, x2: to.x + NODE_WIDTH / 2, y2: to.y + NODE_HEIGHT };
  if (to.x >= from.x) return { x1: from.x + NODE_WIDTH, y1: from.y + NODE_HEIGHT / 2, x2: to.x, y2: to.y + NODE_HEIGHT / 2 };
  return { x1: from.x, y1: from.y + NODE_HEIGHT / 2, x2: to.x + NODE_WIDTH, y2: to.y + NODE_HEIGHT / 2 };
}

export function FlowArtifact({ artifact }: { artifact: FlowArtifactData }) {
  // The marker id must be unique per rendered diagram, and it must not come
  // from the artifact. React supplies one that is stable across renders.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const arrowId = `flow-arrow-${uid}`;
  const layout = flowLayout(artifact.nodes || [], artifact.edges || []);
  if (!layout.placed.length) return null;
  const title = artifact.title || "Flow";
  const byId = new Map(layout.placed.map((item) => [item.node.id, item]));
  return <figure className="spec-flow">
    <figcaption><span className="spec-artifact-kind">Flow</span><strong>{title}</strong></figcaption>
    {artifact.summary ? <p className="spec-artifact-summary">{artifact.summary}</p> : null}
    <div className="spec-flow-scroll">
      <svg className="spec-flow-svg" role="img" aria-label={`Flow diagram: ${title}`} width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`}>
        <title>{`Flow diagram: ${title}`}</title>
        <defs>
          <marker id={arrowId} markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 z" className="spec-flow-arrow" /></marker>
        </defs>
        {layout.edges.map((edge, index) => {
          const from = byId.get(edge.from);
          const to = byId.get(edge.to);
          if (!from || !to || from === to) return null;
          const line = anchors(from, to);
          const label = truncate(edge.label || "", EDGE_LABEL_LENGTH);
          return <g key={`${edge.from}-${edge.to}-${index}`}>
            <line x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} className="spec-flow-edge" markerEnd={`url(#${arrowId})`} />
            {label ? <text className="spec-flow-edge-label" x={(line.x1 + line.x2) / 2} y={(line.y1 + line.y2) / 2 - 4} textAnchor="middle">{label}</text> : null}
          </g>;
        })}
        {layout.placed.map((item) => {
          const lines = wrapLabel(item.node.label);
          const kind = typeof item.node.kind === "string" ? item.node.kind : "step";
          return <g key={item.node.id} className={`spec-flow-node kind-${kind}`}>
            <rect x={item.x} y={item.y} width={NODE_WIDTH} height={NODE_HEIGHT} rx={10} />
            <text x={item.x + NODE_WIDTH / 2} y={item.y + (lines.length === 1 ? 32 : 24)} textAnchor="middle">
              {lines.map((line, index) => <tspan key={line + index} x={item.x + NODE_WIDTH / 2} dy={index === 0 ? 0 : 15}>{line}</tspan>)}
            </text>
          </g>;
        })}
      </svg>
    </div>
  </figure>;
}

export function ScreenArtifact({ artifact }: { artifact: ScreenArtifactData }) {
  const elements = (artifact.screen?.elements || []).filter((element) => element && typeof element.id === "string");
  if (!elements.length) return null;
  const title = artifact.title || "Screen";
  const name = artifact.screen?.name || "";
  return <figure className="spec-screen">
    <figcaption><span className="spec-artifact-kind">Screen</span><strong>{title}</strong>{name ? <small className="spec-screen-name">{name}</small> : null}</figcaption>
    {artifact.summary ? <p className="spec-artifact-summary">{artifact.summary}</p> : null}
    <ul className="spec-screen-elements">{elements.map((element) => {
      const change = typeof element.change === "string" && CHANGE_LABELS[element.change] ? element.change : "unchanged";
      const kind = typeof element.kind === "string" && element.kind ? element.kind : "text";
      return <li key={element.id} className={`spec-screen-element change-${change} kind-${kind}`}>
        <em className={`spec-change change-${change}`}>{CHANGE_LABELS[change]}</em>
        <div><span>{element.label}</span><small>{element.note ? `${kind} · ${element.note}` : kind}</small></div>
      </li>;
    })}</ul>
  </figure>;
}

export function DesignArtifacts({ artifacts }: { artifacts: DesignArtifact[] }) {
  const items = artifacts.filter((artifact) => artifact && (artifact.kind === "flow" || artifact.kind === "screen"));
  if (!items.length) return null;
  return <div className="spec-artifacts">{items.map((artifact) => artifact.kind === "flow"
    ? <FlowArtifact key={artifact.id} artifact={artifact} />
    : <ScreenArtifact key={artifact.id} artifact={artifact} />)}</div>;
}
