#!/usr/bin/env python3
"""Bring the species classification artifacts up to date for a distribution build.

Species groups in the download view come from backend/data/taxonomy_classification.json,
which maps catalogue taxids to NCBI lineages. The catalogue is downloaded at run time and
Ensembl keeps adding to it, so a build-time artifact decays: uncovered species fall back
to a name heuristic that mis-groups most of them.

By default this only does work when it needs to. It downloads the live catalogue (small),
measures how much of it the current artifact covers, and regenerates only if coverage has
slipped past --max-uncovered-percent. Regeneration downloads the NCBI taxdump, which is
about 76 MB, so a build where nothing has drifted stays cheap.

  # what a build runs
  python backend/scripts/refresh_classification_artifacts.py

  # regenerate regardless of current coverage
  python backend/scripts/refresh_classification_artifacts.py --force
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import urllib.request
from pathlib import Path
from typing import Any, Dict, Optional, Set

SCRIPT_DIR = Path(__file__).resolve().parent
BACKEND_DIR = SCRIPT_DIR.parent
for _path in (str(BACKEND_DIR), str(SCRIPT_DIR)):
    if _path not in sys.path:
        sys.path.insert(0, _path)

from check_classification_coverage import _int_or_zero, _species_taxids  # noqa: E402
from generate_taxonomy_classification import _audit_catalog, _build_artifact  # noqa: E402

CATALOG_URL = "https://ftp.ebi.ac.uk/pub/ensemblorganisms/species.new_ftp_structure.json"
TAXDUMP_URL = "https://ftp.ncbi.nlm.nih.gov/pub/taxonomy/taxdump.tar.gz"
TAXDUMP_MD5_URL = TAXDUMP_URL + ".md5"
TAXONOMY_ARTIFACT = BACKEND_DIR / "data" / "taxonomy_classification.json"
DEFAULT_CACHE_DIR = BACKEND_DIR / "cache" / "build"


def log(message: str) -> None:
    print(f"[classification] {message}", flush=True)


def _download(url: str, target: Path, timeout: int = 300) -> Path:
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".part")
    with urllib.request.urlopen(url, timeout=timeout) as response, tmp.open("wb") as handle:
        shutil.copyfileobj(response, handle)
    tmp.replace(target)
    return target


def _md5(path: Path) -> str:
    digest = hashlib.md5()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _remote_taxdump_md5(timeout: int = 60) -> Optional[str]:
    try:
        with urllib.request.urlopen(TAXDUMP_MD5_URL, timeout=timeout) as response:
            return response.read().decode("utf-8", "replace").split()[0].strip()
    except Exception as exc:  # noqa: BLE001 - a missing checksum must not be fatal
        log(f"could not fetch the taxdump checksum ({exc}); cannot reuse a cached copy")
        return None


def _ensure_taxdump(cache_dir: Path) -> Path:
    """Download the taxdump, reusing a cached copy whose checksum still matches."""
    cached = cache_dir / "taxdump.tar.gz"
    expected = _remote_taxdump_md5()

    if cached.exists() and expected:
        if _md5(cached) == expected:
            log(f"reusing cached taxdump ({cached.stat().st_size // (1024 * 1024)} MB, checksum matches)")
            return cached
        log("cached taxdump is out of date; downloading the current one")

    log("downloading the NCBI taxdump (about 76 MB)")
    _download(TAXDUMP_URL, cached)
    if expected:
        actual = _md5(cached)
        if actual != expected:
            raise RuntimeError(
                f"taxdump checksum mismatch: expected {expected}, got {actual}. "
                "The download is corrupt; try again."
            )
        log("taxdump checksum verified")
    return cached


def _load_catalog(path: Path) -> Dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or not isinstance(payload.get("species"), dict):
        raise ValueError(f"{path} is not a valid Ensembl species catalogue")
    return payload


def _uncovered_percent(catalog: Dict[str, Any], artifact_path: Path) -> tuple[float, int, int]:
    species = catalog.get("species") or {}
    total = len(species)
    if not artifact_path.exists():
        return 100.0, total, total

    artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
    covered: Set[int] = {_int_or_zero(key) for key in (artifact.get("taxids") or {})}
    covered.discard(0)

    uncovered = 0
    for info in species.values():
        if not isinstance(info, dict):
            continue
        taxids = _species_taxids(info)
        if taxids and not (taxids & covered):
            uncovered += 1
    percent = (100.0 * uncovered / total) if total else 0.0
    return percent, uncovered, total


def _refresh_project_artifact() -> None:
    try:
        from project_classifier import build_project_artifact, save_project_artifact

        output = BACKEND_DIR / "data" / "project_classification.json"
        artifact = build_project_artifact()
        save_project_artifact(output, artifact)
        count = (artifact.get("metadata") or {}).get("unique_accession_count", 0)
        log(f"refreshed project_classification.json ({count} accessions)")
    except Exception as exc:  # noqa: BLE001
        # Project membership only adds badges; it must not block a build.
        log(f"WARNING: could not refresh project_classification.json ({exc}); keeping the existing one")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--catalog", type=Path, default=None, help="Use a local catalogue instead of downloading.")
    parser.add_argument("--catalog-url", default=CATALOG_URL)
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE_DIR)
    parser.add_argument("--artifact", type=Path, default=TAXONOMY_ARTIFACT)
    parser.add_argument(
        "--max-uncovered-percent",
        type=float,
        default=1.0,
        help="Regenerate when more than this percentage of catalogue species lack lineage coverage.",
    )
    parser.add_argument("--force", action="store_true", help="Regenerate even if coverage is still acceptable.")
    parser.add_argument("--skip-project", action="store_true", help="Do not refresh project_classification.json.")
    args = parser.parse_args()

    cache_dir = args.cache_dir
    cache_dir.mkdir(parents=True, exist_ok=True)

    if args.catalog:
        catalog_path = args.catalog
        log(f"using local catalogue {catalog_path}")
    else:
        catalog_path = cache_dir / "species.new_ftp_structure.json"
        log("downloading the current species catalogue")
        _download(args.catalog_url, catalog_path)

    catalog = _load_catalog(catalog_path)
    percent, uncovered, total = _uncovered_percent(catalog, args.artifact)
    log(f"catalogue has {total} species; current artifact leaves {uncovered} uncovered ({percent:.1f}%)")

    if not args.force and percent <= args.max_uncovered_percent:
        log(f"within the {args.max_uncovered_percent:.1f}% threshold; no regeneration needed")
        return 0

    if args.force:
        log("--force given; regenerating")
    else:
        log(f"above the {args.max_uncovered_percent:.1f}% threshold; regenerating")

    taxdump_path = _ensure_taxdump(cache_dir)
    log("building the taxonomy artifact (this takes around 15 seconds)")
    artifact = _build_artifact(catalog_path, taxdump_path)
    artifact["audit"] = _audit_catalog(catalog_path, artifact)

    args.artifact.parent.mkdir(parents=True, exist_ok=True)
    args.artifact.write_text(json.dumps(artifact, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    coverage = artifact.get("coverage") or {}
    audit = artifact.get("audit") or {}
    log(f"wrote {args.artifact}")
    log(
        f"  {coverage.get('lineage_record_count')} lineage records, "
        f"{coverage.get('missing_taxid_count')} taxids unresolved"
    )
    log(
        f"  species left in 'Other': {audit.get('new_other_count')} "
        f"(name heuristic alone would leave {audit.get('legacy_other_count')})"
    )

    new_percent, new_uncovered, _ = _uncovered_percent(catalog, args.artifact)
    log(f"  coverage now leaves {new_uncovered} species uncovered ({new_percent:.1f}%)")

    if not args.skip_project:
        _refresh_project_artifact()

    if new_percent > args.max_uncovered_percent:
        print(
            f"\nFAIL: coverage is still {new_percent:.1f}%, above the "
            f"{args.max_uncovered_percent:.1f}% threshold.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
