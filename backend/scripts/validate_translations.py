#!/usr/bin/env python3
"""Check the protein sequences we translate against a reference proteome.

The feature explorer's protein rows are translated from the annotation GFF plus the
genome FASTA (see backend/translation.py).  The provider publishes the proteins it
derived from the same annotation, so those files are the source of truth:

  * Ensembl   ``.../geneset/pep.fa.bgz``  — FASTA headers carry ``transcript:ENST…``
  * RefSeq    ``…_protein.faa.gz``        — headers carry the protein accession, which
                                            is matched via the GFF ``protein_id``

Usage:

  # every coding transcript of the configured reference genome
  python backend/scripts/validate_translations.py --genome reference --pep pep.fa.bgz

  # a single chromosome, printing the first mismatching residues
  python backend/scripts/validate_translations.py --genome reference \\
      --pep pep.fa.bgz --chrom MT --show 20

  # a genome that is not in config.json
  python backend/scripts/validate_translations.py --index genes.gff3.index.db \\
      --fasta genome.fa --pep pep.fa.bgz --taxid 9606

Exit status is non-zero when the mismatch rate exceeds --max-mismatch-percent, so this
can be wired into a release check for whichever genomes are installed.
"""
from __future__ import annotations

import argparse
import gzip
import json
import re
import sqlite3
import sys
from collections import Counter
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

import pysam  # noqa: E402

from translation import (  # noqa: E402
    MOLECULE_NUCLEAR,
    TABLE_STANDARD,
    autodetect_organelle_table,
    build_translation_layout,
    classify_contig_molecule,
    internal_stop_count,
    translate_cds_dna,
    translation_table_for_lineage,
)


# ── reference proteome ────────────────────────────────────────────────────────

def _open_text(path: Path):
    if path.suffix in {".gz", ".bgz"}:
        return gzip.open(path, "rt", encoding="utf-8", errors="replace")
    return path.open("r", encoding="utf-8", errors="replace")


def load_reference_proteome(path: Path) -> Dict[str, str]:
    """{key: sequence} keyed by transcript id (Ensembl) or protein accession (RefSeq)."""
    proteins: Dict[str, str] = {}
    key: Optional[str] = None
    chunks: List[str] = []
    with _open_text(path) as handle:
        for line in handle:
            if line.startswith(">"):
                if key:
                    proteins[key] = "".join(chunks)
                header = line[1:].strip()
                match = re.search(r"transcript:(\S+)", header)
                token = match.group(1) if match else header.split()[0] if header else ""
                key = token.split(".")[0]
                chunks = []
            elif key:
                chunks.append(line.strip())
    if key:
        proteins[key] = "".join(chunks)
    return proteins


def load_gff_protein_ids(gff_path: Path) -> Dict[str, str]:
    """{transcript_id: protein_id} from CDS lines — needed to match RefSeq proteomes."""
    mapping: Dict[str, str] = {}
    if not gff_path.exists():
        return mapping
    with _open_text(gff_path) as handle:
        for line in handle:
            if line.startswith("#"):
                continue
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 9 or parts[2] != "CDS":
                continue
            attrs = parts[8]
            protein = re.search(r"protein_id=([^;]+)", attrs)
            parent = re.search(r"Parent=([^;]+)", attrs)
            if not protein or not parent:
                continue
            for raw in parent.group(1).split(","):
                # Ensembl writes Parent=transcript:ENST…, RefSeq writes Parent=rna-NM_…
                tx_id = raw.split(":")[-1].strip()
                tx_id = re.sub(r"^(rna|gene|id)-", "", tx_id)
                if tx_id:
                    mapping.setdefault(tx_id, protein.group(1).strip())
    return mapping


# ── genome resolution ────────────────────────────────────────────────────────

