#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TARGET_DIR="${PROJECT_ROOT}/build/mafft_bin"

if [[ "${SKIP_MAFFT_BUNDLE:-0}" == "1" ]]; then
  echo "SKIP_MAFFT_BUNDLE=1 set; skipping MAFFT bundling"
  exit 0
fi

MAFFT_ROOT="${MAFFT_BUNDLE_ROOT:-}"
if [[ -n "${MAFFT_ROOT}" ]]; then
  MAFFT_ROOT="$(cd "${MAFFT_ROOT}" && pwd)"
fi

if [[ -z "${MAFFT_ROOT}" ]]; then
  if ! command -v mafft >/dev/null 2>&1; then
    echo "Error: mafft not found in PATH and MAFFT_BUNDLE_ROOT not set." >&2
    echo "Install MAFFT or set MAFFT_BUNDLE_ROOT to a MAFFT install root containing bin/mafft and libexec/mafft." >&2
    exit 1
  fi

  MAFFT_BIN="$(command -v mafft)"
  MAFFT_REAL="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "${MAFFT_BIN}")"
  MAFFT_ROOT_CANDIDATE="$(cd "$(dirname "${MAFFT_REAL}")/.." && pwd)"

  if [[ -d "${MAFFT_ROOT_CANDIDATE}/libexec/mafft" && -x "${MAFFT_ROOT_CANDIDATE}/bin/mafft" ]]; then
    MAFFT_ROOT="${MAFFT_ROOT_CANDIDATE}"
  else
    echo "Error: could not infer MAFFT root from ${MAFFT_REAL}" >&2
    echo "Set MAFFT_BUNDLE_ROOT to the MAFFT install root (expects bin/mafft and libexec/mafft)." >&2
    exit 1
  fi
fi

if [[ ! -x "${MAFFT_ROOT}/bin/mafft" ]]; then
  echo "Error: missing executable ${MAFFT_ROOT}/bin/mafft" >&2
  exit 1
fi
if [[ ! -d "${MAFFT_ROOT}/libexec/mafft" ]]; then
  echo "Error: missing directory ${MAFFT_ROOT}/libexec/mafft" >&2
  exit 1
fi

rm -rf "${TARGET_DIR}"
mkdir -p "${TARGET_DIR}/bin" "${TARGET_DIR}/libexec"
cp "${MAFFT_ROOT}/bin/mafft" "${TARGET_DIR}/bin/mafft"
chmod +x "${TARGET_DIR}/bin/mafft"
cp -R "${MAFFT_ROOT}/libexec/mafft" "${TARGET_DIR}/libexec/mafft"

if [[ -f "${MAFFT_ROOT}/LICENSE" ]]; then
  cp "${MAFFT_ROOT}/LICENSE" "${TARGET_DIR}/LICENSE"
elif [[ -f "${MAFFT_ROOT}/COPYING" ]]; then
  cp "${MAFFT_ROOT}/COPYING" "${TARGET_DIR}/LICENSE"
fi

echo "Bundled MAFFT from: ${MAFFT_ROOT}"
echo "Output: ${TARGET_DIR}"
