#!/usr/bin/env python3
"""Generate the chromosome-1 slice the genome browser tutorial runs on.

The Getting Started tutorial has *Ensemblus welcomus*: twenty-two kilobases, six genes,
one transcript each. That is the right size for teaching the download view and useless
for teaching the browser, which is about transcripts, biotypes, sequence and zoom.

So this cuts a real one. Half a megabase of GRCh38 around REG4, with its Ensembl
annotation, which brings PHGDH (38 transcripts), HMGCS2 (22), NOTCH2 (13, and 189 kb
long), REG4 itself (5, one of them MANE Select), and a scattering of lncRNAs and
pseudogenes for the gene-class filter to remove.

**The coordinates are real.** The FASTA record is called ``1`` and the slice sits at its
true offset, with ``N`` in front of it — runs of ``N`` cost almost nothing once bgzipped,
so a hundred and twenty megabases of padding comes to a few hundred kilobytes and REG4
answers at 1:119,794,017 exactly as it does on the Ensembl website. There is no
coordinate-offset layer anywhere in the browse path to do this any other way; the region
length the browser draws comes straight from the FASTA record.

Deterministic: same inputs, same bytes. Re-run and commit the result.

    python3 backend/scripts/build_grch38_slice.py

The source assembly is not in this repository. It is a genome the app itself downloaded;
point --fasta/--gff at any Ensembl GRCh38 pair if the default is not where yours lives.
"""

from __future__ import annotations

import argparse
import gzip
import re
import shutil
import tempfile
from pathlib import Path

import pysam

OUT_DIR = Path(__file__).resolve().parents[1] / "data" / "grch38_reg4"

# The window. It runs from just before a lncRNA at 118,450,347 to just past NOTCH2, which
# puts REG4 — the gene the tutorial focuses — about four fifths of the way along with a
# megabase of populated sequence in front of it.
#
# That megabase is the point. A window that started at 119.6 Mb left the browser with
# nothing at all to the left of the first gene, so zooming out produced a screen of empty
# track, which reads as something being broken rather than as the edge of a slice.
CHROM = "1"
REGION_START = 118_440_000          # 1-based inclusive
REGION_END = 120_120_000            # 1-based inclusive

# The record stops at the end of the slice rather than running on to chromosome 1's true
# 248,956,422 bp. Padding the tail as well would double the file for nothing: it is empty
# either way, and the tutorial never goes there.
CHROM_LENGTH = REGION_END

ASSEMBLY_NAME = "GRCh38-REG4-slice"
ORGANISM = "Homo sapiens (demo slice)"
TAXID = "9606"

DEFAULT_FASTA = Path(
    "/Users/fergal/Desktop/ensembl_go_section_demo/local_data/Homo_sapiens/"
    "GCA_000001405.29/assembly/GCA_000001405.29.softmasked.fa.bgz"
)
DEFAULT_GFF = Path(
    "/Users/fergal/Desktop/ensembl_go_section_demo/local_data/Homo_sapiens/"
    "GCA_000001405.29/datasets/ensembl/2025_12/GCA_000001405.29.gff3.gz"
)

FASTA_LINE = 60
ID_RE = re.compile(r"(?:^|;)ID=([^;]+)")
PARENT_RE = re.compile(r"(?:^|;)Parent=([^;]+)")


def attribute(pattern: re.Pattern, attrs: str) -> str:
    match = pattern.search(attrs)
    return match.group(1) if match else ""


def read_annotation(gff_path: Path) -> list[str]:
    """Every annotation line for this window, parents and children both.

    Filtering line by line on coordinates would keep exons whose gene fell outside the
    window and drop genes whose last exon fell over the edge, leaving orphans the indexer
    would have to guess about. So genes are chosen on coordinates, and everything else is
    chosen on descent from a gene that was kept.
    """
    lines: list[str] = []
    seen_chrom = False
    with gzip.open(gff_path, "rt", encoding="utf-8") as handle:
        for line in handle:
            if line.startswith("#"):
                continue
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 9:
                continue
            if parts[0] != CHROM:
                # The file is grouped by region, so once chromosome 1 is behind us there
                # is nothing left to find.
                if seen_chrom:
                    break
                continue
            seen_chrom = True
            start = int(parts[3])
            if start > REGION_END:
                break
            if int(parts[4]) < REGION_START:
                continue
            lines.append(line.rstrip("\n"))

    genes: set[str] = set()
    for line in lines:
        parts = line.split("\t")
        feature_id = attribute(ID_RE, parts[8])
        if not feature_id.startswith("gene:"):
            continue
        if int(parts[3]) >= REGION_START and int(parts[4]) <= REGION_END:
            genes.add(feature_id)

    transcripts: set[str] = set()
    for line in lines:
        parts = line.split("\t")
        feature_id = attribute(ID_RE, parts[8])
        parent = attribute(PARENT_RE, parts[8])
        if feature_id and parent and parent in genes:
            transcripts.add(feature_id)

    kept = []
    for line in lines:
        parts = line.split("\t")
        feature_id = attribute(ID_RE, parts[8])
        parent = attribute(PARENT_RE, parts[8])
        if feature_id in genes or parent in genes or parent in transcripts:
            kept.append(line)

    # Left in the order the source file had them. That order is gene, then transcript,
    # then the transcript's exons and CDS, and the indexer is a single-pass reader that
    # attaches a child to a parent it has already seen — so sorting by coordinate, which
    # puts a gene's first exon ahead of the gene when they share a start, silently loses
    # the lot.
    seen: set[str] = set()
    for line in kept:
        attrs = line.split("\t")[8]
        parent = attribute(PARENT_RE, attrs)
        if parent and parent not in seen:
            raise SystemExit(f"child before parent in the output: {parent}")
        feature_id = attribute(ID_RE, attrs)
        if feature_id:
            seen.add(feature_id)
    return kept


