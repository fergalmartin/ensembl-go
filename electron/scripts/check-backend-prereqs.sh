#!/usr/bin/env bash
set -euo pipefail

if ! command -v python3 >/dev/null 2>&1; then
  echo "[build] python3 is required to build the backend." >&2
  exit 1
fi

if ! python3 - <<'PY'
import importlib.util
import sys
missing = []
for module in ("pyBigWig",):
    if importlib.util.find_spec(module) is None:
        missing.append(module)
if missing:
    print(",".join(missing))
    sys.exit(1)
PY
then
  echo "[build] Missing required Python module(s) for packaged backend: pyBigWig" >&2
  echo "[build] Install on the build machine with: python3 -m pip install pyBigWig" >&2
  exit 1
fi

echo "[build] Backend Python prerequisites detected."
