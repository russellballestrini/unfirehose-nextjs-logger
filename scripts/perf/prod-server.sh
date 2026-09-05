#!/usr/bin/env bash
# A production server for measuring against — start, stop, status.
#
# `pkill -f "next start"` followed by `next start` is how twenty minutes were
# lost: the old process had not released the port, the new one died with
# EADDRINUSE into a log nobody read, and every measurement after that was of
# a build from before the change being measured. So this kills whatever owns
# the port by pid, waits until the port is actually free, starts, and then
# proves the *new* pid owns the port and answers before it says "up".
set -euo pipefail
PORT="${PORT:-3100}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOG="${LOG:-/tmp/unfirehose-prod-${PORT}.log}"

owner() { ss -lptnH "sport = :${PORT}" 2>/dev/null | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2; }

stop() {
  local pid; pid="$(owner || true)"
  [ -z "$pid" ] && { echo "nothing on :${PORT}"; return 0; }
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do [ -z "$(owner || true)" ] && { echo "stopped pid ${pid}"; return 0; }; sleep 0.25; done
  kill -9 "$pid" 2>/dev/null || true; sleep 0.5
  [ -z "$(owner || true)" ] && echo "killed pid ${pid}" || { echo "could not free :${PORT}" >&2; return 1; }
}

start() {
  stop >/dev/null
  ( cd "$ROOT/apps/web" && nohup npx next start -p "$PORT" >"$LOG" 2>&1 & )
  for _ in $(seq 1 120); do
    sleep 0.5
    local pid; pid="$(owner || true)"
    if [ -n "$pid" ] && curl -sf -o /dev/null "http://localhost:${PORT}/"; then
      echo "up: pid ${pid} on :${PORT} (log ${LOG})"; return 0
    fi
    if grep -q "EADDRINUSE\|Error:" "$LOG" 2>/dev/null; then
      echo "server failed to start:" >&2; tail -5 "$LOG" >&2; return 1
    fi
  done
  echo "server did not answer within 60s" >&2; tail -5 "$LOG" >&2; return 1
}

status() {
  local pid; pid="$(owner || true)"
  if [ -z "$pid" ]; then echo "down"; return 1; fi
  echo "up: pid ${pid} since $(ps -o lstart= -p "$pid" 2>/dev/null | xargs)  build $(cat "$ROOT/apps/web/.next/BUILD_ID" 2>/dev/null || echo '?')"
}

case "${1:-status}" in start) start;; stop) stop;; status) status;; *) echo "usage: $0 start|stop|status" >&2; exit 2;; esac