def resolve_from_config(genome: str) -> Tuple[str, str, str, Tuple[int, ...], Dict[str, str]]:
    """(index_db, fasta, gff, lineage, molecule_by_contig) for a configured genome."""
    import main  # imports FastAPI app; only needed for the config-driven path

    context = main._resolve_browse_genome_context(genome)
    translation_context = main._translation_context(genome)
    return (
        str(context.get("db_path") or ""),
        str(context.get("fasta_path") or ""),
        str(context.get("gff_path") or ""),
        tuple(translation_context.get("lineage") or ()),
        dict(translation_context.get("molecules") or {}),
    )


def lineage_for_taxid(taxid: int) -> Tuple[int, ...]:
    if not taxid:
        return ()
    from taxonomy_classifier import TaxonomyLineageClassifier

    _resolved, lineage = TaxonomyLineageClassifier().lineage_for_taxid(int(taxid))
    return tuple(lineage)


# ── comparison ───────────────────────────────────────────────────────────────

def fetch_cds_dna(fasta, chrom: str, strand: str, layout) -> str:
    from Bio.Seq import Seq

    pieces: List[str] = []
    for segment in layout.segments:
        expected = segment.coord_end - segment.coord_start + 1
        try:
            piece = fasta.fetch(chrom, segment.genomic_start - 1, segment.genomic_end).upper()
        except Exception:
            piece = ""
        if strand == "-":
            piece = str(Seq(piece).reverse_complement())
        if len(piece) < expected:
            piece += "N" * (expected - len(piece))
        pieces.append(piece[:expected])
    return "".join(pieces)


def iter_coding_transcripts(db_path: str, chroms: Optional[Iterable[str]]):
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    if chroms:
        chrom_list = list(chroms)
        cursor = conn.execute(
            "SELECT id, chrom, strand, data FROM transcripts WHERE chrom IN (%s)"
            % ",".join("?" * len(chrom_list)),
            chrom_list,
        )
    else:
        cursor = conn.execute("SELECT id, chrom, strand, data FROM transcripts")
    for row in cursor:
        try:
            data = json.loads(row["data"] or "{}")
        except Exception:
            continue
        cds_list = data.get("cds_list") or []
        if cds_list:
            yield row["id"], row["chrom"], row["strand"], cds_list
    conn.close()


