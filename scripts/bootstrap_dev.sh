#!/usr/bin/env bash
#
# Install everything needed to run Ensembl Go from a source checkout.
#
#   ./scripts/bootstrap_dev.sh                  # runtime dependencies
#   ./scripts/bootstrap_dev.sh --with-packaging # also PyInstaller, for building packages
#
# Safe to re-run: an existing virtual environment is reused rather than recreated.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="$ROOT_DIR/.venv"
WITH_PACKAGING=0

for arg in "$@"; do
  case "$arg" in
    --with-packaging) WITH_PACKAGING=1 ;;
    -h|--help)
      sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      echo "Usage: $0 [--with-packaging]" >&2
      exit 1
      ;;
  esac
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
note() { printf '    %s\n' "$1"; }
fail() { printf '\n\033[31mError: %s\033[0m\n' "$1" >&2; exit 1; }

# --- Prerequisites -----------------------------------------------------------

step "Checking prerequisites"

command -v python3 >/dev/null 2>&1 || fail "python3 is required. Install Python 3.9 or newer."
command -v npm >/dev/null 2>&1 || fail "npm is required. Install Node.js 20.19 or newer (22 LTS recommended)."
command -v node >/dev/null 2>&1 || fail "node is required. Install Node.js 20.19 or newer (22 LTS recommended)."

python3 - <<'PY' || fail "Python 3.9 or newer is required."
import sys
sys.exit(0 if sys.version_info >= (3, 9) else 1)
PY
note "python3 $(python3 -c 'import platform; print(platform.python_version())')"

node_version="$(node --version | sed 's/^v//')"
node_major="${node_version%%.*}"
node_rest="${node_version#*.}"
node_minor="${node_rest%%.*}"
if [[ "$node_major" -lt 20 ]] || { [[ "$node_major" -eq 20 ]] && [[ "$node_minor" -lt 19 ]]; }; then
  fail "Node.js 20.19 or newer is required (found $node_version). Node 22 LTS is recommended."
fi
note "node v$node_version, npm $(npm --version)"

if ! python3 -c "import venv" >/dev/null 2>&1; then
  fail "The Python venv module is missing. On Debian/Ubuntu install it with: sudo apt install python3-venv"
fi

# --- Python environment ------------------------------------------------------

if [[ -d "$VENV_DIR" ]]; then
  step "Reusing existing virtual environment at .venv"
else
  step "Creating virtual environment at .venv"
  python3 -m venv "$VENV_DIR"
fi

VENV_PYTHON="$VENV_DIR/bin/python"
[[ -x "$VENV_PYTHON" ]] || fail "Virtual environment looks broken: $VENV_PYTHON is missing. Remove .venv and re-run."

step "Installing backend Python dependencies"
"$VENV_PYTHON" -m pip install --upgrade pip
"$VENV_PYTHON" -m pip install -r "$ROOT_DIR/backend/requirements.txt"

if [[ "$WITH_PACKAGING" -eq 1 ]]; then
  step "Installing packaging dependencies (PyInstaller)"
  "$VENV_PYTHON" -m pip install -r "$ROOT_DIR/backend/requirements-build.txt"
fi

# --- Node dependencies -------------------------------------------------------

step "Installing frontend dependencies"
npm --prefix "$ROOT_DIR/frontend" ci

step "Installing Electron dependencies"
npm --prefix "$ROOT_DIR/electron" ci

# Electron 42 and newer no longer ship a postinstall hook, so `npm ci` does not fetch
# the ~100 MB runtime binary; it is otherwise downloaded lazily on the first launch.
# Do it here so this script really does leave a ready-to-run checkout.
ELECTRON_INSTALL_JS="$ROOT_DIR/electron/node_modules/electron/install.js"
if [[ -f "$ELECTRON_INSTALL_JS" ]]; then
  step "Fetching the Electron runtime binary"
  if (cd "$ROOT_DIR/electron" && node "$ELECTRON_INSTALL_JS"); then
    note "Electron runtime ready."
  else
    note "Could not fetch the Electron runtime now; it will download on first launch."
  fi
fi

# --- Optional tools ----------------------------------------------------------

step "Checking optional dependencies"
if command -v mafft >/dev/null 2>&1; then
  note "mafft found at $(command -v mafft); multiple genic-region alignments are available."
else
  note "mafft not found. It is optional and only needed for multiple genic-region"
  note "alignments. Install with 'brew install mafft' (macOS) or"
  note "'sudo apt install mafft' (Debian/Ubuntu)."
fi

# --- Done --------------------------------------------------------------------

step "Done"
cat <<EOF

Start the application in development mode with:

    source .venv/bin/activate
    ./run_ensembl_go.sh

The species catalogue is downloaded from Ensembl the first time the backend
starts, so the download view may briefly show "Fetching species catalogue".

To verify the installation:

    source .venv/bin/activate
    python -m pytest backend/tests -q
    npm --prefix frontend test
    npm --prefix frontend run build
EOF

if [[ "$WITH_PACKAGING" -eq 0 ]]; then
  cat <<EOF

To build a distributable package, re-run this script with --with-packaging,
then see electron/RELEASE.md.
EOF
fi
