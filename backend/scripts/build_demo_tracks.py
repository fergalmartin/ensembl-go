#!/usr/bin/env python3
"""Generate the three demo data tracks the Track Manager tutorial registers.

The tutorial teaches registering custom tracks and reading them in the browser. It needs
real files the reader can browse to and pick, and they have to be small enough to ship in
the repository — so this cuts a window out of three real GRCh38 tracks:

    brain expression   BigWig, RNA-seq        a zoned heatmap over PHGDH's exons
    ATAC-seq           BigWig, ATAC-seq       a signal plot, peaking at a shared promoter
    variants           VCF + tabix index      density blocks, then individual variants

**The window is 220 kb, not the browser tutorial's whole 1.68 Mb slice.** The same window
of the source VCF holds 648,191 variants and comes to 7.08 MB bgzipped, which has no
business in a git repository. Cut to chr1:119,600,000-119,820,000 it is 0.91 MB, and that
window still holds ZNF697, PHGDH, HMGCS2 and REG4 whole. The genome the tracks are read
against is unchanged: ``backend/data/grch38_reg4``, which the browser tutorial already
ships, so this adds no genome bytes and a reader who has done that tutorial already knows
the region.

**The coordinates are real**, exactly as they are for the slice genome. The BigWig headers
declare chromosome ``1`` at its true length, so a feature answers at its true GRCh38
coordinate and can be checked against Ensembl. The source files must use ``1`` rather than
``chr1``; the script asserts it rather than silently renaming, because a track whose
chromosome does not match the genome's simply draws nothing.

Deterministic: same inputs, same bytes. Re-run and commit the result.

    python3 backend/scripts/build_demo_tracks.py

The source tracks are not in this repository — they are files the app itself has
registered. Point --brain/--atac/--vcf at your own copies if the defaults are not where
yours live.
"""

from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

import pyBigWig
import pysam

OUT_DIR = Path(__file__).resolve().parents[1] / "data" / "demo_tracks"

# The window. It opens just before ZNF697 and closes just past REG4, so all four of the
# genes the tutorial names sit inside it whole, and PHGDH — the gene the expression and
# ATAC steps are about — is roughly in the middle with room to zoom.
CHROM = "1"
START = 119_600_000
END = 119_820_000

DEFAULT_ROOT = Path.home() / "Desktop" / "ensembl_go_section_demo" / "local_data"
DEFAULT_BRAIN = DEFAULT_ROOT / "Custom tracks" / "GRCh38.illumina.brain.1.bam.bw"
DEFAULT_ATAC = DEFAULT_ROOT / "Custom tracks" / "atac_seq_adrenal_gland_m_54_y.bw"
DEFAULT_VCF = DEFAULT_ROOT / "Custom tracks" / "homo_sapiens-chr1.vcf.gz"

BRAIN_NAME = "brain_expression.bw"
ATAC_NAME = "atac_seq_peaks.bw"
VCF_NAME = "variants.vcf.gz"


def slice_bigwig(source: Path, destination: Path) -> int:
    """Copy one chromosome's intervals in the window into a fresh BigWig.

    The header keeps the source's own chromosome length, so coordinates stay true and the
    browser draws the signal where it really is rather than at an offset.
    """
    reader = pyBigWig.open(str(source))
    try:
        chroms = reader.chroms()
        if CHROM not in chroms:
            raise SystemExit(
                f"{source.name} names its chromosomes {sorted(chroms)[:3]}…, not {CHROM!r}. "
                "The demo genome's FASTA record is '1'; a track using 'chr1' draws nothing."
            )
        intervals = reader.intervals(CHROM, START, END) or []
        writer = pyBigWig.open(str(destination), "w")
        try:
            writer.addHeader([(CHROM, chroms[CHROM])])
            writer.addEntries(
                [CHROM] * len(intervals),
                [int(i[0]) for i in intervals],
                ends=[int(i[1]) for i in intervals],
                values=[float(i[2]) for i in intervals],
            )
        finally:
            writer.close()
    finally:
        reader.close()
    return len(intervals)


def slice_vcf(source: Path, destination: Path) -> int:
    """Write the window's variants out with the source header, bgzipped and tabixed."""
    reader = pysam.VariantFile(str(source))
    if CHROM not in reader.header.contigs:
        raise SystemExit(
            f"{source.name} has no contig {CHROM!r} — the demo genome's record is '1'."
        )
    plain = destination.with_suffix("")  # …/variants.vcf
    count = 0
    with open(plain, "w", encoding="utf-8") as handle:
        handle.write(str(reader.header))
        for record in reader.fetch(CHROM, START, END):
            handle.write(str(record))
            count += 1
    reader.close()
    subprocess.run(["bgzip", "-f", str(plain)], check=True)
    subprocess.run(["tabix", "-f", "-p", "vcf", str(destination)], check=True)
    return count


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--brain", type=Path, default=DEFAULT_BRAIN)
    parser.add_argument("--atac", type=Path, default=DEFAULT_ATAC)
    parser.add_argument("--vcf", type=Path, default=DEFAULT_VCF)
    args = parser.parse_args()

    for path in (args.brain, args.atac, args.vcf):
        if not path.is_file():
            raise SystemExit(f"Source track not found: {path}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    brain = slice_bigwig(args.brain, OUT_DIR / BRAIN_NAME)
    atac = slice_bigwig(args.atac, OUT_DIR / ATAC_NAME)
    variants = slice_vcf(args.vcf, OUT_DIR / VCF_NAME)

    print(f"{CHROM}:{START:,}-{END:,}  ({(END - START) / 1000:.0f} kb)")
    total = 0
    for name, detail in (
        (BRAIN_NAME, f"{brain:,} intervals"),
        (ATAC_NAME, f"{atac:,} intervals"),
        (VCF_NAME, f"{variants:,} variants"),
        (VCF_NAME + ".tbi", "index"),
    ):
        size = (OUT_DIR / name).stat().st_size
        total += size
        print(f"  {name:<22} {detail:>18}  {size / 1024:>8.0f} K")
    print(f"  {'total':<22} {'':>18}  {total / 1024:>8.0f} K")


if __name__ == "__main__":
    main()
