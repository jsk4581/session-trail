---
description: Record a milestone on the sessiontrail timeline
argument-hint: <what happened and why it matters>
allowed-tools: Agent, Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/sessiontrail.mjs" *)
---

Record a milestone on this project's sessiontrail timeline for: $ARGUMENTS

1. From the request and the conversation, prepare a brief: kind (decision | action | merge), a one- or two-line gist, the rejected alternatives and why, the mechanism (key files, commands), an optional merge target node id (run `node "${CLAUDE_PLUGIN_ROOT}/bin/sessiontrail.mjs" recent` if you need candidates), and the user's working language.
2. Delegate the write-up with the Agent tool: subagent_type "sessiontrail:sessiontrail-scribe", model "sonnet". Include `cli: ${CLAUDE_PLUGIN_ROOT}/bin/sessiontrail.mjs` in the brief. Wait for it this time (the user asked explicitly) and report the node id and title it returns.
3. If the Agent tool is unavailable, compose the fields yourself following the scribe's rules and run the `add` heredoc directly.
