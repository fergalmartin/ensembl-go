#!/usr/bin/env python3
"""Regenerate the translation test fixture from real Ensembl/RefSeq data.

backend/tests/test_translation_reference.py checks our proteins against the ones
Ensembl and RefSeq publish.  Those proteomes are far too large to commit, so this
script cuts a small self-contained fixture out of installed genomes: one contig per
transcript (the CDS span plus flanks, coordinates shifted), the matching GFF3, a
matching assembly report, and the provider's protein sequence as the expectation.

Run it when a case needs adding or an annotation release moves on:

  python backend/scripts/build_translation_fixture.py \\
      --ensembl-index  …/GCA_000001405.29.gff3.index.db \\
      --ensembl-fasta  …/GCA_000001405.29.softmasked.fa.bgz \\
      --ensembl-pep    …/pep.fa.bgz \\
      --refseq-index   …/GCF_000001405.40.genomic.gff.gff3.index.db \\
      --refseq-fasta   …/GCF_000001405.40_GRCh38.p14_genomic.fna \\
      --refseq-gff     …/GCF_000001405.40.genomic.gff \\
      --refseq-protein …/GCF_000001405.40_GRCh38.p14_protein.faa.gz

Ensembl pep files live at
https://ftp.ebi.ac.uk/pub/ensemblorganisms/<GCA path>/<provider>/<release>/geneset/pep.fa.bgz
and RefSeq proteomes next to the assembly on https://ftp.ncbi.nlm.nih.gov/genomes/all/.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
sys.path.insert(0, str(BACKEND_DIR / "scripts"))

import pysam  # noqa: E402

from translation import build_translation_layout  # noqa: E402
from validate_translations import load_gff_protein_ids, load_reference_proteome  # noqa: E402

FIXTURE_DIR = BACKEND_DIR / "tests" / "data"
FLANK = 30
HUMAN_TAXID = 9606

# (case_id, source, transcript_id, fixture contig, in assembly report, note)
#
# Contigs deliberately vary: most are described by the fixture assembly report (the
# path every downloaded genome takes), while MT/chrM are left out of it so the
# contig-name heuristic used for manually imported genomes is covered too.
CASES: Tuple[Dict[str, Any], ...] = (
    {
        "case_id": "ensembl_complete_plus",
        "source": "ensembl",
        "transcript": "ENST00000216714",
        "contig": "fx14a",
        "in_report": True,
        "note": "APEX1 MANE Select, 4 coding exons, complete CDS (UniProt P27695, 318 aa)",
    },
    {
        "case_id": "ensembl_complete_minus",
        "source": "ensembl",
        "transcript": "ENST00000258821",
        "contig": "fx14b",
        "in_report": True,
        "note": "TTC5 MANE Select on the minus strand, 10 coding exons (UniProt Q8ND56, 440 aa)",
    },
    {
        "case_id": "ensembl_complete_plus_alternating_phases",
        "source": "ensembl",
        "transcript": "ENST00000361505",
        "contig": "fx14f",
        "in_report": True,
        "note": "PNP MANE Select, 6 coding exons with phases 0,1,2,0,1,2 (UniProt P00491, 289 aa)",
    },
    {
        "case_id": "ensembl_five_prime_partial_phase1_plus",
        "source": "ensembl",
        "transcript": "ENST00000551466",
        "contig": "fx14c",
        "in_report": True,
        "note": "5'-incomplete CDS, first CDS phase 1: protein starts with X",
    },
    {
        "case_id": "ensembl_five_prime_partial_phase1_minus",
        "source": "ensembl",
        "transcript": "ENST00000539760",
        "contig": "fx14d",
        "in_report": True,
        "note": "5'-incomplete CDS on the minus strand, first CDS phase 1",
    },
    {
        "case_id": "ensembl_five_prime_partial_phase2_plus",
        "source": "ensembl",
        "transcript": "ENST00000679598",
        "contig": "fx19a",
        "in_report": True,
        "note": "5'-incomplete CDS, first CDS phase 2",
    },
    {
        "case_id": "ensembl_five_prime_partial_phase2_minus",
        "source": "ensembl",
        "transcript": "ENST00000588913",
        "contig": "fx19b",
        "in_report": True,
        "note": "5'-incomplete CDS on the minus strand, first CDS phase 2",
    },
    {
        "case_id": "ensembl_three_prime_partial_plus",
        "source": "ensembl",
        "transcript": "ENST00000601064",
        "contig": "fx19c",
        "in_report": True,
        "note": "3'-incomplete CDS: trailing partial codon is dropped, no stop to strip",
    },
    {
        "case_id": "ensembl_three_prime_partial_minus",
        "source": "ensembl",
        "transcript": "ENST00000431998",
        "contig": "fx19d",
        "in_report": True,
        "note": "3'-incomplete CDS on the minus strand",
    },
    {
        "case_id": "ensembl_mito_ata_start",
        "source": "ensembl",
        "transcript": "ENST00000361390",
        "contig": "MT",
        "in_report": False,
        "note": "MT-ND1: ATA start and TGA->Trp need the vertebrate mitochondrial code",
    },
    {
        "case_id": "ensembl_mito_att_start",
        "source": "ensembl",
        "transcript": "ENST00000361453",
        "contig": "fxMT2",
        "in_report": True,
        "note": "MT-ND2: ATT initiation codon is reported as Met; CDS ends mid-codon",
    },
    {
        "case_id": "ensembl_mito_terminal_aga",
        "source": "ensembl",
        "transcript": "ENST00000361624",
        "contig": "fxMT3",
        "in_report": True,
        "note": "MT-CO1: terminal AGA is a stop in the vertebrate mitochondrial code",
    },
    {
        "case_id": "ensembl_mito_minus",
        "source": "ensembl",
        "transcript": "ENST00000361681",
        "contig": "chrM",
        "in_report": False,
        "note": "MT-ND6 on the minus strand of the mitochondrion",
    },
    {
        "case_id": "ensembl_selenoprotein",
        "source": "ensembl",
        "transcript": "ENST00000389614",
        "contig": "fx14e",
        "in_report": True,
        "known_divergence": "selenocysteine",
        "note": "SELENOW: Ensembl recodes the TGA as U from annotation we do not have",
    },
    {
        "case_id": "refseq_complete_plus",
        "source": "refseq",
        "transcript": "NM_000454.5",
        "contig": "fx21a",
        "in_report": True,
        "note": "RefSeq SOD1, matched through the GFF protein_id",
    },
    {
        "case_id": "refseq_mito_cox1",
        "source": "refseq",
        "transcript": "COX1",
        "contig": "NC_012920.1",
        "in_report": True,
        "note": "RefSeq mitochondrion: molecule type comes from the assembly report",
    },
)


def load_cds(db_path: str, transcript_id: str) -> Tuple[str, str, List[Dict[str, Any]]]:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT chrom, strand, data FROM transcripts WHERE id = ? OR id LIKE ?",
        (transcript_id, f"{transcript_id}.%"),
    ).fetchone()
    conn.close()
    if row is None:
        raise SystemExit(f"transcript {transcript_id} not found in {db_path}")
    data = json.loads(row["data"] or "{}")
    return str(row["chrom"]), str(row["strand"]), list(data.get("cds_list") or [])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--ensembl-index", required=True)
    parser.add_argument("--ensembl-fasta", required=True)
    parser.add_argument("--ensembl-pep", required=True)
    parser.add_argument("--refseq-index", default="")
    parser.add_argument("--refseq-fasta", default="")
    parser.add_argument("--refseq-gff", default="")
    parser.add_argument("--refseq-protein", default="")
    parser.add_argument("--out-dir", default=str(FIXTURE_DIR))
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    sources: Dict[str, Dict[str, Any]] = {
        "ensembl": {
            "index": args.ensembl_index,
            "fasta": pysam.FastaFile(args.ensembl_fasta),
            "proteins": load_reference_proteome(Path(args.ensembl_pep)),
            "protein_ids": {},
        }
    }
    if args.refseq_index:
        sources["refseq"] = {
            "index": args.refseq_index,
            "fasta": pysam.FastaFile(args.refseq_fasta),
            "proteins": load_reference_proteome(Path(args.refseq_protein)),
            "protein_ids": load_gff_protein_ids(Path(args.refseq_gff)) if args.refseq_gff else {},
        }

    fasta_lines: List[str] = []
    gff_lines: List[str] = ["##gff-version 3"]
    report_rows: List[str] = []
    expected: List[Dict[str, Any]] = []

    for case in CASES:
        source = sources.get(case["source"])
        if source is None:
            print(f"skipping {case['case_id']}: no {case['source']} data supplied")
            continue

        chrom, strand, cds_list = load_cds(source["index"], case["transcript"])
        layout = build_translation_layout(cds_list, strand)
        if not layout.segments:
            raise SystemExit(f"{case['case_id']}: no CDS segments")

        protein = source["proteins"].get(case["transcript"].split(".")[0])
        if protein is None:
            accession = source["protein_ids"].get(case["transcript"], "")
            protein = source["proteins"].get(str(accession).split(".")[0])
        if protein is None:
            raise SystemExit(f"{case['case_id']}: no reference protein for {case['transcript']}")
        protein = protein.rstrip("*")

        lo = min(min(c["start"], c["end"]) for c in cds_list) - FLANK
        hi = max(max(c["start"], c["end"]) for c in cds_list) + FLANK
        lo = max(1, lo)
        sequence = source["fasta"].fetch(chrom, lo - 1, hi).upper()
        shift = lo - 1

        contig = case["contig"]
        fasta_lines.append(f">{contig}")
        for index in range(0, len(sequence), 60):
            fasta_lines.append(sequence[index:index + 60])

        gene_lo = min(min(c["start"], c["end"]) for c in cds_list) - shift
        gene_hi = max(max(c["start"], c["end"]) for c in cds_list) - shift
        transcript_id = case["transcript"]
        attrs_gene = f"ID=gene:{case['case_id']};Name={case['case_id']};biotype=protein_coding"
        gff_lines.append(f"{contig}\tfixture\tgene\t{gene_lo}\t{gene_hi}\t.\t{strand}\t.\t{attrs_gene}")
        gff_lines.append(
            f"{contig}\tfixture\tmRNA\t{gene_lo}\t{gene_hi}\t.\t{strand}\t.\t"
            f"ID=transcript:{transcript_id};Parent=gene:{case['case_id']};biotype=protein_coding"
        )
        for cds in sorted(cds_list, key=lambda c: min(c["start"], c["end"])):
            start = min(cds["start"], cds["end"]) - shift
            end = max(cds["start"], cds["end"]) - shift
            phase = cds.get("phase")
            phase_field = str(phase) if phase in (0, 1, 2) else "."
            gff_lines.append(
                f"{contig}\tfixture\tCDS\t{start}\t{end}\t.\t{strand}\t{phase_field}\t"
                f"ID=CDS:{transcript_id};Parent=transcript:{transcript_id}"
            )

        if case.get("in_report"):
            molecule = "Mitochondrion" if chrom in {"MT", "NC_012920.1"} else "Chromosome"
            report_rows.append(
                f"{contig}\tassembled-molecule\t{contig}\t{molecule}\tna\t=\t{contig}\t"
                f"{'non-nuclear' if molecule == 'Mitochondrion' else 'Primary Assembly'}\t{len(sequence)}\t{contig}"
            )

        expected.append({
            "case_id": case["case_id"],
            "source": case["source"],
            "source_contig": chrom,
            "transcript": transcript_id,
            "contig": contig,
            "strand": strand,
            "taxid": HUMAN_TAXID,
            "cds_count": len(cds_list),
            "start_phase": layout.start_phase,
            "three_prime_partial": layout.three_prime_partial,
            "protein": protein,
            "known_divergence": case.get("known_divergence", ""),
            "note": case["note"],
        })
        print(f"{case['case_id']:42s} {contig:14s} {len(sequence):7d} bp  protein {len(protein)} aa")

    fasta_path = out_dir / "translation_fixture.fa"
    fasta_path.write_text("\n".join(fasta_lines) + "\n", encoding="utf-8")
    pysam.faidx(str(fasta_path))

    (out_dir / "translation_fixture.gff3").write_text("\n".join(gff_lines) + "\n", encoding="utf-8")

    report_header = (
        "# Assembly name:  translation-fixture\n"
        "# Organism name:  Homo sapiens (human)\n"
        f"# Taxid:          {HUMAN_TAXID}\n"
        "# Sequence-Name\tSequence-Role\tAssigned-Molecule\tAssigned-Molecule-Location/Type"
        "\tGenBank-Accn\tRelationship\tRefSeq-Accn\tAssembly-Unit\tSequence-Length\tUCSC-style-name\n"
    )
    (out_dir / "translation_fixture_assembly_report.txt").write_text(
        report_header + "\n".join(report_rows) + "\n", encoding="utf-8"
    )

    (out_dir / "translation_fixture_expected.json").write_text(
        json.dumps({"generated_from": "GRCh38 (Ensembl + RefSeq)", "cases": expected}, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"\nwrote fixture to {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