def classify_mismatch(got: str, expected: str) -> str:
    if len(got) != len(expected):
        return "length_differs"
    diffs = [i for i, (a, b) in enumerate(zip(got, expected)) if a != b]
    if all(expected[i] in "UO" and got[i] == "*" for i in diffs):
        # Selenocysteine / pyrrolysine recoding, which the GFF does not carry.
        return "recoded_residue"
    if all(got[i] == "X" or expected[i] == "X" for i in diffs):
        return "ambiguous_residue"
    return "residues_differ"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--pep", required=True, help="reference proteome FASTA (Ensembl pep / RefSeq protein.faa)")
    parser.add_argument("--genome", default="", help="genome key from config.json (e.g. reference)")
    parser.add_argument("--index", default="", help="GFF index .db (instead of --genome)")
    parser.add_argument("--fasta", default="", help="genome FASTA (instead of --genome)")
    parser.add_argument("--gff", default="", help="annotation GFF, used to map RefSeq protein ids")
    parser.add_argument("--taxid", type=int, default=0, help="NCBI taxid, for the organelle genetic code")
    parser.add_argument("--assembly-report", default="",
                        help="assembly_report.txt / sequence_report.json, to identify organelle contigs")
    parser.add_argument("--chrom", action="append", default=[], help="restrict to these contigs (repeatable)")
    parser.add_argument("--show", type=int, default=10, help="mismatching transcripts to print per category")
    parser.add_argument("--max-mismatch-percent", type=float, default=0.0,
                        help="exit non-zero above this mismatch rate (default: any mismatch fails)")
    args = parser.parse_args()

    lineage: Tuple[int, ...] = ()
    molecules: Dict[str, str] = {}
    db_path, fasta_path, gff_path = args.index, args.fasta, args.gff
    if args.genome:
        db_path, fasta_path, config_gff, lineage, molecules = resolve_from_config(args.genome)
        gff_path = gff_path or config_gff
    if args.taxid:
        lineage = lineage_for_taxid(args.taxid)
    if args.assembly_report:
        from assembly_report import load_assembly_synonym_rows

        for row in load_assembly_synonym_rows(args.assembly_report):
            molecule = classify_contig_molecule(row.sequence_name, row.molecule_type)
            if molecule == MOLECULE_NUCLEAR:
                continue
            for alias in row.ordered_aliases():
                molecules[str(alias).strip().lower()] = molecule
    if not db_path or not fasta_path:
        parser.error("need --genome, or both --index and --fasta")

    truth = load_reference_proteome(Path(args.pep))
    if not truth:
        print(f"no proteins read from {args.pep}", file=sys.stderr)
        return 2
    protein_ids = load_gff_protein_ids(Path(gff_path)) if gff_path else {}

    fasta = pysam.FastaFile(fasta_path)
    references = set(fasta.references)

    stats: Counter = Counter()
    tables_used: Counter = Counter()
    examples: Dict[str, List[str]] = {}

    for tx_id, chrom, strand, cds_list in iter_coding_transcripts(db_path, args.chrom or None):
        base_id = str(tx_id).split(".")[0]
        expected = truth.get(base_id)
        if expected is None and protein_ids.get(tx_id):
            expected = truth.get(str(protein_ids[tx_id]).split(".")[0])
        if expected is None:
            stats["no_reference_protein"] += 1
            continue
        if chrom not in references:
            stats["contig_missing_from_fasta"] += 1
            continue

        molecule = molecules.get(str(chrom).lower()) or classify_contig_molecule(chrom)
        table = translation_table_for_lineage(molecule, lineage)
        layout = build_translation_layout(cds_list, strand)
        dna = fetch_cds_dna(fasta, chrom, strand, layout)
        if table is None:
            table = (
                autodetect_organelle_table(dna, start_phase=layout.start_phase)
                if molecule != MOLECULE_NUCLEAR
                else TABLE_STANDARD
            )
        got = translate_cds_dna(dna, start_phase=layout.start_phase, table=table)

        stats["compared"] += 1
        tables_used[table] += 1
        expected = expected.rstrip("*")
        if got == expected:
            stats["match"] += 1
            if internal_stop_count(got):
                stats["match_with_internal_stop"] += 1
            continue

        category = classify_mismatch(got, expected)
        stats[f"mismatch:{category}"] += 1
        examples.setdefault(category, []).append(
            f"  {tx_id} {chrom}{strand} table={table} len={len(got)} ref_len={len(expected)}\n"
            f"    ours {got[:60]}\n    ref  {expected[:60]}"
        )

    compared = stats["compared"]
    mismatched = sum(count for key, count in stats.items() if key.startswith("mismatch:"))
    print(f"compared            {compared}")
    print(f"match               {stats['match']}")
    print(f"mismatch            {mismatched}"
          + (f"  ({100.0 * mismatched / compared:.3f}%)" if compared else ""))
    for key in sorted(key for key in stats if key.startswith("mismatch:")):
        print(f"  {key[9:]:24s} {stats[key]}")
    for key in ("no_reference_protein", "contig_missing_from_fasta", "match_with_internal_stop"):
        if stats[key]:
            print(f"{key:20s} {stats[key]}")
    print("genetic codes used  " + ", ".join(f"table {table}: {count}" for table, count in sorted(tables_used.items())))

    if args.show:
        for category, entries in examples.items():
            print(f"\n{category} ({len(entries)}):")
            for entry in entries[: args.show]:
                print(entry)

    if not compared:
        print("nothing compared — check --pep matches this annotation", file=sys.stderr)
        return 2
    rate = 100.0 * mismatched / compared
    return 0 if rate <= args.max_mismatch_percent else 1


if __name__ == "__main__":
    raise SystemExit(main())
