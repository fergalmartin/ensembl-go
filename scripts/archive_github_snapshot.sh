#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-$ROOT_DIR/exports}"
ARCHIVE_BASENAME="${2:-ensembl_local_github_$(date +%Y%m%d-%H%M%S)}"

if ! command -v rsync >/dev/null 2>&1; then
  echo "Error: rsync is required but not installed." >&2
  exit 1
fi

if ! command -v zip >/dev/null 2>&1; then
  echo "Error: zip is required but not installed." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ensembl_local_export.XXXXXX")"
EXPORT_ROOT="$STAGE_DIR/$ARCHIVE_BASENAME"

cleanup() {
  rm -rf "$STAGE_DIR"
}
trap cleanup EXIT

mkdir -p "$EXPORT_ROOT"

copy_if_exists() {
  local rel_path="$1"
  if [[ -e "$ROOT_DIR/$rel_path" ]]; then
    mkdir -p "$(dirname "$EXPORT_ROOT/$rel_path")"
    cp -pR "$ROOT_DIR/$rel_path" "$EXPORT_ROOT/$rel_path"
  fi
}

sync_subtree() {
  local rel_path="$1"
  shift

  if [[ ! -d "$ROOT_DIR/$rel_path" ]]; then
    return
  fi

  local -a rsync_args=(
    -a
    "$ROOT_DIR/$rel_path/"
    "$EXPORT_ROOT/$rel_path/"
    --exclude ".DS_Store"
    --exclude "__pycache__/"
    --exclude ".pytest_cache/"
    --exclude ".mypy_cache/"
    --exclude ".ruff_cache/"
    --exclude ".hypothesis/"
    --exclude ".tox/"
    --exclude ".venv/"
    --exclude "venv/"
    --exclude "env/"
    --exclude ".cache/"
    --exclude ".vite/"
    --exclude ".vite-temp/"
    --exclude "coverage/"
    --exclude "*.pyc"
    --exclude "*.pyo"
    --exclude "*.log"
    --exclude "*~"
    --exclude "*.bak"
  )

  while (($#)); do
    rsync_args+=(--exclude "$1")
    shift
  done

  mkdir -p "$EXPORT_ROOT/$rel_path"
  rsync "${rsync_args[@]}"
}

echo "Preparing GitHub-friendly source snapshot staging area..."

for rel_path in \
  DEVELOPMENT.md \
  INSTALLATION.md \
  run_ensembl_go.sh \
  start.sh \
  README.md \
  README \
  LICENSE \
  LICENSE.md \
  LICENSE.txt \
  SECURITY.md
do
  copy_if_exists "$rel_path"
done

# backend/data holds two different kinds of thing. The FASTA/GFF3 sample genomes are
# hundreds of megabytes and are excluded, but project_classification.json and
# taxonomy_classification.json in the same directory are shipped fallback artifacts the
# backend reads at runtime (see backend/project_classifier.py and
# backend/taxonomy_classifier.py), so they must stay. Excluding the whole directory,
# as this did previously, silently dropped them from every snapshot.
sync_subtree "backend" \
  "cache/" \
  "/data/*.fa" \
  "/data/*.fai" \
  "/data/*.gff3" \
  "/data/*.gz" \
  "test_data/" \
  "fixtures/" \
  "output_dir/" \
  "local_data/" \
  "debug_backend.txt" \
  "main.py_bak"

sync_subtree "frontend" \
  "node_modules/" \
  "dist/" \
  "coverage/" \
  "test_data/" \
  "fixtures/" \
  "output_dir/" \
  "local_data/" \
  "test_crash.cjs" \
  "test_frontend.py" \
  "/rust/" \
  "/scripts/test-sv-rust.js" \
  "/src/components/sv-rust/" \
  "/src/utils/svRustRendererProtocol.js" \
  "/src/utils/svRustSceneStrategy.js" \
  "/src/workers/svRustRenderer.worker.js" \
  "/tests/svRust*.test.js"

# The experimental Rust/WASM structural-variation renderer is excluded above. Its Cargo
# target directory alone is hundreds of megabytes, and no shipped code path reaches it:
# nothing imports RustStructuralVariationView. Its tests go too, because their fixtures
# live under the already-excluded tests/fixtures and the suite would otherwise fail.
#
# If the renderer is ever wired into the application, these exclusions must be removed
# or the snapshot would not build. Fail loudly rather than ship one that cannot.
# eslint.config.js is skipped: it only lists the renderer in ignore globs, which are
# harmless when the paths are absent.
staged_rust_refs="$(
  grep -rlE "rust/sv_renderer|sv-rust|svRust|sv-renderer" "$EXPORT_ROOT/frontend" 2>/dev/null \
    | grep -v '/eslint\.config\.js$' \
    || true
)"
if [[ -n "$staged_rust_refs" ]]; then
  echo "Error: the staged snapshot still references the excluded experimental Rust renderer:" >&2
  echo "$staged_rust_refs" >&2
  echo >&2
  echo "Either the renderer is now in use, in which case remove the corresponding" >&2
  echo "exclusions above, or a stray reference remains and should be deleted." >&2
  exit 1
fi

sync_subtree "electron" \
  "node_modules/" \
  "dist/" \
  "dist_backend/" \
  "build_backend/" \
  "build/mafft_bin/" \
  "build_log*.txt" \
  "alignment_server.spec"

sync_subtree "docs"

sync_subtree "scripts"

TAR_PATH="$OUT_DIR/$ARCHIVE_BASENAME.tar.gz"
ZIP_PATH="$OUT_DIR/$ARCHIVE_BASENAME.zip"

echo "Creating tar.gz archive..."
tar -czf "$TAR_PATH" -C "$STAGE_DIR" "$ARCHIVE_BASENAME"

echo "Creating zip archive..."
(
  cd "$STAGE_DIR"
  zip -q -r "$ZIP_PATH" "$ARCHIVE_BASENAME"
)

echo "Done."
echo "  tar.gz: $TAR_PATH"
echo "  zip:    $ZIP_PATH"
