// sessiontrail graph reduction, a pure function: events[] -> { lanes, nodes, edges }
// Deterministic; the viewer renders this directly.

import { SCHEMA_VERSION } from "./store.mjs";

const VERB_RANK = { create: 3, write: 2, edit: 1 };
export const PALETTE_SIZE = 8;

/**
 * Reduce an event stream into a renderable graph.
 * Rules:
 *  - one lane per session (deduped by sid), ordered by first ts
 *  - touches attach to the NEXT milestone of the same session
 *    (trailing touches after the last milestone attach to that last milestone)
 *  - lane edges chain session head -> m1 -> m2 ...
 *  - `merges` targets that don't exist are dropped silently
 *  - vertical slots: greedy interval assignment alternating +1,-1,+2,-2 …
 */
export function reduce(events, opts = {}) {
  const sorted = [...events].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

  const lanes = new Map(); // sid -> lane
  const nodes = [];
  const edges = [];
  const nodeById = new Map();
  const pending = new Map(); // sid -> touch[]
  const lastMilestone = new Map(); // sid -> node
  const laneOrder = [];
  const prompts = [];

  const laneId = (sid) => "s-" + String(sid);

  for (const ev of sorted) {
    const sid = ev.sid;
    if (!sid) continue;

    switch (ev.type) {
      case "session": {
        if (lanes.has(sid)) break; // dedupe (resume/duplicate)
        const lane = {
          laneId: laneId(sid),
          sid,
          title: null,
          transcript: ev.transcript || null,
          startTs: ev.ts,
          endTs: ev.ts,
          color: laneOrder.length % PALETTE_SIZE,
          slot: 0,
        };
        lanes.set(sid, lane);
        laneOrder.push(lane);
        const head = {
          id: lane.laneId,
          laneId: lane.laneId,
          kind: "session",
          ts: ev.ts,
          title: null,
        };
        nodes.push(head);
        nodeById.set(head.id, head);
        pending.set(sid, []);
        break;
      }
      case "title": {
        const lane = lanes.get(sid);
        if (lane && !lane.title) {
          lane.title = ev.title;
          const head = nodeById.get(lane.laneId);
          if (head && !head.title) head.title = ev.title;
        }
        touchEnd(lanes, sid, ev.ts);
        break;
      }
      case "touch": {
        if (!lanes.has(sid)) break; // touch without a session: ignore
        pending.get(sid).push({ path: ev.path, verb: ev.verb || "edit", ts: ev.ts });
        touchEnd(lanes, sid, ev.ts);
        break;
      }
      case "milestone": {
        const lane = lanes.get(sid);
        if (!lane) break;
        const node = {
          id: ev.id,
          laneId: lane.laneId,
          kind: ev.kind || "action",
          ts: ev.ts,
          title: ev.title || "",
          what: ev.what || "",
          why: ev.why || "",
          how: ev.how || "",
          auto: !!ev.auto,
          merges: Array.isArray(ev.merges) ? ev.merges : [],
          artifacts: dedupeArtifacts(pending.get(sid)),
        };
        pending.set(sid, []);
        nodes.push(node);
        nodeById.set(node.id, node);
        const prev = lastMilestone.get(sid) || nodeById.get(lane.laneId);
        edges.push({ from: prev.id, to: node.id, type: "lane" });
        lastMilestone.set(sid, node);
        touchEnd(lanes, sid, ev.ts);
        break;
      }
      case "prompt": {
        const lane = lanes.get(sid);
        if (!lane) break;
        prompts.push({
          id: "p-" + String(sid).slice(0, 8) + "-" + prompts.length,
          laneId: lane.laneId,
          ts: ev.ts,
          text: ev.text || "",
        });
        touchEnd(lanes, sid, ev.ts);
        break;
      }
      case "session_end": {
        touchEnd(lanes, sid, ev.ts);
        const lane = lanes.get(sid);
        if (lane) lane.ended = true;
        break;
      }
    }
  }

  // Trailing touches (work after the last milestone) attach to that milestone.
  for (const [sid, touches] of pending) {
    if (!touches.length) continue;
    const last = lastMilestone.get(sid);
    if (last) {
      last.artifacts = dedupeArtifacts([...last.artifacts, ...touches]);
    } else {
      // No milestone in this session: keep artifacts on the session head so
      // nothing is lost (SessionEnd normally synthesizes an auto milestone
      // before this happens for ended sessions; this covers live sessions).
      const head = nodeById.get(laneId(sid));
      if (head) head.artifacts = dedupeArtifacts(touches);
    }
  }

  // Merge edges (after all nodes exist; unknown targets dropped).
  for (const node of nodes) {
    if (!node.merges || !node.merges.length) continue;
    for (const target of node.merges) {
      if (nodeById.has(target) && target !== node.id) {
        edges.push({ from: target, to: node.id, type: "merge" });
      }
    }
    delete node.merges;
  }

  assignSlots(laneOrder);

  return {
    v: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    project: opts.project || null,
    lanes: laneOrder,
    nodes,
    edges,
    prompts,
  };
}

function touchEnd(lanes, sid, ts) {
  const lane = lanes.get(sid);
  if (lane && String(ts) > String(lane.endTs)) lane.endTs = ts;
}

function dedupeArtifacts(touches = []) {
  const byPath = new Map();
  for (const t of touches) {
    if (!t.path) continue;
    const prev = byPath.get(t.path);
    if (!prev || (VERB_RANK[t.verb] || 0) > (VERB_RANK[prev.verb] || 0)) {
      byPath.set(t.path, { path: t.path, verb: t.verb });
    }
  }
  return [...byPath.values()];
}

/**
 * Greedy interval slot assignment. Slot order alternates above/below the
 * central axis: +1, -1, +2, -2, … A finished lane frees its slot for later
 * sessions (lane compaction).
 */
function assignSlots(laneOrder) {
  const slotBusyUntil = new Map(); // slot -> endTs
  const slotSeq = (i) => (i % 2 === 0 ? (i / 2 + 1) : -((i + 1) / 2));
  for (const lane of laneOrder) {
    let assigned = null;
    for (let i = 0; ; i++) {
      const slot = slotSeq(i);
      const busyUntil = slotBusyUntil.get(slot);
      if (busyUntil === undefined || String(busyUntil) < String(lane.startTs)) {
        assigned = slot;
        break;
      }
    }
    lane.slot = assigned;
    slotBusyUntil.set(assigned, lane.endTs);
  }
}
