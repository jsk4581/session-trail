// session-trail read side: pure queries over the event stream, for agents and the CLI.
// Everything here derives from reduce(); nothing is stored separately.

import { reduce } from "./graph.mjs";

/** Full record of one milestone node: fields, session provenance, artifacts, resolved merges. */
export function showNode(events, id) {
  const g = reduce(events);
  const node = g.nodes.find((n) => n.id === id);
  if (!node) return null;
  const lane = g.lanes.find((l) => l.laneId === node.laneId);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  return {
    ...node,
    session: lane ? { sid: lane.sid, title: lane.title, transcript: lane.transcript } : null,
    // reduce() turns declared merges into edges {from: target, to: node}
    merges: g.edges
      .filter((e) => e.type === "merge" && e.to === id)
      .map((e) => ({ id: e.from, title: byId.get(e.from)?.title || null })),
    mergedBy: g.edges
      .filter((e) => e.type === "merge" && e.from === id)
      .map((e) => ({ id: e.to, title: byId.get(e.to)?.title || null })),
  };
}

/**
 * Milestones whose artifacts include `relPath` (exact file) or live under it
 * (directory prefix). Oldest first, so the latest decision is last.
 */
export function whyPath(events, relPath) {
  const g = reduce(events);
  const p = normalize(relPath);
  const isDir = p.endsWith("/");
  const hits = [];
  for (const n of g.nodes) {
    if (n.kind === "session") continue;
    const arts = n.artifacts || [];
    const match = arts.find((a) => {
      const ap = normalize(a.path);
      return isDir ? ap.startsWith(p) : ap === p || ap.startsWith(p + "/");
    });
    if (match) hits.push({ ...n, matched: match });
  }
  return hits;
}

/**
 * Case-insensitive substring search over milestones (title/what/why/how) and
 * user prompts. Returns at most `limit` hits, newest first, each with a snippet
 * around the first match.
 */
export function search(events, term, { limit = 20 } = {}) {
  const q = String(term || "").trim().toLowerCase();
  if (!q) return [];
  const g = reduce(events);
  const laneBy = new Map(g.lanes.map((l) => [l.laneId, l]));
  const hits = [];
  for (const n of g.nodes) {
    if (n.kind === "session") continue;
    for (const field of ["title", "what", "why", "how"]) {
      const idx = String(n[field] || "").toLowerCase().indexOf(q);
      if (idx < 0) continue;
      hits.push({ type: "milestone", id: n.id, kind: n.kind, ts: n.ts, title: n.title, field, snippet: snip(n[field], idx, q.length) });
      break;
    }
  }
  for (const p of g.prompts) {
    const idx = String(p.text || "").toLowerCase().indexOf(q);
    if (idx < 0) continue;
    hits.push({ type: "prompt", id: p.id, ts: p.ts, sid: laneBy.get(p.laneId)?.sid || null, snippet: snip(p.text, idx, q.length) });
  }
  hits.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  return hits.slice(0, limit);
}

/**
 * Recent milestones, optionally scoped to one session.
 *   session: undefined | "all"  -> across sessions (default)
 *            "last"             -> the most recent session that has milestones
 *            "<sid or prefix>"  -> that session
 * Auto nodes are excluded unless includeAuto is set. Oldest first.
 */
export function recent(events, { n = 10, session, includeAuto = false } = {}) {
  const g = reduce(events);
  let nodes = g.nodes.filter((x) => x.kind !== "session" && (includeAuto || !x.auto));
  if (session && session !== "all") {
    let lane;
    if (session === "last") {
      const withNodes = new Set(nodes.map((x) => x.laneId));
      lane = [...g.lanes].reverse().find((l) => withNodes.has(l.laneId));
    } else {
      lane = g.lanes.find((l) => l.sid === session || l.sid.startsWith(session));
    }
    if (!lane) return { lane: null, nodes: [] };
    nodes = nodes.filter((x) => x.laneId === lane.laneId);
    return { lane, nodes: nodes.slice(-n) };
  }
  return { lane: null, nodes: nodes.slice(-n) };
}

function normalize(p) {
  return String(p || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function snip(text, idx, len, ctx = 60) {
  const s = String(text || "").replace(/\s+/g, " ");
  const start = Math.max(0, idx - ctx);
  const end = Math.min(s.length, idx + len + ctx);
  return (start > 0 ? "…" : "") + s.slice(start, end) + (end < s.length ? "…" : "");
}
