#!/usr/bin/env python3
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from download_manager import DownloadManager  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate the Ensembl Local species display-name policy.")
    parser.add_argument(
        "--catalog",
        default=str(ROOT / "cache" / "remote_species_catalog.json"),
        help="Path to remote_species_catalog.json or another species catalogue.",
    )
    parser.add_argument(
        "--cache-dir",
        default=str(ROOT / "cache"),
        help="Directory for policy output and catalogue state.",
    )
    parser.add_argument(
        "--output",
        default="",
        help="Optional explicit output path. Defaults to <cache-dir>/species_name_policy.json.",
    )
    parser.add_argument(
        "--skip-ncbi",
        action="store_true",
        help="Generate from the app catalogue only.",
    )
    args = parser.parse_args()

    catalog_path = Path(args.catalog)
    cache_dir = Path(args.cache_dir)
    manager = DownloadManager(catalog_path, cache_dir=cache_dir)
    if args.output:
        manager.species_name_policy_path = Path(args.output)

    policy = manager.refresh_species_name_policy(include_ncbi=not args.skip_ncbi, force=True)
    print(json.dumps(policy.get("metadata") or {}, indent=2, sort_keys=True))
    print(f"Wrote {manager.species_name_policy_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
