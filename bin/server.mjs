// session-trail viewer server: zero-dependency node:http.
// Serves the static viewer plus token-gated data endpoints:
//   GET /api/graph            -> reduced timeline graph (paths already relative)
//   GET /api/file?path=<rel>  -> artifact file preview (allowlisted, 1MB cap)
// Prints exactly one greppable line on start:
//   READY port=<P> token=<T> url=http://<host>:<P>/?t=<T>

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { readEvents, dataDir, GRAPH_CACHE, EVENTS_FILE } from "../lib/store.mjs";
import { reduce } from "../lib/graph.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const VIEWER_DIR = path.resolve(here, "..", "viewer");
const MAX_FILE_BYTES = 1024 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

export function startServer({ project, host = "127.0.0.1", port = 0, fixtureFile = null }) {
  const token = process.env.SESSION_TRAIL_TOKEN || crypto.randomBytes(16).toString("hex");

  const loadGraph = () => {
    if (fixtureFile) {
      const events = fs
        .readFileSync(fixtureFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      return reduce(events, { project: "fixture" });
    }
    const eventsPath = path.join(dataDir(project), EVENTS_FILE);
    const cachePath = path.join(dataDir(project), GRAPH_CACHE);
    try {
      const eventsM = fs.statSync(eventsPath).mtimeMs;
      const cacheM = fs.statSync(cachePath).mtimeMs;
      if (cacheM >= eventsM) return JSON.parse(fs.readFileSync(cachePath, "utf8"));
    } catch {
      /* rebuild */
    }
    const graph = reduce(readEvents(project), { project: path.basename(project) });
    try {
      fs.mkdirSync(dataDir(project), { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify(graph));
    } catch {
      /* cache write is best-effort */
    }
    return graph;
  };

  const server = http.createServer((req, res) => {
    try {
      handle(req, res);
    } catch {
      send(res, 500, "text/plain", "internal error");
    }
  });

  function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const p = url.pathname;

    if (p.startsWith("/api/")) {
      const supplied = url.searchParams.get("t") || req.headers["x-session-trail-token"];
      if (supplied !== token) {
        return send(res, 401, "application/json", JSON.stringify({ error: "unauthorized" }));
      }
      if (p === "/api/graph") {
        return send(res, 200, MIME[".json"], JSON.stringify(loadGraph()));
      }
      if (p === "/api/file") {
        return serveArtifact(url, res);
      }
      return send(res, 404, "application/json", JSON.stringify({ error: "not found" }));
    }

    // Static viewer files (no token needed; they contain no data).
    const rel = p === "/" ? "index.html" : p.replace(/^\/+/, "");
    const full = path.resolve(VIEWER_DIR, rel);
    if (full !== VIEWER_DIR && !full.startsWith(VIEWER_DIR + path.sep)) {
      return send(res, 403, "text/plain", "forbidden");
    }
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      return send(res, 404, "text/plain", "not found");
    }
    const body = fs.readFileSync(full);
    send(res, 200, MIME[path.extname(full)] || "application/octet-stream", body);
  }

  function serveArtifact(url, res) {
    const relPath = url.searchParams.get("path") || "";
    if (!relPath || relPath.includes("..") || path.isAbsolute(relPath) || fixtureFile) {
      return send(res, 400, "application/json", JSON.stringify({ error: "bad path" }));
    }
    // Allowlist: only paths present as artifacts in the current graph.
    const graph = loadGraph();
    const allowed = new Set();
    for (const n of graph.nodes) for (const a of n.artifacts || []) allowed.add(a.path);
    if (!allowed.has(relPath)) {
      return send(res, 403, "application/json", JSON.stringify({ error: "not an artifact" }));
    }
    const full = path.resolve(project, relPath);
    if (!full.startsWith(path.resolve(project) + path.sep)) {
      return send(res, 403, "application/json", JSON.stringify({ error: "forbidden" }));
    }
    if (!fs.existsSync(full)) {
      return send(res, 404, "application/json", JSON.stringify({ error: "file gone" }));
    }
    const stat = fs.statSync(full);
    if (stat.size > MAX_FILE_BYTES) {
      return send(res, 413, "application/json", JSON.stringify({ error: "file too large" }));
    }
    const buf = fs.readFileSync(full);
    if (buf.includes(0)) {
      return send(res, 415, "application/json", JSON.stringify({ error: "binary file" }));
    }
    send(res, 200, "text/plain; charset=utf-8", buf);
  }

  function send(res, status, type, body) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    res.writeHead(status, {
      "Content-Type": type,
      "Content-Length": buf.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(buf);
  }

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const actualPort = server.address().port;
      const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
      console.log(`READY port=${actualPort} token=${token} url=http://${displayHost}:${actualPort}/?t=${token}`);
      resolve({ server, port: actualPort, token });
    });
  });
}
