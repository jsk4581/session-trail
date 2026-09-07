#!/usr/bin/env bash
# session-trail viewer launcher: starts the server in the background and prints one
# greppable READY line. Always exits 0; failures surface as an ERROR line.
# A running server is reused only while its code fingerprint matches the
# plugin's current source; otherwise it is restarted (same port when free).
set -u

ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
PROJECT="${1:-${CLAUDE_PROJECT_DIR:-$PWD}}"
HOST="${2:-${SESSION_TRAIL_HOST:-127.0.0.1}}"
HOST_EXPLICIT=0; [ -n "${2:-}${SESSION_TRAIL_HOST:-}" ] && HOST_EXPLICIT=1

DATA_DIR="$PROJECT/.session-trail"
mkdir -p "$DATA_DIR" 2>/dev/null || { echo "ERROR cannot create $DATA_DIR"; exit 0; }
LOG="$DATA_DIR/server.log"
PIDFILE="$DATA_DIR/server.pid"
INFOFILE="$DATA_DIR/server.info"

# Fingerprint of the server-side code (modules are loaded once per process).
CODE="$(cat "$ROOT"/bin/*.mjs "$ROOT"/lib/*.mjs 2>/dev/null | cksum | cut -d' ' -f1)"

WANT_PORT=0
if [ -f "$PIDFILE" ] && [ -f "$INFOFILE" ]; then
  PID="$(cat "$PIDFILE" 2>/dev/null)"
  INFO="$(cat "$INFOFILE" 2>/dev/null)"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    case "$INFO" in
      *" code=$CODE"*)
        case "$INFO" in
          *"url=http://$HOST:"*) echo "$INFO"; exit 0 ;;   # same code, same host: reuse
        esac
        # the default host is a fallback, not a demand: keep a server bound elsewhere
        [ "$HOST_EXPLICIT" = 0 ] && { echo "$INFO"; exit 0; } ;;
    esac
    # stale code or explicitly different host: restart, keeping the old port if possible
    WANT_PORT="$(printf '%s\n' "$INFO" | sed -n 's/.*port=\([0-9]*\).*/\1/p')"
    kill "$PID" 2>/dev/null
    for _ in $(seq 1 20); do kill -0 "$PID" 2>/dev/null || break; sleep 0.1; done
  fi
fi

start() {
  : > "$LOG"
  nohup node "$ROOT/bin/session-trail.mjs" serve --project "$PROJECT" --host "$HOST" --port "$1" >> "$LOG" 2>&1 &
  echo $! > "$PIDFILE"
  for _ in $(seq 1 50); do
    if READY_LINE="$(grep -m1 '^READY ' "$LOG" 2>/dev/null)" && [ -n "$READY_LINE" ]; then
      READY_LINE="$READY_LINE code=$CODE"
      echo "$READY_LINE" > "$INFOFILE"
      echo "$READY_LINE"
      return 0
    fi
    kill -0 "$(cat "$PIDFILE")" 2>/dev/null || return 1
    sleep 0.1
  done
  return 1
}

start "${WANT_PORT:-0}" && exit 0
[ "${WANT_PORT:-0}" != 0 ] && start 0 && exit 0   # old port taken: any free port

echo "ERROR server did not start; see $LOG"
exit 0
