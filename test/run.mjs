import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { reduce } from "../lib/graph.mjs";
import {
  appendEvent,
  readEvents,
  tailEvents,
  relativizePath,
  newMilestoneId,
  readMarker,
  writeMarker,
  newestSessionId,
} from "../lib/store.mjs";
import { buildProtocol, recentMilestones } from "../lib/protocol.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureEvents = fs
  .readFileSync(path.join(here, "fixtures", "events.fixture.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

// ---------- graph.mjs ----------

test("reduce: one lane per session, slots alternate and free up", () => {
  const g = reduce(fixtureEvents);
  assert.equal(g.lanes.length, 4);
  const slots = g.lanes.map((l) => l.slot);
  // sid1 +1, sid2 overlaps -> -1, sid3 three days later reuses +1, sid4 overlaps sid3 -> -1
  assert.deepEqual(slots, [1, -1, 1, -1]);
});

test("reduce: lane titles backfilled onto lane and head node", () => {
  const g = reduce(fixtureEvents);
  const lane1 = g.lanes[0];
  assert.equal(lane1.title, "Bootstrap project");
  const head = g.nodes.find((n) => n.id === lane1.laneId);
  assert.equal(head.title, "Bootstrap project");
});

test("reduce: session transcript path carried onto the lane", () => {
  const g = reduce(fixtureEvents);
  assert.equal(g.lanes[0].transcript, "/home/user/.claude/projects/-home-user-proj/sid1.jsonl");
  assert.equal(g.lanes[1].transcript, null); // sid2 has no transcript recorded
});

test("reduce: touches attach to next milestone, deduped, create wins", () => {
  const g = reduce(fixtureEvents);
  const m1 = g.nodes.find((n) => n.id === "m-1");
  assert.equal(m1.artifacts.length, 2);
  const idx = m1.artifacts.find((a) => a.path === "src/index.ts");
  assert.equal(idx.verb, "create"); // create beats the later edit
});

test("reduce: trailing touches attach to last milestone", () => {
  const g = reduce(fixtureEvents);
  const m4 = g.nodes.find((n) => n.id === "m-4");
  const paths = m4.artifacts.map((a) => a.path).sort();
  assert.deepEqual(paths, ["src/auth.test.ts", "src/auth.ts"]);
});

test("reduce: lane edges chain head -> milestones in order", () => {
  const g = reduce(fixtureEvents);
  const laneEdges = g.edges.filter((e) => e.type === "lane");
  assert.equal(laneEdges.length, 5);
  assert.ok(laneEdges.some((e) => e.from === "s-sid1" && e.to === "m-1"));
  assert.ok(laneEdges.some((e) => e.from === "m-1" && e.to === "m-3"));
});

test("reduce: merge edges created, unknown targets dropped silently", () => {
  const g = reduce(fixtureEvents);
  const merges = g.edges.filter((e) => e.type === "merge");
  assert.equal(merges.length, 2);
  assert.ok(merges.some((e) => e.from === "m-1" && e.to === "m-2"));
  assert.ok(merges.some((e) => e.from === "m-3" && e.to === "m-4"));
});

test("reduce: auto milestone kept and flagged", () => {
  const g = reduce(fixtureEvents);
  const m5 = g.nodes.find((n) => n.id === "m-5");
  assert.equal(m5.auto, true);
});

test("reduce: duplicate session events do not open extra lanes", () => {
  const dup = [...fixtureEvents, { v: 1, ts: "2026-08-05T00:00:00.000Z", type: "session", sid: "sid1", source: "resume" }];
  const g = reduce(dup);
  assert.equal(g.lanes.length, 4);
});

test("reduce: sorts by ts, not file order", () => {
  const reversed = [...fixtureEvents].reverse();
  const g = reduce(reversed);
  assert.equal(g.lanes.length, 4);
  assert.deepEqual(g.lanes.map((l) => l.slot), [1, -1, 1, -1]);
});

// ---------- store.mjs ----------

test("store: append/read/tail roundtrip, corrupt lines skipped", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sessiontrail-test-"));
  try {
    appendEvent(tmp, { type: "session", sid: "x1", source: "startup" });
    appendEvent(tmp, { type: "touch", sid: "x1", path: "a.txt", verb: "create" });
    fs.appendFileSync(path.join(tmp, ".sessiontrail", "events.jsonl"), "{broken json\n");
    appendEvent(tmp, { type: "session_end", sid: "x1", reason: "exit" });

    const all = readEvents(tmp);
    assert.equal(all.length, 3);
    assert.equal(all[0].v, 1);
    assert.ok(all[0].ts);

    const tail = tailEvents(tmp, 200); // small window -> partial first line dropped
    assert.ok(tail.length >= 1 && tail.length <= 3);
    assert.equal(tail[tail.length - 1].type, "session_end");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("store: relativizePath guards project boundary and .sessiontrail", () => {
  const proj = "/tmp/proj";
  assert.equal(relativizePath(proj, "/tmp/proj/src/a.ts"), "src/a.ts");
  assert.equal(relativizePath(proj, "/tmp/other/a.ts"), null);
  assert.equal(relativizePath(proj, "/tmp/proj/.sessiontrail/events.jsonl"), null);
  assert.equal(relativizePath(proj, null), null);
});

test("store: markers + newestSessionId", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sessiontrail-test-"));
  try {
    writeMarker(tmp, "aaa", { seen: true, titled: false });
    const m = readMarker(tmp, "aaa");
    assert.equal(m.seen, true);
    assert.equal(readMarker(tmp, "zzz"), null);
    writeMarker(tmp, "bbb", { seen: true, titled: false });
    fs.utimesSync(path.join(tmp, ".sessiontrail", "sessions", "bbb.json"), new Date(), new Date(Date.now() + 5000));
    assert.equal(newestSessionId(tmp), "bbb");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("store: milestone ids sortable and unique-ish", () => {
  // realistic epoch-ms timestamps have equal base36 length -> string-sortable
  const a = newMilestoneId(1700000000000);
  const b = newMilestoneId(1800000000000);
  assert.ok(a.startsWith("m-"));
  assert.ok(a.slice(2) < b.slice(2));
  const ids = new Set(Array.from({ length: 200 }, () => newMilestoneId()));
  assert.equal(ids.size, 200);
});

// ---------- protocol.mjs ----------

test("protocol: text is bounded and contains the CLI heredoc + digest", () => {
  const recent = recentMilestones(fixtureEvents, 10);
  assert.equal(recent.length, 4); // m-5 is auto -> excluded
  const text = buildProtocol({ cliPath: "/opt/plug/bin/sessiontrail.mjs", recent });
  assert.ok(text.includes('sessiontrail:sessiontrail-scribe'));
  assert.ok(text.includes('cli: /opt/plug/bin/sessiontrail.mjs'));
  assert.ok(text.includes("m-4"));
  assert.ok(text.length < 1900, `protocol too long: ${text.length}`);
});

test("reduce: prompts are a separate low-key series, not nodes or edges", () => {
  const g = reduce(fixtureEvents);
  assert.equal(g.prompts.length, 3);
  assert.equal(g.prompts.filter((p) => p.laneId === "s-sid1").length, 2);
  assert.ok(g.prompts.every((p) => p.id.startsWith("p-") && p.text));
  assert.equal(g.nodes.filter((n) => n.kind === "prompt").length, 0);
  assert.equal(g.edges.length, 7); // unchanged: 5 lane + 2 merge
  // prompts must not steal touch attribution
  const m1 = g.nodes.find((n) => n.id === "m-1");
  assert.equal(m1.artifacts.length, 2);
});
