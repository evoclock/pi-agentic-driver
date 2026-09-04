// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// visualization adapter — optional bounded visual payloads for code-phage.
//
// Concept provenance: sideshow v0.13.0 (MIT, modem-dev/sideshow, commit
// 81b65eb) demonstrates data-first visual review surfaces: small JSON,
// Mermaid, and diagram payloads that illustrate findings, updated in
// place rather than duplicated, behind an explicit human decision.
// Adapted here without sideshow's server, viewer, storage, or any
// network surface: this adapter is a pure function that emits bounded
// diagram source text. It never uploads files, never syncs traces, and
// never contacts a remote endpoint. Opt-in is required at every call.
//
// The palette is the first-party thermall-power-station theme from
// evoclock/thermall (sage / rust / peach / cream on warm dark greys).
export const VISUALIZATION_SCHEMA = "agentic-driver.code-phage-visualization.v1";

export const THERMALL_POWER_STATION = Object.freeze({
  name: "thermall-power-station",
  background: "#1a1816",
  surface: "#383431",
  panel: "#4a4540",
  boost: "#5c564f",
  sage: "#79c39e",
  rust: "#e77843",
  peach: "#ee9b69",
  cream: "#ead1b5",
});

const MAX_NODES = 48;
const MAX_LABEL_CHARS = 64;
const MAX_EDGES = 96;

function truncateLabel(value) {
  const text = String(value ?? "");
  return text.length > MAX_LABEL_CHARS ? `${text.slice(0, MAX_LABEL_CHARS - 1)}…` : text;
}

function sanitizeLine(value) {
  // Keep diagram source single-line safe for Mermaid and D2.
  return String(value ?? "").replaceAll('"', "'").replaceAll(/[\r\n]+/g, " ").trim();
}

function classifyNode(entry, anchor) {
  if (anchor && Object.values(anchor.overCeiling || {}).some(Boolean)) return "over-ceiling";
  if (anchor) return "touched";
  return "file";
}

function nodeColor(kind) {
  switch (kind) {
    case "over-ceiling": return THERMALL_POWER_STATION.rust;
    case "touched": return THERMALL_POWER_STATION.sage;
    default: return THERMALL_POWER_STATION.peach;
  }
}

// One bounded graph of changed files and their touched callables.
function buildGraph(result) {
  const nodes = [];
  const edges = [];
  const changedCallables = Array.isArray(result?.changedCallables) ? result.changedCallables : [];
  const seenFileNodes = new Set();
  for (const entry of changedCallables) {
    if (!entry || typeof entry.path !== "string" || !entry.path) continue;
    const fileNode = `f:${entry.path}`;
    if (nodes.length >= MAX_NODES) break;
    // Duplicate file entries share one file node so downstream ID maps stay unique.
    const isNewFileNode = !seenFileNodes.has(fileNode);
    if (isNewFileNode) {
      seenFileNodes.add(fileNode);
      nodes.push({ id: fileNode, kind: "file", label: truncateLabel(entry.path), color: nodeColor("file") });
    }
    const anchors = Array.isArray(entry.evidence?.anchors) ? entry.evidence.anchors : [];
    for (const anchor of anchors) {
      if (nodes.length >= MAX_NODES) break;
      const kind = classifyNode(entry, anchor);
      const id = `c:${entry.path}#${anchor.name}#${nodes.length}`;
      nodes.push({ id, kind, label: truncateLabel(anchor.name), color: nodeColor(kind) });
      if (edges.length < MAX_EDGES) edges.push({ from: fileNode, to: id });
    }
  }
  return { nodes, edges };
}

