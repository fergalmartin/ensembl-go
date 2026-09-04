#!/usr/bin/env python3
"""Generate the demo genome the Getting Started tutorial installs.

The tutorial needs a genome small enough to ship (a hundred kilobytes rather than a
hundred gigabytes) but real enough that the browser, the feature explorer and the
translation code all behave exactly as they would on a downloaded assembly. So this
writes a genuine little assembly: contigs of real sequence, genes with multi-exon
transcripts, UTRs, and coding regions that translate to clean open reading frames.

The genes are called Welcome, To, Ensembl and Go, which is the joke, and Have and Fun on
a second contig, which is the rest of it.

Deterministic: same seed, same files. Re-run and commit the result.

    python3 backend/scripts/build_demo_genome.py
"""

from __future__ import annotations

import random
from pathlib import Path

SEED = 20260820
OUT_DIR = Path(__file__).resolve().parents[1] / "data" / "demo_genome"

ASSEMBLY_NAME = "EnsWel1.0"
ORGANISM = "Ensemblus welcomus (demo)"
TAXID = "32644"  # NCBI's "unidentified", which is the honest answer for a made-up species.

BASES = "ACGT"
STOPS = {"TAA", "TAG", "TGA"}
# Codons that are safe to drop into a reading frame: everything but the stops.
SENSE_CODONS = [a + b + c for a in BASES for b in BASES for c in BASES if a + b + c not in STOPS]
COMPLEMENT = str.maketrans("ACGTacgt", "TGCAtgca")


def revcomp(seq: str) -> str:
    return seq.translate(COMPLEMENT)[::-1]


# name, strand, exon lengths in transcript order, gap between exons, 5' UTR, 3' UTR
GENES = {
    "welcome1": [
        # UTR lengths are deliberately not multiples of three, so codons straddle the
        # exon boundaries and the CDS phases below are actually exercised.
        ("Welcome", "+", [312, 258, 402], 900, 97, 120),
        ("To", "+", [222, 465], 1400, 71, 90),
        ("Ensembl", "-", [180, 342, 291, 258], 750, 85, 111),
        ("Go", "+", [396, 210], 1100, 62, 150),
    ],
    "welcome2": [
        ("Have", "+", [267, 333], 1000, 67, 99),
        ("Fun", "-", [288, 216], 850, 79, 120),
    ],
}

CONTIG_LEAD = 400      # slack before the first gene
CONTIG_TAIL = 600      # slack after the last gene
GENE_GAP = 1200        # intergenic distance


