#!/usr/bin/env node
// session-trail CLI: add | recent | build | serve | doctor
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
  tailEvents,
  readMarker,
  writeMarker,
  newestSessionId,
  newMilestoneId,
  EVENTS_FILE,
  GRAPH_CACHE,
} from "../lib/store.mjs";
import { reduce } from "../lib/graph.mjs";
import { recentMilestones } from "../lib/protocol.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const KINDS = new Set(["decision", "action", "merge"]);

const { cmd, opts } = parseArgv(process.argv.slice(2));

switch (cmd) {
  case "add":
    cmdAdd();
    break;
  case "recent":
    cmdRecent();
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
        "usage: session-trail.mjs <add|recent|build|serve|doctor> [--project DIR] [--sid ID]\n" +
        "  add     read milestone JSON from stdin (or --json '...') and append it\n" +
        "  recent  list recent milestone nodes (merge targets)  [--n 10]\n" +
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
  const recent = recentMilestones(tailEvents(project, 256 * 1024), Number(opts.n) || 10);
  if (!recent.length) return print("(no milestones yet)");
  for (const m of recent) {
    print(`${m.id}  [${m.kind}]  ${m.title}  (${(m.ts || "").slice(0, 10)})`);
  }
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
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      opts[key] = next;
      i++;
    } else {
      opts[key] = true;
    }
  }
  return { cmd, opts };
}

function print(s) {
  process.stdout.write(s + "\n");
}
