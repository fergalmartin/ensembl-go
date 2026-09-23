#!/bin/bash

set -u

# Make Homebrew commands visible on Apple Silicon while preserving the active
# virtual environment and the rest of the caller's PATH.
export PATH="$PATH:/opt/homebrew/bin"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_PORT=8000
FRONTEND_PORT=5173
BACKEND_PID=""
FRONTEND_PID=""
STARTED_SERVICE_PID=""

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: '$1' is required to run Ensembl Go in development." >&2
    exit 1
  fi
}

listeners_for_port() {
  lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | sort -u
}

wait_for_port_to_clear() {
  local port="$1"
  local attempt
  for ((attempt = 0; attempt < 20; attempt += 1)); do
    if [[ -z "$(listeners_for_port "$port")" ]]; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

resolve_port_conflict() {
  local port="$1"
  local service="$2"
  local pids
  local choice

  pids="$(listeners_for_port "$port")"
  if [[ -z "$pids" ]]; then
    return 0
  fi

  echo
  echo "Port $port, needed by the Ensembl Go $service, is already in use:"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN
  echo

  if [[ ! -t 0 ]]; then
    echo "Aborting because a port conflict requires an interactive choice." >&2
    return 1
  fi

  while true; do
    read -r -p "Kill the listed process(es) and continue, or abort? [k/a] " choice
    case "$choice" in
      k|K|kill|Kill|KILL)
        # Start with SIGTERM so applications have a chance to clean up.
        kill $pids 2>/dev/null || true
        if wait_for_port_to_clear "$port"; then
          echo "Port $port is now available."
          return 0
        fi

        echo "The process(es) did not stop after SIGTERM."
        read -r -p "Force kill them, or abort? [f/a] " choice
        case "$choice" in
          f|F|force|Force|FORCE)
            pids="$(listeners_for_port "$port")"
            [[ -z "$pids" ]] || kill -9 $pids 2>/dev/null || true
            if wait_for_port_to_clear "$port"; then
              echo "Port $port is now available."
              return 0
            fi
            echo "Could not free port $port. Aborting." >&2
            return 1
            ;;
          *)
            echo "Launch aborted; no force-kill signal was sent."
            return 1
            ;;
        esac
        ;;
      a|A|abort|Abort|ABORT|"")
        echo "Launch aborted. The listed process(es) were not changed."
        return 1
        ;;
      *)
        echo "Please enter 'k' to kill or 'a' to abort."
        ;;
    esac
  done
}

wait_for_service() {
  local port="$1"
  local pid="$2"
  local service="$3"
  local attempt

  for ((attempt = 0; attempt < 60; attempt += 1)); do
    if nc -z 127.0.0.1 "$port" >/dev/null 2>&1; then
      echo "$service is ready on port $port."
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "$service exited before opening port $port." >&2
      return 1
    fi
    sleep 0.5
  done

  echo "Timed out waiting for $service on port $port." >&2
  return 1
}

start_background_service() {
  local working_dir="$1"
  shift

  # Put each long-running service in its own session/process group. Terminal
  # Ctrl-C should reach this launcher and the foreground Electron process, not
  # Uvicorn's reload child or Vite directly. Cleanup can then stop the complete
  # service tree by signalling its process group.
  (
    cd "$working_dir" || exit 1
    exec python3 -c '
import os
import sys

os.setsid()
os.execvp(sys.argv[1], sys.argv[1:])
' "$@"
  ) &
  STARTED_SERVICE_PID=$!
}

service_group_is_running() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 -- "-$pid" 2>/dev/null
}

service_process_is_running() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

signal_background_service() {
  local signal_name="$1"
  local pid="$2"
  if service_group_is_running "$pid"; then
    kill "-$signal_name" -- "-$pid" 2>/dev/null || true
  elif service_process_is_running "$pid"; then
    # Covers the very short interval before the launcher calls setsid().
    kill "-$signal_name" "$pid" 2>/dev/null || true
  fi
}

service_has_exited() {
  local pid="$1"
  ! service_group_is_running "$pid" && ! service_process_is_running "$pid"
}

