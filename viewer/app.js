/* session-trail timeline viewer: vanilla JS + SVG, no build step. */
"use strict";

// ---------- constants ----------

const PALETTE = ["#60dbc4", "#b18cff", "#ffc857", "#ff7a9c", "#6fb8ff", "#a8e05f", "#ff9f5f", "#e07ae0"];
// --- time scale rule (monotonic) ---
// Gaps up to LINEAR_MS render linearly at PX_PER_MS (1px/10s).
// Longer gaps compress logarithmically but stay monotonic: a bigger gap is
// always at least as wide as a smaller one (1h ≈ 83px < 1d ≈ 125px < 30d ≈ 169px).
const PX_PER_MS = 1 / 10000;         // 1px per 10s at zoom 1
const LINEAR_MS = 10 * 60 * 1000;    // linear up to 10 minutes
const LINEAR_MAX_W = LINEAR_MS * PX_PER_MS; // 60px: width where the log part takes over
const LOG_K = 30;                    // px per decade beyond LINEAR_MS
const GAP_LABEL_MS = 45 * 60 * 1000; // gaps longer than this get a "· N h ·" label
const SLOT_BASE = 90;             // px from axis to first lane
const SLOT_GAP = 72;              // px between lane rings
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 40;

const SVGNS = "http://www.w3.org/2000/svg";

// ---------- state ----------

const state = {
  graph: null,
  token: null,
  anchors: [],       // [{t, x, break}] piecewise time->x scale
  worldWidth: 0,
  minT: 0,
  maxT: 0,
  zoom: 1,
  panX: 40,
  panY: 0,
  filters: { decision: true, action: true, merge: true, auto: true, prompts: true },
  selected: null,
  items: { nodes: [], lanes: [], merges: [], prompts: [] }, // rendered element registries
};

const $ = (sel) => document.querySelector(sel);
const canvas = $("#canvas");
const layers = {
  ghost: $("#layer-ghost"),
  axis: $("#layer-axis"),
  lanes: $("#layer-lanes"),
  merges: $("#layer-merges"),
  nodes: $("#layer-nodes"),
};

// ---------- boot ----------

init();

