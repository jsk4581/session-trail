#!/usr/bin/env node
// sessiontrail hook dispatcher: one script for all events.
// Invariants: always exits 0; only SessionStart writes to stdout
// (stray stdout on other events would pollute the model's context).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendEvent,
  tailEvents,
  readEvents,
  readMarker,
  writeMarker,
  relativizePath,
  newMilestoneId,
} from "../lib/store.mjs";
import { buildProtocol, recentMilestones } from "../lib/protocol.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

main();

function main() {
  try {
    const event = process.argv[2];
    const payload = JSON.parse(fs.readFileSync(0, "utf8"));
    const handlers = {
      SessionStart: onSessionStart,
      UserPromptSubmit: onUserPrompt,
      PostToolUse: onPostToolUse,
      Stop: onStop,
      SessionEnd: onSessionEnd,
    };
    const handler = handlers[event || payload.hook_event_name];
    if (handler) handler(payload);
  } catch {
    // never break a session over a recording failure
  }
  process.exit(0);
}

/** Ensure the session lane exists (self-heals if the plugin was enabled mid-session). */
function ensureSession(project, payload, source = "startup") {
  const sid = payload.session_id;
  if (!sid) return null;
  let marker = readMarker(project, sid);
  if (!marker) {
    if (source !== "compact") {
      appendEvent(project, {
        type: "session",
        sid,
        source,
        cwd: project,
        transcript: payload.transcript_path || null,
      });
    }
    marker = { seen: true, titled: false };
    writeMarker(project, sid, marker);
  }
  return marker;
}

function onSessionStart(payload) {
  const project = payload.cwd;
  if (!project || !payload.session_id) return;
  ensureSession(project, payload, payload.source || "startup");

  const cliPath = path.resolve(here, "..", "bin", "sessiontrail.mjs");
  const recent = recentMilestones(tailEvents(project), 10);
  const text = buildProtocol({ cliPath, recent });
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
    })
  );
}

/** Every user chat message, recorded mechanically (no model involved). */
function onUserPrompt(payload) {
  const project = payload.cwd;
  const sid = payload.session_id;
  const text = String(payload.prompt || "").trim();
  if (!project || !sid || !text) return;
  // Claude Code injects system messages that arrive through the same hook; they are not user prompts.
  if (/^<(task-notification|system-reminder|local-command-caveat|command-name)/.test(text)) return;
  if (/^\[Request interrupted by user/.test(text)) return;
  ensureSession(project, payload);
  appendEvent(project, {
    type: "prompt",
    sid,
    pid: payload.prompt_id,
    text: text.length > 2000 ? text.slice(0, 2000) + "…" : text,
  });
}

function onPostToolUse(payload) {
  const project = payload.cwd;
  const sid = payload.session_id;
  if (!project || !sid) return;

  const input = payload.tool_input || {};
  const abs = input.file_path || input.notebook_path;
  const rel = relativizePath(project, abs);
  if (!rel) return; // outside project, or under .sessiontrail/

  ensureSession(project, payload);

  let verb = "edit";
  if (payload.tool_name === "Write") {
    const resp = JSON.stringify(payload.tool_response || "");
    verb = resp.includes('"create"') ? "create" : "write";
  }
  appendEvent(project, {
    type: "touch",
    sid,
    path: rel,
    verb,
    tool: payload.tool_name,
    pid: payload.prompt_id,
  });
}

function onStop(payload) {
  const project = payload.cwd;
  const sid = payload.session_id;
  if (!project || !sid) return;
  const marker = readMarker(project, sid);
  if (!marker || marker.titled) return;

  const title = extractAiTitle(payload.transcript_path);
  if (title) {
    appendEvent(project, { type: "title", sid, title });
    writeMarker(project, sid, { ...marker, titled: true });
  }
}

function onSessionEnd(payload) {
  const project = payload.cwd;
  const sid = payload.session_id;
  if (!project || !sid) return;
  if (!readMarker(project, sid)) return; // never saw this session: nothing to close

  // Last-chance title backfill before summarizing.
  onStop(payload);

  const events = readEvents(project).filter((e) => e.sid === sid);
  const touches = events.filter((e) => e.type === "touch");
  const milestones = events.filter((e) => e.type === "milestone");

  // Safety net: session did real work but the model recorded nothing.
  if (touches.length > 0 && milestones.length === 0) {
    const titleEvent = events.find((e) => e.type === "title");
    const day = (events[0]?.ts || new Date().toISOString()).slice(0, 10);
    appendEvent(project, {
      type: "milestone",
      id: newMilestoneId(),
      sid,
      kind: "action",
      title: titleEvent?.title || `Session on ${day}`,
      what: `Auto-recorded: ${touches.length} file change(s) in this session.`,
      why: "",
      how: "",
      auto: true,
      merges: [],
    });
  }

  appendEvent(project, { type: "session_end", sid, reason: payload.reason || "other" });
}

/** Find the ai-title entry in the transcript JSONL (searched from the end). */
function extractAiTitle(transcriptPath) {
  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
    const lines = fs.readFileSync(transcriptPath, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"ai-title"')) continue;
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.type === "ai-title" && obj.aiTitle) return String(obj.aiTitle);
      } catch {
        /* keep scanning */
      }
    }
  } catch {
    /* unreadable transcript */
  }
  return null;
}