# Wait up to $2 tenths of a second for a signalled service to go away.
await_service_exit() {
  local pid="$1"
  local attempts="$2"
  local attempt
  for ((attempt = 0; attempt < attempts; attempt += 1)); do
    service_has_exited "$pid" && return 0
    sleep 0.1
  done
  service_has_exited "$pid"
}

stop_background_service() {
  local pid="$1"
  local service="$2"

  [[ -n "$pid" ]] || return 0
  if service_has_exited "$pid"; then
    wait "$pid" 2>/dev/null || true
    return 0
  fi

  # SIGINT is the signal Ctrl-C used to deliver to these services directly, back
  # when they shared the terminal's foreground process group; both Uvicorn and
  # Vite exit on it in well under a second. They now have their own sessions so
  # cleanup can reach the whole service tree, so cleanup sends that signal
  # itself. Escalation is for a service that is genuinely wedged, not the
  # normal path — a healthy shutdown never reaches SIGTERM.
  signal_background_service INT "$pid"
  if ! await_service_exit "$pid" 20; then
    signal_background_service TERM "$pid"
    if ! await_service_exit "$pid" 20; then
      echo "$service ignored SIGINT and SIGTERM; forcing it to exit." >&2
      signal_background_service KILL "$pid"
      await_service_exit "$pid" 20
    fi
  fi
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  local status=$?
  trap - EXIT
  # A repeated Ctrl-C must not interrupt cleanup halfway through and orphan a
  # reload worker. Cleanup is bounded, so ignoring it here cannot hang forever.
  trap '' INT TERM
  echo
  echo "Stopping Ensembl Go development services..."
  stop_background_service "$FRONTEND_PID" "Frontend"
  stop_background_service "$BACKEND_PID" "Backend"
  exit "$status"
}

bootstrap_hint() {
  echo "Run ./scripts/bootstrap_dev.sh from the repository root to install everything," >&2
  echo "then activate the environment with 'source .venv/bin/activate'." >&2
}

require_node_dependencies() {
  local missing=0
  if [[ ! -e "$SCRIPT_DIR/frontend/node_modules/vite" ]]; then
    echo "Error: frontend dependencies are not installed." >&2
    missing=1
  fi
  if [[ ! -e "$SCRIPT_DIR/electron/node_modules/electron" ]]; then
    echo "Error: Electron dependencies are not installed." >&2
    missing=1
  fi
  if ((missing)); then
    bootstrap_hint
    exit 1
  fi
}

require_backend_dependencies() {
  if ! python3 -c "import fastapi, uvicorn" >/dev/null 2>&1; then
    echo "Error: the backend Python dependencies are not available to python3." >&2
    bootstrap_hint
    exit 1
  fi
}

require_command lsof
require_command nc
require_command python3
require_command npm

# Check these before starting anything, so a fresh checkout fails immediately with a
# clear message instead of a module-not-found trace after the backend is already up.
require_node_dependencies
require_backend_dependencies

resolve_port_conflict "$BACKEND_PORT" "backend" || exit 1
resolve_port_conflict "$FRONTEND_PORT" "frontend" || exit 1

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "Starting Ensembl Go backend with auto-reload..."
start_background_service \
  "$SCRIPT_DIR/backend" \
  python3 -m uvicorn main:app --reload --host 127.0.0.1 --port "$BACKEND_PORT"
BACKEND_PID="$STARTED_SERVICE_PID"

wait_for_service "$BACKEND_PORT" "$BACKEND_PID" "Backend" || exit 1

echo "Starting Ensembl Go frontend with hot reload..."
start_background_service \
  "$SCRIPT_DIR/frontend" \
  npm run dev -- --host 127.0.0.1 --port "$FRONTEND_PORT" --strictPort
FRONTEND_PID="$STARTED_SERVICE_PID"

wait_for_service "$FRONTEND_PORT" "$FRONTEND_PID" "Frontend" || exit 1

echo "Starting Ensembl Go desktop window..."
cd "$SCRIPT_DIR/electron" || exit 1
ELECTRON_START_URL="http://127.0.0.1:$FRONTEND_PORT" SKIP_BACKEND=true npm start