async function init() {
  const params = new URLSearchParams(location.search);
  state.token = params.get("t") || sessionStorage.getItem("session-trail-token");
  if (params.get("t")) {
    sessionStorage.setItem("session-trail-token", params.get("t"));
    history.replaceState(null, "", location.pathname); // keep token out of the URL bar
  }

  let graph;
  try {
    const res = await fetch("/api/graph", { headers: { "X-Session-Trail-Token": state.token || "" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    graph = await res.json();
  } catch (e) {
    $("#empty-state").hidden = false;
    $("#empty-state").querySelector("p").textContent = "Could not load timeline.";
    $("#empty-state").querySelector(".sub").textContent =
      "Open the viewer through the URL printed by /session-trail:view (it carries the access token). " + e.message;
    return;
  }

  state.graph = graph;
  $("#project-name").textContent = graph.project || "";
  $("#stats").textContent = `${graph.lanes.length} sessions · ${graph.nodes.length} nodes · ${(graph.prompts || []).length} prompts`;

  if (!graph.lanes.length) {
    $("#empty-state").hidden = false;
    return;
  }

  buildScale(graph);
  buildScene(graph);
  bindInteractions();
  fit();
}

// ---------- time scale (piecewise linear with compressed gaps) ----------

function buildScale(graph) {
  const ts = new Set();
  for (const l of graph.lanes) { ts.add(+new Date(l.startTs)); ts.add(+new Date(l.endTs)); }
  for (const n of graph.nodes) ts.add(+new Date(n.ts));
  const sorted = [...ts].filter((t) => !isNaN(t)).sort((a, b) => a - b);

  const anchors = [{ t: sorted[0], x: 0, break: false }];
  for (let i = 1; i < sorted.length; i++) {
    const prev = anchors[anchors.length - 1];
    const dt = sorted[i] - prev.t;
    if (dt <= 0) continue;
    const dx = dt <= LINEAR_MS
      ? dt * PX_PER_MS
      : LINEAR_MAX_W + LOG_K * Math.log10(dt / LINEAR_MS);
    anchors.push({ t: sorted[i], x: prev.x + dx, break: dt > GAP_LABEL_MS });
  }
  state.anchors = anchors;
  state.minT = sorted[0];
  state.maxT = sorted[sorted.length - 1];
  state.worldWidth = anchors[anchors.length - 1].x + 60;
}

/** world x for a timestamp (ms) */
function xOf(t) {
  const a = state.anchors;
  if (t <= a[0].t) return a[0].x;
  for (let i = 1; i < a.length; i++) {
    if (t <= a[i].t) {
      const frac = (t - a[i - 1].t) / (a[i].t - a[i - 1].t);
      return a[i - 1].x + frac * (a[i].x - a[i - 1].x);
    }
  }
  return a[a.length - 1].x;
}

const yOfSlot = (slot) =>
  slot > 0 ? -(SLOT_BASE + (slot - 1) * SLOT_GAP) : SLOT_BASE + (-slot - 1) * SLOT_GAP;

// screen transforms
const X = (t) => xOf(t) * state.zoom + state.panX;
const Y = (worldY) => worldY + state.panY;

// ---------- scene construction (elements created once, positioned in relayout) ----------

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

function buildScene(graph) {
  const laneById = new Map(graph.lanes.map((l) => [l.laneId, l]));

  // axis
  state.axisLine = el("line", { class: "axis-line" }, layers.axis);

  // lanes: line + stem + title
  for (const lane of graph.lanes) {
    const color = PALETTE[lane.color % PALETTE.length];
    const line = el("line", { class: "lane-line", stroke: color }, layers.lanes);
    const stem = el("line", { class: "lane-stem", stroke: color }, layers.lanes);
    const title = el("text", { class: "lane-title", fill: color }, layers.lanes);
    title.textContent = lane.title || lane.sid.slice(0, 8);
    state.items.lanes.push({ lane, color, line, stem, title });
  }

  // user prompts: faint ticks on the lane (deliberately low-key vs. milestone nodes)
  for (const p of graph.prompts || []) {
    const lane = laneById.get(p.laneId);
    if (!lane) continue;
    const color = PALETTE[lane.color % PALETTE.length];
    const g = el("g", { class: "prompt" }, layers.lanes);
    g.style.color = color;
    el("rect", { x: -8, y: -14, width: 16, height: 28, fill: "transparent" }, g); // generous hit area
    el("line", { class: "prompt-tick", x1: 0, y1: -8, x2: 0, y2: 8, stroke: color }, g);
    el("title", {}, g).textContent = `${fmtDate(p.ts, true)}  ${p.text}`;
    g.addEventListener("click", (ev) => {
      ev.stopPropagation();
      select({ kind: "prompt", laneId: p.laneId, ts: p.ts, title: truncate(p.text, 80), what: p.text, artifacts: [] }, g);
    });
    state.items.prompts.push({ p, lane, g });
  }

  // merge edges
  for (const edge of graph.edges) {
    if (edge.type !== "merge") continue;
    const fromNode = graph.nodes.find((n) => n.id === edge.from);
    const toNode = graph.nodes.find((n) => n.id === edge.to);
    if (!fromNode || !toNode) continue;
    const color = PALETTE[(laneById.get(fromNode.laneId)?.color || 0) % PALETTE.length];
    const path = el("path", { class: "merge-edge", stroke: color, "marker-end": "url(#arrow)" }, layers.merges);
    state.items.merges.push({ edge, fromNode, toNode, path });
  }

  // nodes: labels alternate sides per lane, starting opposite the lane title
  const perLaneIdx = new Map();
  for (const node of graph.nodes) {
    const lane = laneById.get(node.laneId);
    if (!lane) continue;
    const color = PALETTE[lane.color % PALETTE.length];
    const g = el("g", { class: "node" + (node.auto ? " auto" : "") }, layers.nodes);
    g.style.color = color;
    el("circle", { r: 16, fill: "transparent" }, g); // generous hit area
    drawShape(g, node.kind, color);

    if (node.kind !== "session") { // lane title already labels the head
      const idx = perLaneIdx.get(node.laneId) || 0;
      perLaneIdx.set(node.laneId, idx + 1);
      // lane title sits above top lanes / below bottom lanes; start labels on the other side
      const labelAbove = lane.slot > 0 ? idx % 2 === 1 : idx % 2 === 0;
      const lines = wrapLabel(node.title || "(untitled)");
      const label = el("text", { class: "node-label", "text-anchor": "middle" }, g);
      const LINE_H = 13;
      lines.forEach((line, li) => {
        // above: lines stack upward ending at -16; below: stack downward from 26
        const y = labelAbove ? -16 - (lines.length - 1 - li) * LINE_H : 26 + li * LINE_H;
        el("tspan", { x: 0, y }, label).textContent = line;
      });
      const dateY = labelAbove ? -16 - lines.length * LINE_H + 1 : 26 + lines.length * LINE_H - 1;
      const date = el("text", { class: "node-date", "text-anchor": "middle", y: dateY }, g);
      date.textContent = fmtDate(node.ts, true);
      el("title", {}, g).textContent = node.title || "(untitled)"; // native tooltip: full title
      g.addEventListener("click", (ev) => { ev.stopPropagation(); select(node, g); });
      state.items.nodes.push({ node, lane, g, labelEl: label, dateEl: date, side: labelAbove ? "a" : "b" });
      continue;
    }

    g.addEventListener("click", (ev) => { ev.stopPropagation(); select(node, g); });
    state.items.nodes.push({ node, lane, g });
  }

  buildGhosts();
  relayout();
}

function drawShape(g, kind, color) {
  switch (kind) {
    case "session":
      el("circle", { class: "shape", r: 7, fill: "var(--bg)", stroke: color, "stroke-width": 2.5 }, g);
      break;
    case "decision":
      el("rect", { class: "shape", x: -5.5, y: -5.5, width: 11, height: 11, fill: color, transform: "rotate(45)" }, g);
      break;
    case "merge":
      el("circle", { class: "shape", r: 9, fill: "none", stroke: color, "stroke-width": 1.5 }, g);
      el("circle", { r: 4.5, fill: color }, g);
      break;
    default: // action
      el("circle", { class: "shape", r: 5.5, fill: color }, g);
  }
}

/** ghost date labels + gap markers along the axis */
function buildGhosts() {
  state.ghostEls = [];
  const a = state.anchors;
  const seenDays = new Set();

  const addGhost = (t, text, cls) => {
    const g = el("text", { class: cls, "font-size": cls === "ghost-date" ? 84 : 11 }, layers.ghost);
    g.textContent = text;
    state.ghostEls.push({ t, elText: g, cls });
  };

  for (let i = 0; i < a.length; i++) {
    const dayKey = new Date(a[i].t).toISOString().slice(0, 10);
    if (!seenDays.has(dayKey)) {
      const d = new Date(a[i].t);
      // first ghost carries the year: "2026 · 08.01", later ones just "08.04"
      const label = seenDays.size === 0
        ? `${d.getFullYear()} · ${pad(d.getMonth() + 1)}.${pad(d.getDate())}`
        : `${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
      seenDays.add(dayKey);
      addGhost(startOfDayT(a[i].t), label, "ghost-date");
    }
    if (a[i].break && i > 0) {
      const gapMs = a[i].t - a[i - 1].t;
      const mid = a[i - 1].t + gapMs / 2;
      const gEl = el("text", { class: "node-date", "text-anchor": "middle", opacity: 0.6 }, layers.ghost);
      gEl.textContent = `· ${fmtGap(gapMs)} ·`;
      state.ghostEls.push({ t: mid, elText: gEl, cls: "gap" });
    }
    if (seenDays.size > 400) break; // density guard for very long histories
  }
}

function startOfDayT(t) {
  // clamp the ghost to a position inside the visible scale
  return Math.max(t, state.minT);
}

// ---------- relayout (called on every view change) ----------

function relayout() {
  const { width, height } = canvas.getBoundingClientRect();
  const axisY = Y(0);

  state.axisLine.setAttribute("x1", 0);
  state.axisLine.setAttribute("x2", width);
  state.axisLine.setAttribute("y1", axisY);
  state.axisLine.setAttribute("y2", axisY);

  for (const it of state.items.lanes) {
    const x1 = X(+new Date(it.lane.startTs));
    const x2 = Math.max(X(+new Date(it.lane.endTs)), x1 + 24);
    const y = Y(yOfSlot(it.lane.slot));
    setLine(it.line, x1, y, x2, y);
    setLine(it.stem, x1, y, x1, axisY);
    it.title.setAttribute("x", x1);
    it.title.setAttribute("y", y + (it.lane.slot > 0 ? -14 : 22));
  }

  for (const it of state.items.nodes) {
    const x = X(+new Date(it.node.ts));
    const y = Y(yOfSlot(it.lane.slot));
    it.g.setAttribute("transform", `translate(${x},${y})`);
  }

  for (const it of state.items.prompts) {
    it.g.setAttribute("transform", `translate(${X(+new Date(it.p.ts))},${Y(yOfSlot(it.lane.slot))})`);
  }

  const laneById = new Map(state.graph.lanes.map((l) => [l.laneId, l]));
  for (const it of state.items.merges) {
    const x1 = X(+new Date(it.fromNode.ts));
    const y1 = Y(yOfSlot(laneById.get(it.fromNode.laneId).slot));
    const x2 = X(+new Date(it.toNode.ts));
    const y2 = Y(yOfSlot(laneById.get(it.toNode.laneId).slot));
    const dx = Math.max(40, Math.abs(x2 - x1) * 0.4);
    if (Math.abs(y1 - y2) < 10) {
      // same visual row: arc toward the central axis so the edge stays visible
      const axisSide = y1 < Y(0) ? 1 : -1;
      const cy = y1 + axisSide * 52;
      it.path.setAttribute("d", `M ${x1} ${y1} C ${x1 + dx} ${cy}, ${x2 - dx} ${cy}, ${x2 - 12} ${y2}`);
    } else {
      it.path.setAttribute("d", `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2 - 12} ${y2}`);
    }
  }

  declutterLabels();

  let ghostRight = -Infinity;
  for (const gh of state.ghostEls) {
    const x = X(gh.t);
    gh.elText.setAttribute("x", x + (gh.cls === "ghost-date" ? 8 : 0));
    gh.elText.setAttribute("y", gh.cls === "ghost-date" ? axisY + 64 : axisY - 10);
    let show = x > -300 && x < width + 300;
    if (gh.cls === "ghost-date") {
      if (gh.w === undefined) { try { gh.w = gh.elText.getBBox().width || 200; } catch { gh.w = 200; } }
      if (x < ghostRight + 24) show = false; // would overlap the previous day label
      if (show) ghostRight = x + gh.w;
    }
    gh.elText.style.display = show ? "" : "none";
  }

  canvas.setAttribute("viewBox", `0 0 ${width} ${height}`);
}

/**
 * Greedy label declutter: within one lane side, hide any label that would
 * horizontally overlap the previous visible one at the current zoom.
 * Hidden labels reappear on zoom-in or hover (CSS) and in the tooltip.
 */
function declutterLabels() {
  const groups = new Map();
  for (const it of state.items.nodes) {
    if (!it.labelEl) continue;
    if (it.halfW === undefined) {
      try { it.halfW = it.labelEl.getBBox().width / 2 || 40; } catch { it.halfW = 40; }
    }
    const key = it.lane.laneId + it.side;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ it, x: X(+new Date(it.node.ts)) });
  }
  // lane titles occupy the start of their side; seed the group's occupied interval with them
  const titleRight = new Map();
  for (const it of state.items.lanes) {
    if (it.titleW === undefined) {
      try { it.titleW = it.title.getBBox().width || 80; } catch { it.titleW = 80; }
    }
    const side = it.lane.slot > 0 ? "a" : "b";
    titleRight.set(it.lane.laneId + side, X(+new Date(it.lane.startTs)) + it.titleW);
  }
  for (const [key, arr] of groups) {
    arr.sort((a, b) => a.x - b.x);
    let lastRight = titleRight.has(key) ? titleRight.get(key) : -Infinity;
    for (const { it, x } of arr) {
      const show = x - it.halfW > lastRight + 6;
      it.labelEl.style.visibility = show ? "" : "hidden";
      it.dateEl.style.visibility = show ? "" : "hidden";
      if (show) lastRight = x + it.halfW;
    }
  }
}

function setLine(l, x1, y1, x2, y2) {
  l.setAttribute("x1", x1); l.setAttribute("y1", y1);
  l.setAttribute("x2", x2); l.setAttribute("y2", y2);
}

// ---------- interactions ----------

function bindInteractions() {
  let raf = 0;
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; relayout(); }); };

  canvas.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const factor = Math.exp(-ev.deltaY * 0.0016);
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, state.zoom * factor));
    const applied = newZoom / state.zoom;
    state.panX = ev.clientX - (ev.clientX - state.panX) * applied;
    state.zoom = newZoom;
    schedule();
  }, { passive: false });

  // Drag-to-pan. IMPORTANT: capture the pointer only after real movement -
  // capturing on pointerdown retargets the subsequent click to the canvas,
  // which silently breaks node clicks.
  let down = false, dragging = false, lastX = 0, lastY = 0;
  canvas.addEventListener("pointerdown", (ev) => {
    down = true; dragging = false; lastX = ev.clientX; lastY = ev.clientY;
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!down) return;
    const dx = ev.clientX - lastX, dy = ev.clientY - lastY;
    if (!dragging) {
      if (Math.abs(dx) + Math.abs(dy) < 4) return; // not a drag yet
      dragging = true;
      canvas.classList.add("dragging");
      canvas.setPointerCapture(ev.pointerId);
    }
    state.panX += dx;
    state.panY += dy;
    lastX = ev.clientX; lastY = ev.clientY;
    schedule();
  });
  canvas.addEventListener("pointerup", () => { down = false; canvas.classList.remove("dragging"); });
  // Swallow the residual click that follows a drag (capture phase beats node handlers).
  canvas.addEventListener("click", (ev) => {
    if (dragging) { dragging = false; ev.stopPropagation(); }
  }, true);
  canvas.addEventListener("dblclick", fit);
  canvas.addEventListener("click", () => deselect());

  $("#fit-btn").addEventListener("click", fit);
  // NOTE: must wrap: passing deselect directly would receive the click event
  // as its keepPanel argument and never close the panel.
  $("#detail-close").addEventListener("click", () => deselect());
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") deselect(); });

  window.addEventListener("resize", schedule);

  for (const chip of document.querySelectorAll(".chip")) {
    chip.addEventListener("click", () => {
      const kind = chip.dataset.kind;
      state.filters[kind] = !state.filters[kind];
      chip.classList.toggle("active", state.filters[kind]);
      applyFilters();
    });
  }
}

function fit() {
  const { width, height } = canvas.getBoundingClientRect();
  const margin = 70;
  state.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (width - margin * 2) / Math.max(1, state.worldWidth)));
  state.panX = margin;
  state.panY = height / 2;
  relayout();
}

function applyFilters() {
  const visible = (node) => {
    if (node.kind === "session") return true;
    if (node.auto && !state.filters.auto) return false;
    return state.filters[node.kind] !== false;
  };
  const vis = new Map();
  for (const it of state.items.nodes) {
    const v = visible(it.node);
    vis.set(it.node.id, v);
    it.g.classList.toggle("dimmed", !v);
  }
  for (const it of state.items.merges) {
    it.path.classList.toggle("dimmed", !vis.get(it.fromNode.id) || !vis.get(it.toNode.id));
  }
  for (const it of state.items.prompts) {
    it.g.classList.toggle("dimmed", !state.filters.prompts);
  }
}

// ---------- detail panel ----------

function select(node, g) {
  deselect(true);
  state.selected = g;
  g.classList.add("selected");

  const lane = state.graph.lanes.find((l) => l.laneId === node.laneId);
  const color = PALETTE[(lane?.color || 0) % PALETTE.length];

  const badge = $("#detail-kind");
  badge.textContent = node.kind + (node.auto ? " · auto" : "");
  badge.style.color = color;

  $("#detail-title").textContent = node.title || "(untitled)";
  $("#detail-meta").textContent =
    `${fmtDate(node.ts)} · session: ${lane?.title || node.laneId.replace(/^s-/, "").slice(0, 8)}`;

  fillSection("#sec-what", node.what);
  fillSection("#sec-why", node.why);
  fillSection("#sec-how", node.how);

  const list = $("#artifact-list");
  list.innerHTML = "";
  $("#file-preview").hidden = true;
  const artifacts = node.artifacts || [];
  $("#artifact-count").textContent = artifacts.length ? `(${artifacts.length})` : "";
  $("#sec-artifacts").hidden = !artifacts.length;
  for (const a of artifacts) {
    const li = document.createElement("li");
    const verb = document.createElement("span");
    verb.className = `verb verb-${a.verb === "create" ? "create" : a.verb === "write" ? "write" : "edit"}`;
    verb.textContent = a.verb;
    const p = document.createElement("span");
    p.className = "path";
    p.textContent = a.path;
    li.title = "Click to preview · double-click to copy path";
    li.append(verb, p);
    li.addEventListener("click", () => previewFile(a.path));
    li.addEventListener("dblclick", () => copyText(a.path));
    list.appendChild(li);
  }

  // session provenance: lets a human or another agent find the original conversation log
  fillMonoRow("#session-id", "sid", lane?.sid || node.laneId.replace(/^s-/, ""));
  fillMonoRow("#session-transcript", "log", lane?.transcript || null);

  $("#detail").hidden = false;
}

function fillMonoRow(sel, key, value) {
  const row = $(sel);
  row.hidden = !value;
  if (!value) return;
  row.innerHTML = "";
  const k = document.createElement("span");
  k.className = "k";
  k.textContent = key + " ";
  row.append(k, document.createTextNode(value));
  row.onclick = async () => {
    if (await copyText(value)) {
      row.classList.add("copied");
      setTimeout(() => row.classList.remove("copied"), 600);
    }
  };
}

/** Clipboard write with a legacy fallback for non-secure (plain http) contexts. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function fillSection(sel, text) {
  const sec = $(sel);
  sec.hidden = !text;
  if (text) sec.querySelector("p").textContent = text;
}

async function previewFile(relPath) {
  const pre = $("#file-preview");
  pre.hidden = false;
  pre.textContent = "loading…";
  try {
    const res = await fetch(`/api/file?path=${encodeURIComponent(relPath)}`, {
      headers: { "X-Session-Trail-Token": state.token || "" },
    });
    if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
    const text = await res.text();
    pre.textContent = text.length > 20000 ? text.slice(0, 20000) + "\n… (truncated)" : text;
  } catch (e) {
    pre.textContent = `(preview unavailable: ${e.message})`;
  }
}

function deselect(keepPanel) {
  if (state.selected) state.selected.classList.remove("selected");
  state.selected = null;
  if (!keepPanel) $("#detail").hidden = true;
}

// ---------- utils ----------

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * Wrap a node title into at most 2 lines of ~20 visual units
 * (CJK chars count double); overflow past line 2 gets an ellipsis.
 */
function wrapLabel(s, maxUnits = 20, maxLines = 2) {
  s = String(s).trim();
  const width = (str) => [...str].reduce((w, ch) => w + (/[ᄀ-퟿　-鿿豈-﫿＀-｠]/.test(ch) ? 2 : 1), 0);
  if (width(s) <= maxUnits) return [s];

  const lines = [];
  let rest = s;
  while (rest && lines.length < maxLines) {
    if (width(rest) <= maxUnits) {
      lines.push(rest);
      rest = "";
      break;
    }
    // find the widest prefix within maxUnits, preferring a space boundary
    let cut = 0, w = 0, lastSpace = -1;
    const chars = [...rest];
    for (let i = 0; i < chars.length; i++) {
      w += width(chars[i]);
      if (w > maxUnits) break;
      cut = i + 1;
      if (chars[i] === " ") lastSpace = i;
    }
    const breakAt = lastSpace > 0 && lines.length < maxLines - 1 ? lastSpace : cut;
    lines.push(chars.slice(0, breakAt).join("").trimEnd());
    rest = chars.slice(breakAt).join("").trimStart();
  }
  if (rest) lines[lines.length - 1] = truncate(lines[lines.length - 1], Math.max(4, lines[lines.length - 1].length - 1));
  return lines;
}

const pad = (n) => String(n).padStart(2, "0");

function fmtDate(ts, short) {
  const d = new Date(ts);
  if (isNaN(d)) return "";
  if (short) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtGap(ms) {
  const h = ms / 3600000;
  if (h < 24) return `${Math.round(h)}h`;
  const days = Math.round(h / 24);
  return days === 1 ? "1 day" : `${days} days`;
}
