#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="$(cd "$ELECTRON_DIR/.." && pwd)"

if [[ -n "${ENSEMBL_LOCAL_SPECIES_JSON:-}" && -f "$ENSEMBL_LOCAL_SPECIES_JSON" ]]; then
  SPECIES_JSON_PATH="$ENSEMBL_LOCAL_SPECIES_JSON"
else
  CANDIDATES=(
    "$PROJECT_DIR/cluster_test_data/species.new_ftp_structure.json"
    "$PROJECT_DIR/cluster_test_data/species.json"
    "$PROJECT_DIR/../cluster_test_data/species.new_ftp_structure.json"
    "$PROJECT_DIR/../cluster_test_data/species.json"
    "$PROJECT_DIR/../antigravity_pangenome_mapping/cluster_test_data/species.new_ftp_structure.json"
    "$PROJECT_DIR/../antigravity_pangenome_mapping/cluster_test_data/species.json"
  )

  SPECIES_JSON_PATH=""
  for candidate in "${CANDIDATES[@]}"; do
    if [[ -f "$candidate" ]]; then
      SPECIES_JSON_PATH="$candidate"
      break
    fi
  done

  if [[ -z "$SPECIES_JSON_PATH" ]]; then
    GENERATED_DIR="$ELECTRON_DIR/build_backend/generated"
    SPECIES_JSON_PATH="$GENERATED_DIR/species.new_ftp_structure.json"
    mkdir -p "$GENERATED_DIR"
    cat >"$SPECIES_JSON_PATH" <<'JSON'
{
  "last_updated": "",
  "species": {}
}
JSON
    echo "[build] No species catalogue found; using generated empty catalogue: $SPECIES_JSON_PATH"
  fi
fi

rm -rf \
  "$ELECTRON_DIR/dist_backend/alignment_server" \
  "$ELECTRON_DIR/dist_backend/alignment_server.exe" \
  "$ELECTRON_DIR/build_backend/alignment_server" \
  "$ELECTRON_DIR/alignment_server.spec"

PYINSTALLER_ARGS=(
  -m PyInstaller
  --onefile
  --name ensembl_go_backend
  --distpath dist_backend
  --workpath build_backend
  --specpath .
  --hidden-import pyBigWig
)

if [[ -d "$PROJECT_DIR/backend/data" ]]; then
  PYINSTALLER_ARGS+=(--add-data "../backend/data:data")
else
  echo "[build] No backend/data directory found; building without bundled sample genomes."
fi

PYINSTALLER_ARGS+=(
  --add-data "$SPECIES_JSON_PATH:cluster_test_data"
  ../backend/main.py
)

python3 "${PYINSTALLER_ARGS[@]}"