def build_transcript_sequence(rng: random.Random, mrna_len: int, utr5: int, utr3: int) -> str:
    """A transcript whose coding part is a clean ORF: ATG, sense codons, one stop."""
    cds_len = mrna_len - utr5 - utr3
    cds_len -= cds_len % 3
    if cds_len < 6:
        raise ValueError("transcript too short to hold a start and a stop codon")
    codons = ["ATG"]
    codons.extend(rng.choice(SENSE_CODONS) for _ in range(cds_len // 3 - 2))
    codons.append("TAA")
    cds = "".join(codons)
    lead = "".join(rng.choice(BASES) for _ in range(utr5))
    tail = "".join(rng.choice(BASES) for _ in range(mrna_len - utr5 - cds_len))
    return lead + cds + tail, utr5, cds_len


def place_exons(start: int, exon_lengths: list[int], gap: int, strand: str) -> list[tuple[int, int]]:
    """Genomic (start, end) pairs, 1-based inclusive, in ascending genomic order.

    `exon_lengths` is in transcript order, so on the minus strand it is laid down
    back-to-front.
    """
    lengths = list(exon_lengths) if strand == "+" else list(reversed(exon_lengths))
    spans = []
    cursor = start
    for length in lengths:
        spans.append((cursor, cursor + length - 1))
        cursor += length + gap
    return spans


def transcript_offsets(spans: list[tuple[int, int]], strand: str) -> list[tuple[int, int]]:
    """Each genomic span paired with where it begins in the transcript."""
    ordered = spans if strand == "+" else list(reversed(spans))
    offsets = []
    cursor = 0
    for span in ordered:
        offsets.append((span, cursor))
        cursor += span[1] - span[0] + 1
    return offsets


def slice_transcript_range(spans, strand, tx_start, tx_end):
    """Genomic pieces covering transcript coordinates [tx_start, tx_end)."""
    pieces = []
    for (span_start, span_end), offset in transcript_offsets(spans, strand):
        span_len = span_end - span_start + 1
        lo = max(tx_start, offset)
        hi = min(tx_end, offset + span_len)
        if lo >= hi:
            continue
        if strand == "+":
            pieces.append((span_start + (lo - offset), span_start + (hi - offset) - 1))
        else:
            pieces.append((span_end - (hi - offset) + 1, span_end - (lo - offset)))
    return sorted(pieces)


def main() -> None:
    rng = random.Random(SEED)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    gff_lines = ["##gff-version 3"]
    contigs: dict[str, str] = {}
    region_lines = []

    for contig, genes in GENES.items():
        # Lay the genes out first so the contig length is known.
        layout = []
        cursor = CONTIG_LEAD
        for name, strand, exon_lengths, gap, utr5, utr3 in genes:
            spans = place_exons(cursor, exon_lengths, gap, strand)
            layout.append((name, strand, spans, utr5, utr3))
            cursor = spans[-1][1] + GENE_GAP
        contig_len = cursor + CONTIG_TAIL

        bases = [rng.choice(BASES) for _ in range(contig_len)]

        for name, strand, spans, utr5, utr3 in layout:
            mrna_len = sum(end - start + 1 for start, end in spans)
            mrna, utr5_len, cds_len = build_transcript_sequence(rng, mrna_len, utr5, utr3)

            # Write the transcript's bases into the contig, flipping on the minus strand.
            for (span_start, span_end), offset in transcript_offsets(spans, strand):
                span_len = span_end - span_start + 1
                chunk = mrna[offset:offset + span_len]
                if strand == "-":
                    chunk = revcomp(chunk)
                bases[span_start - 1:span_end] = list(chunk)

            gene_start, gene_end = spans[0][0], spans[-1][1]
            gene_id = f"gene:{name}"
            tx_id = f"transcript:{name}-201"

            gff_lines.append(
                f"{contig}\tdemo\tgene\t{gene_start}\t{gene_end}\t.\t{strand}\t.\t"
                f"ID={gene_id};Name={name};biotype=protein_coding;"
                f"description=Demo gene {name}"
            )
            gff_lines.append(
                f"{contig}\tdemo\tmRNA\t{gene_start}\t{gene_end}\t.\t{strand}\t.\t"
                f"ID={tx_id};Parent={gene_id};Name={name}-201;biotype=protein_coding"
            )
            for span_start, span_end in spans:
                gff_lines.append(
                    f"{contig}\tdemo\texon\t{span_start}\t{span_end}\t.\t{strand}\t.\t"
                    f"ID=exon:{name};Parent={tx_id}"
                )

            cds_pieces = slice_transcript_range(spans, strand, utr5_len, utr5_len + cds_len)
            ordered = cds_pieces if strand == "+" else list(reversed(cds_pieces))
            consumed = 0
            for piece_start, piece_end in ordered:
                phase = (3 - (consumed % 3)) % 3
                gff_lines.append(
                    f"{contig}\tdemo\tCDS\t{piece_start}\t{piece_end}\t.\t{strand}\t{phase}\t"
                    f"ID=CDS:{name};Parent={tx_id}"
                )
                consumed += piece_end - piece_start + 1

            for label, lo, hi in (
                ("five_prime_UTR", 0, utr5_len),
                ("three_prime_UTR", utr5_len + cds_len, mrna_len),
            ):
                for piece_start, piece_end in slice_transcript_range(spans, strand, lo, hi):
                    gff_lines.append(
                        f"{contig}\tdemo\t{label}\t{piece_start}\t{piece_end}\t.\t{strand}\t.\t"
                        f"Parent={tx_id}"
                    )

        contigs[contig] = "".join(bases)
        region_lines.append((contig, contig_len))

    # Sort so the GFF is grouped by contig, which is what a real annotation looks like.
    header = [gff_lines[0]] + [f"##sequence-region {name} 1 {length}" for name, length in region_lines]
    body = sorted(
        gff_lines[1:],
        key=lambda line: (list(GENES).index(line.split("\t")[0]), int(line.split("\t")[3])),
    )

    fasta_path = OUT_DIR / "demo.fa"
    with fasta_path.open("w", encoding="utf-8") as handle:
        for name, seq in contigs.items():
            handle.write(f">{name} {ORGANISM} demo contig\n")
            for i in range(0, len(seq), 60):
                handle.write(seq[i:i + 60] + "\n")

    # A .fai so the browser can seek without building one on first use.
    with (OUT_DIR / "demo.fa.fai").open("w", encoding="utf-8") as handle:
        offset = 0
        for name, seq in contigs.items():
            header_len = len(f">{name} {ORGANISM} demo contig\n")
            offset += header_len
            handle.write(f"{name}\t{len(seq)}\t{offset}\t60\t61\n")
            offset += len(seq) + (len(seq) + 59) // 60

    (OUT_DIR / "demo.gff3").write_text("\n".join(header + body) + "\n", encoding="utf-8")

    with (OUT_DIR / "demo_assembly_report.txt").open("w", encoding="utf-8") as handle:
        handle.write(f"# Assembly name:  {ASSEMBLY_NAME}\n")
        handle.write(f"# Organism name:  {ORGANISM}\n")
        handle.write(f"# Taxid:          {TAXID}\n")
        handle.write(
            "# Sequence-Name\tSequence-Role\tAssigned-Molecule\tAssigned-Molecule-Location/Type"
            "\tGenBank-Accn\tRelationship\tRefSeq-Accn\tAssembly-Unit\tSequence-Length\tUCSC-style-name\n"
        )
        for name, length in region_lines:
            handle.write(
                f"{name}\tassembled-molecule\t{name}\tChromosome\tna\t=\t{name}"
                f"\tPrimary Assembly\t{length}\t{name}\n"
            )

    total = sum(len(seq) for seq in contigs.values())
    print(f"wrote {OUT_DIR}")
    print(f"  {len(contigs)} contigs, {total:,} bp, {sum(len(v) for v in GENES.values())} genes")


if __name__ == "__main__":
    main()
