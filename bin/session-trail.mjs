#!/usr/bin/env node
// session-trail CLI: add | recent | show | why | search | build | serve | doctor
// `add` reads milestone JSON from stdin (heredoc-friendly) and always exits 0,
// printing {ok:true,id} or {ok:false,error:"..."} so a calling agent can react.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveProjectDir,
  dataDir,
  ensureDataDir,
  appendEvent,
  readEvents,
  readMarker,
  writeMarker,
  newestSessionId,
  newMilestoneId,
  EVENTS_FILE,
  GRAPH_CACHE,
} from "../lib/store.mjs";
import { reduce } from "../lib/graph.mjs";
import { showNode, whyPath, search, recent } from "../lib/query.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const KINDS = new Set(["decision", "action", "merge"]);

const { cmd, opts, positional } = parseArgv(process.argv.slice(2));
// Piping into `head` closes stdout early; that is not an error worth a stack trace.
process.stdout.on("error", (e) => { if (e.code === "EPIPE") process.exit(0); throw e; });

switch (cmd) {
  case "add":
    cmdAdd();
    break;
  case "recent":
    cmdRecent();
    break;
  case "show":
    cmdShow();
    break;
  case "why":
    cmdWhy();
    break;
  case "search":
    cmdSearch();
    break;
  case "build":
    cmdBuild();
    break;
  case "serve":
    await cmdServe();
    break;
  case "doctor":
    cmdDoctor();
    break;
  default:
    print(
      "session-trail: project development-history timeline\n" +
        "usage: session-trail.mjs <add|recent|show|why|search|build|serve|doctor> [--project DIR] [--sid ID]\n" +
        "  add     read milestone JSON from stdin (or --json '...') and append it\n" +
        "  recent  list recent milestone nodes  [--n 10] [--session last|<sid>|all] [--auto]\n" +
        "  show    one node in full: what/why/how, artifacts, session, merges   show <id>\n" +
        "  why     milestones that touched a file or directory                 why <path>\n" +
        "  search  substring search over milestones and user prompts  [--n 20] search <text>\n" +
        "  build   force-rebuild .session-trail/graph.json\n" +
        "  serve   start the timeline viewer  [--host 127.0.0.1] [--port 0] [--fixture]\n" +
        "  doctor  sanity-check the installation"
    );
}

function cmdAdd() {
  try {
    const project = resolveProjectDir(opts.project);
    const raw = opts.json ?? fs.readFileSync(0, "utf8");
    let m;
    try {
      m = lenientParse(raw);
    } catch (e) {
      return print(JSON.stringify({ ok: false, error: "invalid JSON: " + e.message }));
    }

    const kind = m.kind || "action";
    if (!KINDS.has(kind))
      return print(JSON.stringify({ ok: false, error: `kind must be one of decision|action|merge` }));
    const title = String(m.title || "").trim();
    if (!title) return print(JSON.stringify({ ok: false, error: "title is required" }));
    if (title.length > 120)
      return print(JSON.stringify({ ok: false, error: "title too long (max 120 chars)" }));
    const merges = Array.isArray(m.merges) ? m.merges.map(String).filter(Boolean) : [];

    // Session id: explicit flag > newest live session marker > synthetic CLI lane.
    let sid = opts.sid || newestSessionId(project);
    if (!sid) {
      sid = "cli-" + new Date().toISOString().slice(0, 10);
      if (!readMarker(project, sid)) {
        appendEvent(project, { type: "session", sid, source: "cli", cwd: project });
        writeMarker(project, sid, { seen: true, titled: true });
      }
    }

    const id = newMilestoneId();
    appendEvent(project, {
      type: "milestone",
      id,
      sid,
      kind,
      title,
      what: String(m.what || ""),
      why: String(m.why || ""),
      how: String(m.how || ""),
      auto: false,
      merges,
    });
    const result = { ok: true, id };
    if (title.length > 40) {
      result.warning = "title longer than 40 chars: keep titles to a short 2-6 word label and put detail in what/why/how";
    }
    print(JSON.stringify(result));
  } catch (e) {
    print(JSON.stringify({ ok: false, error: e.message }));
  }
  process.exit(0);
}

function cmdRecent() {
  const project = resolveProjectDir(opts.project);
  const { lane, nodes } = recent(readEvents(project), {
    n: Number(opts.n) || 10,
    session: typeof opts.session === "string" ? opts.session : undefined,
    includeAuto: !!opts.auto,
  });
  if (opts.session && opts.session !== "all" && !lane) return print(`(no session matching "${opts.session}")`);
  if (lane) print(`session ${lane.sid}  ${lane.title || ""}  (${fmtTs(lane.startTs)})`);
  if (!nodes.length) return print("(no milestones yet)");
  for (const m of nodes) print(nodeLine(m));
}

function cmdShow() {
  const id = positional[0];
  if (!id) return print("usage: show <node-id>");
  const project = resolveProjectDir(opts.project);
  const n = showNode(readEvents(project), id);
  if (!n) return print(`(no node ${id})`);
  print(nodeLine(n));
  if (n.session) {
    print(`session: ${n.session.sid}${n.session.title ? "  " + n.session.title : ""}`);
    if (n.session.transcript) print(`log: ${n.session.transcript}`);
  }
  if (n.merges.length) print(`continues: ${n.merges.map((m) => `${m.id} (${m.title || "?"})`).join(", ")}`);
  if (n.mergedBy.length) print(`continued by: ${n.mergedBy.map((m) => `${m.id} (${m.title || "?"})`).join(", ")}`);
  for (const f of ["what", "why", "how"]) if (n[f]) print(`${f}: ${n[f]}`);
  const arts = n.artifacts || [];
  if (arts.length) {
    print(`artifacts (${arts.length}):`);
    for (const a of arts) print(`  ${a.verb.padEnd(6)} ${a.path}`);
  }
}

