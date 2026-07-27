#!/usr/bin/env python3
"""Generate cached stats for a single genome descriptor.

Example:
  python backend/scripts/generate_stats.py \
    --genome-json '{"species_key":"homo_sapiens","assembly":"GCA_000001405.29","files":{"index":"/path/a.db","gff3":"/path/a.gff3.gz","fasta":"/path/a.fa","homology":"/path/h.tsv.gz"}}' \
    --output-dir /path/output \
    --cache-root /path/backend/cache \
    --sections annotation,structural,homology,assembly
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from stats_utils import (  # noqa: E402
    STRUCTURAL_PROFILE,
    choose_stats_cache_path,
    clean_species_record,
    compute_annotation_stats,
    compute_fasta_assembly_stats,
    compute_homology_stats,
    compute_source_fingerprints,
    compute_structural_stats,
    ensure_stats_cache_base,
    fetch_ena_metadata,
    load_stats_cache,
    now_iso,
    save_stats_cache,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate per-genome stats cache.")
    parser.add_argument("--genome-json", required=True, help="Genome descriptor JSON.")
    parser.add_argument("--output-dir", default="", help="Configured output directory.")
    parser.add_argument("--cache-root", required=True, help="Backend cache root path.")
    parser.add_argument(
        "--sections",
        default="annotation,structural,homology,assembly",
        help="Comma-separated sections to compute.",
    )
    parser.add_argument(
        "--structural-profile",
        default=STRUCTURAL_PROFILE,
        help="Structural profile name.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    raw = json.loads(args.genome_json)
    species = clean_species_record(raw)
    files = species.get("files") or {}
    cache_root = Path(args.cache_root).expanduser().resolve()
    ena_cache_path = cache_root / "ena_metadata_cache.json"
    fingerprints = compute_source_fingerprints(files)
    cache_path = choose_stats_cache_path(species, args.output_dir, cache_root)
    cache = ensure_stats_cache_base(load_stats_cache(cache_path), species, fingerprints)
    sections = {s.strip().lower() for s in (args.sections or "").split(",") if s.strip()}

    if "annotation" in sections:
        if files.get("index") and os.path.exists(files["index"]):
            cache.setdefault("sections", {})["annotation"] = compute_annotation_stats(files["index"])
            cache.setdefault("computed_at", {})["annotation"] = now_iso()

    if "structural" in sections:
        if files.get("index") and files.get("fasta") and os.path.exists(files["index"]) and os.path.exists(files["fasta"]):
            cache.setdefault("sections", {})["structural"] = compute_structural_stats(
                files["index"],
                files["fasta"],
                structural_profile=args.structural_profile,
            )
            cache.setdefault("computed_at", {})["structural"] = now_iso()

    if "homology" in sections:
        if files.get("homology") and os.path.exists(files["homology"]):
            cache.setdefault("sections", {})["homology"] = compute_homology_stats(files["homology"])
            cache.setdefault("computed_at", {})["homology"] = now_iso()

    if "assembly" in sections:
        section = {}
        if files.get("fasta") and os.path.exists(files["fasta"]):
            section["fasta"] = compute_fasta_assembly_stats(files["fasta"])
        section["ena"] = fetch_ena_metadata(species.get("gca"), ena_cache_path)
        cache.setdefault("sections", {})["assembly"] = section
        cache.setdefault("computed_at", {})["assembly"] = now_iso()

    save_stats_cache(cache_path, cache)
    print(json.dumps({"status": "ok", "cache_path": str(cache_path)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