def write_fasta(fasta_path: Path, out_path: Path) -> int:
    """The padded record, bgzipped, with its .fai and .gzi beside it."""
    with pysam.FastaFile(str(fasta_path)) as handle:
        # pysam is 0-based half-open; the region constants are 1-based inclusive.
        sequence = handle.fetch(CHROM, REGION_START - 1, REGION_END).upper()
    if len(sequence) != REGION_END - REGION_START + 1:
        raise SystemExit(f"expected {REGION_END - REGION_START + 1} bp, fetched {len(sequence)}")

    with tempfile.TemporaryDirectory() as tmp:
        plain = Path(tmp) / "slice.fa"
        with plain.open("w", encoding="utf-8") as out:
            out.write(f">{CHROM} {ORGANISM} chromosome {CHROM} slice\n")
            # Everything before the window is N. Written a line at a time so the wrap
            # stays at 60 and the .fai htslib writes is a normal one.
            pad = REGION_START - 1
            filler = ("N" * FASTA_LINE + "\n") * 1000
            while pad >= FASTA_LINE * 1000:
                out.write(filler)
                pad -= FASTA_LINE * 1000
            while pad >= FASTA_LINE:
                out.write("N" * FASTA_LINE + "\n")
                pad -= FASTA_LINE
            # The window does not begin on a line boundary, so the last padding line is
            # topped up with real bases and the wrap carries on from there.
            head = "N" * pad
            body = head + sequence
            for i in range(0, len(body), FASTA_LINE):
                out.write(body[i:i + FASTA_LINE] + "\n")

        pysam.tabix_compress(str(plain), str(out_path), force=True)

    for stale in (out_path.with_suffix(out_path.suffix + ".fai"), out_path.with_suffix(out_path.suffix + ".gzi")):
        if stale.exists():
            stale.unlink()
    pysam.faidx(str(out_path))
    return len(sequence)


def write_gff(lines: list[str], out_path: Path) -> None:
    header = ["##gff-version 3", f"##sequence-region {CHROM} 1 {CHROM_LENGTH}"]
    payload = ("\n".join(header + lines) + "\n").encode("utf-8")
    # mtime 0 so re-running the script produces identical bytes rather than a diff.
    with out_path.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", compresslevel=9, fileobj=raw, mtime=0) as gz:
            gz.write(payload)


def write_assembly_report(out_path: Path) -> None:
    with out_path.open("w", encoding="utf-8") as handle:
        handle.write(f"# Assembly name:  {ASSEMBLY_NAME}\n")
        handle.write(f"# Organism name:  {ORGANISM}\n")
        handle.write(f"# Taxid:          {TAXID}\n")
        handle.write(
            "# Sequence-Name\tSequence-Role\tAssigned-Molecule\tAssigned-Molecule-Location/Type"
            "\tGenBank-Accn\tRelationship\tRefSeq-Accn\tAssembly-Unit\tSequence-Length\tUCSC-style-name\n"
        )
        handle.write(
            f"{CHROM}\tassembled-molecule\t{CHROM}\tChromosome\tna\t=\t{CHROM}"
            f"\tPrimary Assembly\t{CHROM_LENGTH}\tchr{CHROM}\n"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fasta", type=Path, default=DEFAULT_FASTA)
    parser.add_argument("--gff", type=Path, default=DEFAULT_GFF)
    args = parser.parse_args()

    for path in (args.fasta, args.gff):
        if not path.is_file():
            raise SystemExit(f"source not found: {path}\nPass --fasta/--gff to point at your own copy.")

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    lines = read_annotation(args.gff)
    if not lines:
        raise SystemExit("no annotation found in the window — is this a GRCh38 Ensembl GFF3?")
    write_gff(lines, OUT_DIR / "grch38_reg4.gff3.gz")

    span = write_fasta(args.fasta, OUT_DIR / "grch38_reg4.fa.bgz")
    write_assembly_report(OUT_DIR / "grch38_reg4_assembly_report.txt")

    genes = [line for line in lines if attribute(ID_RE, line.split("\t")[8]).startswith("gene:")]
    named = [
        attribute(re.compile(r"(?:^|;)Name=([^;]+)"), line.split("\t")[8]) or "—"
        for line in genes
    ]
    total = sum(path.stat().st_size for path in OUT_DIR.iterdir())
    print(f"wrote {OUT_DIR}")
    print(f"  {CHROM}:{REGION_START:,}-{REGION_END:,}  ({span:,} bp of sequence in a {CHROM_LENGTH:,} bp record)")
    print(f"  {len(genes)} genes, {len(lines)} annotation lines")
    print(f"  {total / 1024:,.0f} KB total")
    print("  " + ", ".join(sorted(name for name in named if name != "—")))


if __name__ == "__main__":
    main()
