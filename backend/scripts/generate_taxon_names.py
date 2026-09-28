#!/usr/bin/env python3
"""Write ``data/taxon_names.json``: a name for every taxon in the shipped lineages.

``data/taxonomy_classification.json`` holds each catalogue species' NCBI lineage as
taxids, but names only the species themselves. Gene trees label their internal
nodes by taxid (Ensembl's EMF dumps carry ``T=`` and nothing else), so without
names for the clades in between every folded clade would be anonymous. This keeps
exactly the taxids those lineages mention — about ten thousand — with the NCBI
scientific name and, where NCBI has one, a GenBank common name.

    python3 backend/scripts/generate_taxon_names.py \
        --taxdump backend/cache/build/taxdump.tar.gz
"""
from __future__ import annotations

import argparse
import json
import tarfile
from datetime import datetime, timezone
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
DEFAULT_LINEAGES = BACKEND_DIR / 'data' / 'taxonomy_classification.json'
DEFAULT_OUTPUT = BACKEND_DIR / 'data' / 'taxon_names.json'
DEFAULT_TAXDUMP = BACKEND_DIR / 'cache' / 'build' / 'taxdump.tar.gz'


def wanted_taxids(lineages_path: Path) -> set:
    data = json.loads(lineages_path.read_text())
    wanted = set()
    for entry in (data.get('taxids') or {}).values():
        wanted.update(int(t) for t in entry.get('lineage') or [])
    return wanted


def read_names(taxdump: Path, wanted: set) -> dict:
    scientific, common = {}, {}
    with tarfile.open(taxdump, 'r:*') as archive:
        handle = archive.extractfile('names.dmp')
        if handle is None:
            raise SystemExit(f'names.dmp is missing from {taxdump}')
        for raw in handle:
            parts = [p.strip() for p in raw.decode('utf-8', 'replace').split('|')]
            if len(parts) < 4:
                continue
            taxid = int(parts[0])
            if taxid not in wanted:
                continue
            kind = parts[3]
            if kind == 'scientific name':
                scientific[taxid] = parts[1]
            elif kind == 'genbank common name':
                common[taxid] = parts[1]
    out = {}
    for taxid in sorted(scientific):
        entry = [scientific[taxid]]
        if taxid in common:
            entry.append(common[taxid])
        out[str(taxid)] = entry
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--taxdump', type=Path, default=DEFAULT_TAXDUMP)
    parser.add_argument('--lineages', type=Path, default=DEFAULT_LINEAGES)
    parser.add_argument('--output', type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    wanted = wanted_taxids(args.lineages)
    names = read_names(args.taxdump, wanted)
    payload = {
        'schema_version': 1,
        'generated_at': datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z'),
        'generator': 'backend/scripts/generate_taxon_names.py',
        'source_lineages': args.lineages.name,
        'note': 'taxid -> [scientific name, GenBank common name?] for every taxid in the shipped lineages',
        'names': names,
    }
    args.output.write_text(json.dumps(payload, separators=(',', ':'), ensure_ascii=False) + '\n')
    print(f'{len(names)} of {len(wanted)} taxa named -> {args.output}')


if __name__ == '__main__':
    main()