function cmdWhy() {
  const target = positional[0];
  if (!target) return print("usage: why <path>   (file, or directory ending with /)");
  const project = resolveProjectDir(opts.project);
  let rel = target;
  if (path.isAbsolute(target)) {
    rel = path.relative(project, target);
    if (fs.existsSync(target) && fs.statSync(target).isDirectory() && !rel.endsWith("/")) rel += "/";
  }
  const hits = whyPath(readEvents(project), rel);
  if (!hits.length) return print(`(no milestone touched ${rel})`);
  print(`${hits.length} milestone(s) touched ${rel} (oldest first):`);
  for (const n of hits) {
    print(nodeLine(n));
    if (n.why) print(`  why: ${opts.full ? n.why : clip(n.why, 240)}`);
  }
}

function cmdSearch() {
  const term = positional.join(" ");
  if (!term.trim()) return print("usage: search <text>");
  const project = resolveProjectDir(opts.project);
  const hits = search(readEvents(project), term, { limit: Number(opts.n) || 20 });
  if (!hits.length) return print(`(no match for "${term}")`);
  for (const h of hits) {
    if (h.type === "milestone") print(`${h.id}  [${h.kind}]  ${h.title}  (${fmtTs(h.ts)})  ${h.field}: ${h.snippet}`);
    else print(`prompt  (${fmtTs(h.ts)}, session ${String(h.sid || "").slice(0, 8)})  ${h.snippet}`);
  }
}

function nodeLine(n) {
  return `${n.id}  [${n.kind}${n.auto ? ", auto" : ""}]  ${n.title}  (${fmtTs(n.ts)})`;
}

function fmtTs(ts) {
  return String(ts || "").slice(0, 16).replace("T", " ");
}

function clip(s, n) {
  s = String(s).replace(/\s+/g, " ");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function cmdBuild() {
  const project = resolveProjectDir(opts.project);
  const graph = reduce(readEvents(project), { project: path.basename(project) });
  ensureDataDir(project);
  const out = path.join(dataDir(project), GRAPH_CACHE);
  fs.writeFileSync(out, JSON.stringify(graph, null, 2));
  print(`wrote ${out} (${graph.lanes.length} lanes, ${graph.nodes.length} nodes, ${graph.edges.length} edges)`);
}

async function cmdServe() {
  const { startServer } = await import("./server.mjs");
  const project = resolveProjectDir(opts.project);
  const fixture = opts.fixture
    ? path.resolve(here, "..", "test", "fixtures", "events.fixture.jsonl")
    : null;
  await startServer({
    project,
    host: opts.host || "127.0.0.1",
    port: Number(opts.port) || 0,
    fixtureFile: typeof opts.fixture === "string" ? path.resolve(opts.fixture) : fixture,
  });
}

function cmdDoctor() {
  const project = resolveProjectDir(opts.project);
  const checks = [];
  const [maj] = process.versions.node.split(".").map(Number);
  checks.push([maj >= 18, `node >= 18 (found ${process.versions.node})`]);
  let writable = false;
  try {
    ensureDataDir(project);
    fs.accessSync(dataDir(project), fs.constants.W_OK);
    writable = true;
  } catch {}
  checks.push([writable, `.session-trail/ writable at ${dataDir(project)}`]);
  const eventsFile = path.join(dataDir(project), EVENTS_FILE);
  const n = fs.existsSync(eventsFile) ? readEvents(project).length : 0;
  checks.push([true, `${n} event(s) recorded`]);
  checks.push([
    !!process.env.CLAUDE_PLUGIN_ROOT,
    "running inside Claude Code (CLAUDE_PLUGIN_ROOT set): informational",
  ]);
  for (const [ok, label] of checks) print(`${ok ? "ok " : "FAIL"} ${label}`);
}

/**
 * JSON.parse that tolerates literal control characters (newlines, tabs)
 * inside string literals: LLMs writing heredocs produce these routinely.
 */
function lenientParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    let out = "";
    let inString = false;
    let escaped = false;
    for (const ch of raw) {
      if (inString) {
        if (escaped) {
          out += ch;
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          out += ch;
          escaped = true;
          continue;
        }
        if (ch === '"') {
          inString = false;
          out += ch;
          continue;
        }
        const code = ch.charCodeAt(0);
        if (code < 0x20) {
          out += code === 10 ? "\\n" : code === 9 ? "\\t" : code === 13 ? "" : "\\u" + code.toString(16).padStart(4, "0");
          continue;
        }
        out += ch;
      } else {
        if (ch === '"') inString = true;
        out += ch;
      }
    }
    return JSON.parse(out);
  }
}

function parseArgv(argv) {
  const cmd = argv[0];
  const opts = {};
  const positional = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      opts[key] = next;
      i++;
    } else {
      opts[key] = true;
    }
  }
  return { cmd, opts, positional };
}

function print(s) {
  process.stdout.write(s + "\n");
}
