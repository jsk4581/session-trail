// Builds the SessionStart additionalContext text: the milestone-recording
// protocol plus a digest of recent nodes (usable as merge targets).

/**
 * @param {object} o
 * @param {string} o.cliPath absolute path to bin/session-trail.mjs
 * @param {Array}  o.recent  recent milestone events (newest last)
 */
export function buildProtocol({ cliPath, recent = [] }) {
  const digest = recent.length
    ? "\nRecent timeline nodes (usable as merge targets in \"merges\"):\n" +
      recent
        .map((m) => `  ${m.id} · ${truncate(m.title, 48)} · ${(m.ts || "").slice(0, 10)}`)
        .join("\n")
    : "";

  return `session-trail is active: this project's development history is recorded as a timeline.
When you make a significant decision or complete a significant piece of work, hand the write-up to the session-trail scribe subagent. Do not write the milestone yourself.

Delegate with the Agent tool: subagent_type "session-trail:session-trail-scribe", model "sonnet", run in the background and keep working (never wait for it). Give it a brief:
  kind: decision | action | merge
  gist: one or two lines on what was decided/done
  rejected: the alternatives you passed on and why
  mechanism: key files, commands, approach
  merges: node id this continues or closes (optional, from the list below)
  cli: ${cliPath}
  language: the language the user writes to you in
If the Agent tool is unavailable, run the CLI yourself instead:
  node "${cliPath}" add <<'JSON'
  {"kind":"decision","title":"...","what":"...","why":"...","how":"...","merges":[]}
  JSON

Delegate (typically 1-5 per session):
- a choice between alternatives with lasting consequences (architecture, library, data model, API shape) -> decision
- a completed unit of work (feature, bugfix, refactor landed) -> action
- reversing or abandoning an earlier approach -> decision
- work that continues or closes a line from a previous session -> merge, with the target node id

Do NOT record: exploration, routine edits, formatting, intermediate steps, answering questions.
Delegation must never delay your reply: launch it alongside your other tool calls, never as its own standalone turn. Files you create/edit and every user prompt are captured automatically.${digest}`;
}

export function recentMilestones(events, n = 10) {
  return events.filter((e) => e.type === "milestone" && e.id && !e.auto).slice(-n);
}

function truncate(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
