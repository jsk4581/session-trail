---
description: Open the sessiontrail timeline viewer for this project
allowed-tools: Bash(bash "${CLAUDE_PLUGIN_ROOT}/scripts/launch.sh" *)
disable-model-invocation: true
---

!`bash "${CLAUDE_PLUGIN_ROOT}/scripts/launch.sh" "${CLAUDE_PROJECT_DIR}"`

The launcher output is shown above.

- If it contains a `READY` line, give the user the full `url=` value as a clickable link and tell them the timeline viewer is running. The token in the URL is required on first open.
- If it contains an `ERROR` line, show the user the error and the log path it mentions.

Do not start the server yourself with any other command; the launcher already handled it (it reuses a running server for this project, or restarts it when the plugin code changed).
