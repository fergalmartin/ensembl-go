#!/usr/bin/env bash

# This script needs real bash: it uses arrays to build the rsync exclusion lists, and a
# process substitution in the completeness check. Running it as `sh archive_github_snapshot.sh`
# bypasses the shebang, and on macOS `sh` is bash in POSIX mode, which parses the arrays
# but rejects the process substitution — a syntax error two thirds of the way in, after
# the staging has already started. Re-exec rather than fail, so any of `./script`,
# `bash script` and `sh script` behave the same.
if [ -z "${BASH_VERSION:-}" ] || shopt -qo posix 2>/dev/null; then
  exec bash "$0" "$@"
fi

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

# What this snapshot is for
# -------------------------
# It is a recovery archive: unpack it on a clean machine and you can get back to
# development without the git repository. That means it must contain every tracked
# file, plus the few working documents that are deliberately untracked, and may only
# omit things a documented command regenerates. The completeness check below enforces
# the first half of that; RECOVERY.md, written into the archive, covers the second.
echo "Preparing source snapshot staging area..."

for rel_path in \
  .gitignore \
  DEVELOPMENT.md \
  INSTALLATION.md \
  NOTICE \
  PROGRESS.md \
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

# outputs/ is scratch and stays gitignored, but this one table is not scratch: it was
# tracked until it moved out of the index, nothing in the codebase reads or writes it,
# and no documented command regenerates it. It exists on disk and in git history and
# nowhere else, so the archive carries it by name. Naming the file rather than syncing
# outputs/ keeps the rest of that directory out, which is the point of ignoring it.
copy_if_exists "outputs/alignment-explorer-genome-links/44_mammals_epo_release115_genome_links.tsv"

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
  "/data/*.bgz" \
  "/data/*.gzi" \
  "/static/structure/vendor/" \
  "test_data/" \
  "output_dir/" \
  "local_data/" \
  "debug_backend.txt" \
  "main.py_bak"

# The experimental Rust/WASM structural-variation renderer used to be excluded whole,
# on the grounds that no shipped code path reaches it. That was right for a snapshot
# aimed at GitHub and wrong for a recovery archive: its source is tracked, it exists
# nowhere else, and 790 MB of that directory is the Cargo target/ directory alone. Only
# the build output goes. When this repository is made public, reinstating the old
# source exclusions is a deliberate decision to make there, not a default to inherit.
sync_subtree "frontend" \
  "node_modules/" \
  "dist/" \
  "coverage/" \
  "test_data/" \
  "output_dir/" \
  "local_data/" \
  "/rust/*/target/"

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

# Shared tooling under .claude/ is tracked (the tutorial-building skill and anything
# added beside it); personal settings next to it are not. Only the tracked half is
# copied, or the completeness check below fails on files .gitignore deliberately keeps
# out of the repository.
sync_subtree ".claude/skills"

# --- Completeness check ------------------------------------------------------
# A recovery archive is only as good as its worst omission, and every omission this
# script has ever had was silent: an exclusion written for one purpose quietly swallowed
# a tracked file added later. `fixtures/` was meant for large genome fixtures and took
# backend/tests/fixtures/annotation with it; the hardcoded root list never grew NOTICE
# or PROGRESS.md. Comparing the staged tree against the index turns that whole class of
# mistake into a failure at archive time rather than a discovery at recovery time.
if command -v git >/dev/null 2>&1 && git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  tracked_count=0
  missing=""
  while IFS= read -r rel; do
    tracked_count=$((tracked_count + 1))
    if [[ ! -e "$EXPORT_ROOT/$rel" ]]; then
      missing+="  $rel"$'\n'
    fi
  done < <(git -C "$ROOT_DIR" ls-files)

  if [[ -n "$missing" ]]; then
    echo "Error: these tracked files are not in the snapshot:" >&2
    printf '%s' "$missing" >&2
    echo >&2
    echo "An exclusion above is too broad, or the root file list needs the name added." >&2
    echo "(A file deleted from the working tree but still in the index also lands here;" >&2
    echo "in that case commit the deletion first.)" >&2
    exit 1
  fi

  echo "Completeness check: all $tracked_count tracked files staged."
else
  echo "Warning: git unavailable, skipping the completeness check." >&2
fi

# --- Recovery instructions ---------------------------------------------------
# Written into the archive rather than kept in the repository, because its whole
# audience is someone holding the archive and nothing else.
cat > "$EXPORT_ROOT/RECOVERY.md" <<'RECOVERY_EOF'
# Recovering from this snapshot

A working-tree snapshot of Ensembl Go, taken by `scripts/archive_github_snapshot.sh`.
It contains every file tracked in git at the time it was made, plus the untracked
working documents under `docs/`. It does **not** contain git history: it is a copy of
the files as they stood, not of the repository.

## Getting back to development

```sh
tar xzf <this archive>.tar.gz && cd <this archive>
git init && git add -A && git commit -m "Recovered from snapshot"   # do this first
npm --prefix frontend ci
npm --prefix electron ci
python3 -m venv .venv && . .venv/bin/activate
pip install -r backend/requirements.txt
```

Then `./start.sh`, or see `DEVELOPMENT.md`.

Verify the recovery before trusting it:

```sh
( cd backend && python -m pytest -q )
npm --prefix frontend test
npm --prefix frontend run lint
npm --prefix frontend run build
```

## What was left out, and how it comes back

Everything omitted is regenerable. Nothing here needs to be recovered by hand.

| Left out | Comes back with |
| --- | --- |
| `frontend/node_modules/`, `electron/node_modules/` | `npm ci` (lockfiles are included) |
| Python virtualenv | `pip install -r backend/requirements.txt` |
| `backend/static/structure/vendor/` | `npm --prefix frontend run prepare:structure-viewer` — also runs automatically before `dev` and `build` |
| `electron/build/mafft_bin/` | `npm --prefix electron run prepare:mafft` |
| `frontend/rust/*/target/` | `cargo build`, and only if you are working on the experimental renderer. Its source is included |
| `frontend/dist/`, `electron/dist*/`, `backend/cache/`, `backend/output_dir/` | rebuilt or recreated at run time |
| Sample genomes in `backend/data/` | downloaded through the application. The two small tutorial genomes, `demo_genome/` and `grch38_reg4/`, **are** included — the tutorials need them |

## What is deliberately included that git does not track

`docs/browsing-controls-handoff.md` and `docs/tutorial-builder-genome-playlists-handoff.md`
are gitignored working documents. They exist in no other copy, so the archive carries
them.

`outputs/alignment-explorer-genome-links/44_mammals_epo_release115_genome_links.tsv`
is carried for the same reason. The rest of `outputs/` is scratch and is not included.
RECOVERY_EOF

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
