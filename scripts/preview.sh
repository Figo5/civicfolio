#!/usr/bin/env bash
# Isolated preview of the Deep Research experiment.
#
#   ./scripts/preview.sh start | stop | status
#
# What makes this safe to leave running:
#   * its own port (8788) -- production stays on 8787, untouched
#   * its own data directory (~/.civicfolio-preview) -- the production store at
#     ~/.civicfolio is never read or written, so there is no portfolio to move
#   * the paper-fund scheduler (launchd local.civicfolio.fund) posts to 8787 and
#     only to 8787, so it can never drive a run in here
#   * CIVICFOLIO_DEEP_RESEARCH is set for THIS process only; nothing is written
#     to any .env, and production's configuration is not modified
#
# The OpenAI key is read at launch from the existing server-side env file and
# exported to the child process only. It is never printed, logged, or written
# into a tracked file.
set -euo pipefail

PORT="${CIVICFOLIO_PREVIEW_PORT:-8788}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${CIVICFOLIO_PREVIEW_DATA_DIR:-$HOME/.civicfolio-preview}"
PID_FILE="$DATA_DIR/preview.pid"
LOG_FILE="$DATA_DIR/preview.log"
# Where a real key already lives, in preference order. Never copied, only read.
KEY_SOURCES=("$HOME/.civicfolio/env" "$HOME/Documents/Codex/civicfolio/.env")

die() { echo "error: $*" >&2; exit 1; }

load_key() {
  for f in "${KEY_SOURCES[@]}"; do
    [ -f "$f" ] || continue
    local v
    v="$(sed -n 's/^OPENAI_API_KEY=//p' "$f" | tail -1 | tr -d '\r')"
    if [ -n "$v" ]; then
      export OPENAI_API_KEY="$v"
      echo "using OPENAI_API_KEY from $f (value not shown)"
      return 0
    fi
  done
  echo "note: no OPENAI_API_KEY found; the preview will run but Deep Research will"
  echo "      refuse with a configuration error instead of calling anything."
}

start() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "already running: pid $(cat "$PID_FILE") on http://127.0.0.1:$PORT"; return 0
  fi
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    die "port $PORT is already in use by something else; set CIVICFOLIO_PREVIEW_PORT"
  fi
  [ "$PORT" != "8787" ] || die "refusing to start on the production port"
  mkdir -p "$DATA_DIR"
  load_key

  # Refuse to run against the production store even if someone overrides it.
  case "$DATA_DIR" in
    "$HOME/.civicfolio"|"$HOME/.civicfolio/") die "refusing to use the production data dir" ;;
  esac

  cd "$ROOT"
  CIVICFOLIO_PORT="$PORT" \
  CIVICFOLIO_DATA_DIR="$DATA_DIR" \
  CIVICFOLIO_DEEP_RESEARCH=1 \
  nohup node --import tsx server/src/index.ts >"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  sleep 3
  if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    die "failed to start; see $LOG_FILE"
  fi
  echo "preview running: http://127.0.0.1:$PORT  (pid $(cat "$PID_FILE"))"
  echo "  data dir : $DATA_DIR"
  echo "  log      : $LOG_FILE"
  echo "  branch   : $(git -C "$ROOT" rev-parse --abbrev-ref HEAD) @ $(git -C "$ROOT" rev-parse --short HEAD)"
}

stop() {
  [ -f "$PID_FILE" ] || { echo "not running"; return 0; }
  local pid; pid="$(cat "$PID_FILE")"
  if kill -0 "$pid" 2>/dev/null; then kill "$pid"; sleep 1; fi
  rm -f "$PID_FILE"
  echo "stopped (pid $pid)"
}

status() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "running: pid $(cat "$PID_FILE") on http://127.0.0.1:$PORT"
    curl -s -m 5 "http://127.0.0.1:$PORT/api/health" || echo "(health check failed)"
    echo
  else
    echo "not running"
  fi
}

case "${1:-status}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  *) die "usage: $0 {start|stop|restart|status}" ;;
esac