function safeId(id, used) {
  let base = "n" + String(id).replaceAll(/[^a-zA-Z0-9]/g, "_");
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base}_${suffix++}`;
  used.add(candidate);
  return candidate;
}

// Mermaid source: portable Markdown fallback rendered by GitHub/GitLab and
// most Markdown viewers. Class assignment is per node kind, not global.
export function buildMermaid(result) {
  const { nodes, edges } = buildGraph(result);
  const used = new Set();
  const mermaidId = new Map(nodes.map((node) => [node.id, safeId(node.id, used)]));
  const lines = ["graph TD"];
  for (const node of nodes) {
    lines.push(`  ${mermaidId.get(node.id)}["${sanitizeLine(node.label)}"]`);
  }
  for (const edge of edges) {
    lines.push(`  ${mermaidId.get(edge.from)} --> ${mermaidId.get(edge.to)}`);
  }
  lines.push(`  classDef overCeiling stroke:${THERMALL_POWER_STATION.rust},color:${THERMALL_POWER_STATION.cream}`);
  lines.push(`  classDef touched stroke:${THERMALL_POWER_STATION.sage},color:${THERMALL_POWER_STATION.cream}`);
  lines.push(`  classDef file stroke:${THERMALL_POWER_STATION.peach},color:${THERMALL_POWER_STATION.cream}`);
  for (const kind of ["over-ceiling", "touched", "file"]) {
    const ids = nodes.filter((n) => n.kind === kind).map((n) => mermaidId.get(n.id));
    if (ids.length) lines.push(`  class ${ids.join(",")} ${kind === "over-ceiling" ? "overCeiling" : kind}`);
  }
  return { schema: VISUALIZATION_SCHEMA, format: "mermaid", theme: THERMALL_POWER_STATION.name, source: lines.join("\n"), nodeCount: nodes.length, edgeCount: edges.length };
}

// D2 source: preferred for high-quality browser rendering (e.g. an
// optional Sideshow surface). Styling mirrors thermall-power-station.
export function buildD2(result) {
  const { nodes, edges } = buildGraph(result);
  const lines = [`direction: down`, `style.fill: "${THERMALL_POWER_STATION.background}"`];
  lines.push("classes: {");
  lines.push(`  overCeiling: { style: { fill: "${THERMALL_POWER_STATION.surface}"; stroke: "${THERMALL_POWER_STATION.rust}"; stroke-width: 4; border-radius: 12; font-color: "${THERMALL_POWER_STATION.cream}"; bold: true } }`);
  lines.push(`  touched: { style: { fill: "${THERMALL_POWER_STATION.surface}"; stroke: "${THERMALL_POWER_STATION.sage}"; stroke-width: 4; border-radius: 12; font-color: "${THERMALL_POWER_STATION.cream}"; bold: true } }`);
  lines.push(`  file: { style: { fill: "${THERMALL_POWER_STATION.panel}"; stroke: "${THERMALL_POWER_STATION.peach}"; stroke-width: 4; border-radius: 12; font-color: "${THERMALL_POWER_STATION.cream}"; bold: true } }`);
  lines.push("}");
  for (const node of nodes) {
    lines.push(`"${sanitizeLine(node.id)}": "${sanitizeLine(node.label)}" { class: ${node.kind === "over-ceiling" ? "overCeiling" : node.kind === "touched" ? "touched" : "file"} }`);
  }
  for (const edge of edges) {
    lines.push(`"${sanitizeLine(edge.from)}" -> "${sanitizeLine(edge.to)}": { style.stroke: "${THERMALL_POWER_STATION.boost}"; style.stroke-width: 3 }`);
  }
  return { schema: VISUALIZATION_SCHEMA, format: "d2", theme: THERMALL_POWER_STATION.name, source: lines.join("\n"), nodeCount: nodes.length, edgeCount: edges.length };
}

// Compact JSON payload: the data-first surface for optional viewers.
// Fails closed to an empty payload on malformed input.
export function buildVisualJson(result) {
  const { nodes, edges } = buildGraph(result);
  return {
    schema: VISUALIZATION_SCHEMA,
    format: "json",
    theme: THERMALL_POWER_STATION.name,
    nodes,
    edges,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    counts: {
      changedFiles: result?.changedScope?.changedFiles ?? 0,
      touchedCallables: result?.changedScope?.touchedCallables ?? 0,
      reviewFeedback: result?.summary?.reviewFeedback ?? { AMEND: 0, CONSULT: 0 },
    },
  };
}

// Single opt-in entry point. `options.enabled` must be exactly true:
// visualization is never implicit, mirroring the sideshow lesson that
// surfaces and trace sync must not activate without a human decision.
export function buildVisualization(result, options = {}) {
  if (options.enabled !== true) {
    return { schema: VISUALIZATION_SCHEMA, enabled: false, reason: "visualization is opt-in; pass { enabled: true } to build a payload." };
  }
  const format = options.format || "json";
  const builders = { json: buildVisualJson, mermaid: buildMermaid, d2: buildD2 };
  const builder = builders[format];
  if (!builder) {
    return { schema: VISUALIZATION_SCHEMA, enabled: false, reason: `unknown format ${format}; use json, mermaid, or d2.` };
  }
  return { enabled: true, noNetwork: true, noFileWrites: true, noTraceUpload: true, ...builder(result) };
}

function safeIdForD2(id) {
  return String(id).replaceAll(/[^a-zA-Z0-9]/g, "_");
}
