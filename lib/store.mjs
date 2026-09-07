// sessiontrail event store: append-only JSONL under <project>/.sessiontrail/
// Zero dependencies. Pure functions + tiny fs helpers; no side effects at import.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const DATA_DIR_NAME = ".sessiontrail";
export const EVENTS_FILE = "events.jsonl";
export const GRAPH_CACHE = "graph.json";
export const SCHEMA_VERSION = 1;

/**
 * Resolve the project root directory.
 * Priority: explicit arg > $CLAUDE_PROJECT_DIR > walk up from cwd looking
 * for an existing .sessiontrail/ > cwd itself.
 */
export function resolveProjectDir(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.CLAUDE_PROJECT_DIR) return path.resolve(process.env.CLAUDE_PROJECT_DIR);
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, DATA_DIR_NAME))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function dataDir(projectDir) {
  return path.join(projectDir, DATA_DIR_NAME);
}

export function ensureDataDir(projectDir) {
  const dir = dataDir(projectDir);
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
  return dir;
}

/** Append one event as a single JSONL line (O_APPEND: atomic for small lines). */
export function appendEvent(projectDir, event) {
  const dir = ensureDataDir(projectDir);
  const line = JSON.stringify({ v: SCHEMA_VERSION, ts: new Date().toISOString(), ...event });
  fs.appendFileSync(path.join(dir, EVENTS_FILE), line + "\n");
  return event;
}

/** Read all events, tolerating corrupt/partial lines (skipped silently). */
export function readEvents(projectDir) {
  const file = path.join(dataDir(projectDir), EVENTS_FILE);
  if (!fs.existsSync(file)) return [];
  return parseLines(fs.readFileSync(file, "utf8"));
}

/** Read only the tail of the events file (O(bytes), not O(file)). */
export function tailEvents(projectDir, bytes = 65536) {
  const file = path.join(dataDir(projectDir), EVENTS_FILE);
  if (!fs.existsSync(file)) return [];
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - bytes);
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    // Drop the first partial line if we started mid-file.
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl === -1 ? "" : text.slice(nl + 1);
    }
    return parseLines(text);
  } finally {
    fs.closeSync(fd);
  }
}

function parseLines(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object" && obj.type) out.push(obj);
    } catch {
      // skip corrupt line
    }
  }
  return out;
}

// --- per-session marker files (dedupe + small state) ---

export function markerPath(projectDir, sid) {
  return path.join(dataDir(projectDir), "sessions", sanitize(sid) + ".json");
}

export function readMarker(projectDir, sid) {
  try {
    return JSON.parse(fs.readFileSync(markerPath(projectDir, sid), "utf8"));
  } catch {
    return null;
  }
}

export function writeMarker(projectDir, sid, marker) {
  ensureDataDir(projectDir);
  fs.writeFileSync(markerPath(projectDir, sid), JSON.stringify(marker));
}

/** Newest session marker by mtime: heuristic sid for CLI calls from Bash. */
export function newestSessionId(projectDir) {
  const dir = path.join(dataDir(projectDir), "sessions");
  if (!fs.existsSync(dir)) return null;
  let best = null;
  let bestM = -1;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const m = fs.statSync(path.join(dir, f)).mtimeMs;
    if (m > bestM) {
      bestM = m;
      best = f.slice(0, -5);
    }
  }
  return best;
}

function sanitize(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Sortable, collision-safe milestone id (3 random bytes ≈ 16.7M/ms space). */
export function newMilestoneId(now = Date.now()) {
  return "m-" + now.toString(36) + "-" + crypto.randomBytes(3).toString("hex");
}

/** Relativize an absolute path against the project dir; null if outside. */
export function relativizePath(projectDir, absPath) {
  if (!absPath) return null;
  const rel = path.relative(path.resolve(projectDir), path.resolve(absPath));
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  if (rel === DATA_DIR_NAME || rel.startsWith(DATA_DIR_NAME + path.sep)) return null;
  return rel.split(path.sep).join("/");
}
