#!/usr/bin/env python3
"""Report how much of the species catalogue the taxonomy artifact can classify.

Species groups in the download view come from backend/data/taxonomy_classification.json,
which is generated at build time against a snapshot of the Ensembl species catalogue.
The catalogue itself is downloaded at run time and Ensembl keeps adding to it, so the
artifact drifts: species whose taxids it does not cover fall back to a name heuristic,
which historically left about a third of the catalogue in "Other".

Run this before packaging to see whether the artifact still covers the catalogue users
will actually receive.

  # against the live Ensembl catalogue
  python backend/scripts/check_classification_coverage.py

  # against a local catalogue, failing if coverage has slipped
  python backend/scripts/check_classification_coverage.py \
      --catalog backend/cache/remote_species_catalog.json --max-uncovered-percent 2
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path
from typing import Any, Dict, Set

BACKEND_DIR = Path(__file__).resolve().parent.parent
DEFAULT_ARTIFACT = BACKEND_DIR / "data" / "taxonomy_classification.json"
LIVE_CATALOG_URL = "https://ftp.ebi.ac.uk/pub/ensemblorganisms/species.new_ftp_structure.json"


def _int_or_zero(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _species_taxids(info: Dict[str, Any]) -> Set[int]:
    out: Set[int] = set()
    for field in ("species_taxonomy_id", "taxid"):
        taxid = _int_or_zero(info.get(field))
        if taxid:
            out.add(taxid)
    return out


def _load_catalog(path: Path | None, url: str) -> Dict[str, Any]:
    if path:
        payload = json.loads(path.read_text(encoding="utf-8"))
        origin = str(path)
    else:
        with urllib.request.urlopen(url, timeout=60) as response:
            payload = json.loads(response.read())
        origin = url
    if not isinstance(payload, dict) or not isinstance(payload.get("species"), dict):
        raise ValueError(f"{origin} is not a valid Ensembl species catalogue")
    payload["_origin"] = origin
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--artifact", type=Path, default=DEFAULT_ARTIFACT)
    parser.add_argument(
        "--catalog",
        type=Path,
        default=None,
        help="Catalogue to check against. Defaults to downloading the live Ensembl catalogue.",
    )
    parser.add_argument("--catalog-url", default=LIVE_CATALOG_URL)
    parser.add_argument(
        "--max-uncovered-percent",
        type=float,
        default=None,
        help="Exit non-zero when more than this percentage of species lack lineage coverage.",
    )
    args = parser.parse_args()

    if not args.artifact.exists():
        print(f"Taxonomy artifact not found: {args.artifact}", file=sys.stderr)
        return 1

    artifact = json.loads(args.artifact.read_text(encoding="utf-8"))
    covered = {_int_or_zero(key) for key in (artifact.get("taxids") or {})}
    covered.discard(0)

    catalog = _load_catalog(args.catalog, args.catalog_url)
    species = catalog.get("species") or {}

    uncovered = []
    for key, info in species.items():
        if not isinstance(info, dict):
            continue
        taxids = _species_taxids(info)
        if taxids and not (taxids & covered):
            uncovered.append(str((info.get("scientific_name") or key)))

    total = len(species)
    percent = (100.0 * len(uncovered) / total) if total else 0.0
    generated_at = (artifact.get("metadata") or {}).get("generated_at", "unknown")
    built_against = (artifact.get("coverage") or {}).get("catalog_species_count", "unknown")

    print(f"artifact                {args.artifact}")
    print(f"  generated at          {generated_at}")
    print(f"  built against         {built_against} species")
    print(f"catalogue               {catalog['_origin']}")
    print(f"  species              {total}")
    print(f"uncovered species       {len(uncovered)} ({percent:.1f}%)")
    if uncovered:
        preview = ", ".join(sorted(uncovered)[:8])
        print(f"  examples              {preview}")
        print()
        print("Uncovered species are grouped by a name heuristic instead of NCBI lineage,")
        print("so they are likely to land in the wrong group or in 'Other'. Regenerate the")
        print("artifact with backend/scripts/generate_taxonomy_classification.py.")

    if args.max_uncovered_percent is not None and percent > args.max_uncovered_percent:
        print(
            f"\nFAIL: {percent:.1f}% uncovered exceeds the "
            f"{args.max_uncovered_percent:.1f}% threshold.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
