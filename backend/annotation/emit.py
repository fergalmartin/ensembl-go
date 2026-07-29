"""Write the canonical Ensembl-style GFF3 that everything downstream consumes.

Output shape (docs/CUSTOM_GENOMES.md §3.7):

    gene -> mRNA -> exon / CDS / five_prime_UTR / three_prime_UTR

with ``gene:`` and ``transcript:`` ID prefixes, explicit ``biotype`` attributes and
an ``Ensembl_canonical`` tag on exactly one transcript per gene. That is precisely
the dialect ``main.create_gff_index`` already handles best, which is why
conversion is the integration point rather than replacing the indexer.

Rows are sorted by sequence region then start so the file is tabix-indexable and
byte-stable between runs.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import datetime
from typing import Callable, Dict, Iterable, List, Optional, Sequence, Tuple

from .model import Block, Gene, Transcript

#: Column 2 of every emitted row, so converted files are self-identifying.
SOURCE_LABEL = "ensembl_go"

#: Ordering within one start coordinate: parents before children.
_TYPE_RANK = {
    "gene": 0,
    "mRNA": 1,
    "transcript": 1,
    "exon": 2,
    "CDS": 3,
    "five_prime_UTR": 4,
    "three_prime_UTR": 5,
}

#: Characters that must be percent-encoded inside a GFF3 attribute value.
_ESCAPES = {
    "%": "%25",
    ";": "%3B",
    "=": "%3D",
    "&": "%26",
    ",": "%2C",
    "\t": "%09",
    "\n": "%0A",
    "\r": "%0D",
}


def escape_attribute(value: str) -> str:
    """Percent-encode a GFF3 attribute value.

    ``%`` is replaced first so an already-encoded sequence is not double-escaped
    into something that decodes differently.
    """
    text = str(value or "")
    out = []
    for ch in text:
        out.append(_ESCAPES.get(ch, ch))
    return "".join(out)


def _format_attributes(pairs: Sequence[Tuple[str, str]]) -> str:
    parts = []
    for key, value in pairs:
        if value is None or value == "":
            continue
        parts.append("{0}={1}".format(key, escape_attribute(value)))
    return ";".join(parts)


@dataclass
class _Row:
    seqid: str
    ftype: str
    start: int
    end: int
    strand: str
    phase: str
    attributes: str

    @property
    def sort_key(self) -> Tuple[str, int, int, int]:
        # Longer features first at a shared start so a gene precedes its
        # transcript, then the explicit type rank breaks remaining ties.
        return (self.seqid, self.start, -self.end, _TYPE_RANK.get(self.ftype, 9))

    def render(self) -> str:
        return "\t".join([
            self.seqid,
            SOURCE_LABEL,
            self.ftype,
            str(self.start),
            str(self.end),
            ".",
            self.strand or ".",
            self.phase or ".",
            self.attributes,
        ])


def _transcript_feature_type(transcript: Transcript) -> str:
    """Ensembl types coding transcripts as ``mRNA`` and the rest as ``transcript``."""
    return "mRNA" if transcript.cds else "transcript"


def _exon_rank_map(transcript: Transcript) -> Dict[Tuple[int, int], int]:
    reverse = transcript.strand == "-"
    ordered = sorted(transcript.exons, key=lambda b: b.start, reverse=reverse)
    return {(b.start, b.end): index for index, b in enumerate(ordered, start=1)}


def _rows_for_gene(gene: Gene) -> List[_Row]:
    rows: List[_Row] = []

    gene_attrs: List[Tuple[str, str]] = [
        ("ID", "gene:{0}".format(gene.gene_id)),
        ("Name", gene.name or gene.gene_id),
        ("biotype", gene.biotype),
        ("description", gene.description),
    ]
    if gene.source_id and gene.source_id != gene.gene_id:
        gene_attrs.append(("source_id", gene.source_id))
        gene_attrs.append(("Alias", gene.source_id))
    if gene.inferred:
        gene_attrs.append(("inferred", ",".join(gene.inferred)))

    rows.append(_Row(
        seqid=gene.seqid,
        ftype="gene",
        start=gene.start,
        end=gene.end,
        strand=gene.strand,
        phase=".",
        attributes=_format_attributes(gene_attrs),
    ))

    for transcript in gene.transcripts:
        tx_type = _transcript_feature_type(transcript)
        tx_attrs: List[Tuple[str, str]] = [
            ("ID", "transcript:{0}".format(transcript.transcript_id)),
            ("Parent", "gene:{0}".format(gene.gene_id)),
            ("Name", transcript.transcript_id),
            ("biotype", transcript.biotype),
        ]
        tags = list(transcript.tags)
        if transcript.is_canonical and "Ensembl_canonical" not in tags:
            tags.insert(0, "Ensembl_canonical")
        if tags:
            tx_attrs.append(("tag", ",".join(tags)))
        if transcript.source_id and transcript.source_id != transcript.transcript_id:
            tx_attrs.append(("source_id", transcript.source_id))
            tx_attrs.append(("Alias", transcript.source_id))
        if transcript.biotype_rule:
            tx_attrs.append(("biotype_source", transcript.biotype_rule))
        if transcript.inferred:
            tx_attrs.append(("inferred", ",".join(transcript.inferred)))

        rows.append(_Row(
            seqid=transcript.seqid,
            ftype=tx_type,
            start=transcript.start,
            end=transcript.end,
            strand=transcript.strand,
            phase=".",
            attributes=_format_attributes(tx_attrs),
        ))

        ranks = _exon_rank_map(transcript)
        for block in sorted(transcript.exons, key=lambda b: b.start):
            exon_attrs: List[Tuple[str, str]] = [
                ("Parent", "transcript:{0}".format(transcript.transcript_id)),
                ("rank", str(ranks.get((block.start, block.end), 1))),
            ]
            if block.feature_id:
                exon_attrs.append(("Name", block.feature_id))
                exon_attrs.append(("exon_id", block.feature_id))
            rows.append(_Row(
                seqid=transcript.seqid,
                ftype="exon",
                start=block.start,
                end=block.end,
                strand=transcript.strand,
                phase=".",
                attributes=_format_attributes(exon_attrs),
            ))

        protein_id = str(transcript.attributes.get("protein_id") or "")
        for block in sorted(transcript.cds, key=lambda b: b.start):
            cds_attrs: List[Tuple[str, str]] = [
                ("Parent", "transcript:{0}".format(transcript.transcript_id)),
            ]
            if protein_id:
                cds_attrs.insert(0, ("ID", "CDS:{0}".format(protein_id)))
                cds_attrs.append(("protein_id", protein_id))
            rows.append(_Row(
                seqid=transcript.seqid,
                ftype="CDS",
                start=block.start,
                end=block.end,
                strand=transcript.strand,
                phase=str(block.phase) if block.phase in (0, 1, 2) else "0",
                attributes=_format_attributes(cds_attrs),
            ))

        for ftype, blocks in (
            ("five_prime_UTR", transcript.utr5),
            ("three_prime_UTR", transcript.utr3),
        ):
            for block in sorted(blocks, key=lambda b: b.start):
                rows.append(_Row(
                    seqid=transcript.seqid,
                    ftype=ftype,
                    start=block.start,
                    end=block.end,
                    strand=transcript.strand,
                    phase=".",
                    attributes=_format_attributes([
                        ("Parent", "transcript:{0}".format(transcript.transcript_id)),
                    ]),
                ))

    return rows


def write_canonical_gff3(
    genes: Sequence[Gene],
    output_path: str,
    sequence_lengths: Optional[Dict[str, int]] = None,
    source_name: str = "",
    dialect: str = "",
    progress_callback: Optional[Callable[[int, int], None]] = None,
) -> str:
    """Write ``genes`` as canonical GFF3 to ``output_path``; return the path."""
    rows: List[_Row] = []
    for gene in genes:
        rows.extend(_rows_for_gene(gene))
    rows.sort(key=lambda r: r.sort_key)

    seqids: List[str] = []
    seen = set()
    for row in rows:
        if row.seqid not in seen:
            seen.add(row.seqid)
            seqids.append(row.seqid)

    stamp = datetime.utcnow().replace(microsecond=0).isoformat() + "Z"
    with open(output_path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write("##gff-version 3\n")
        for seqid in sorted(seqids):
            length = (sequence_lengths or {}).get(seqid)
            if length:
                handle.write("##sequence-region {0} 1 {1}\n".format(seqid, length))
        handle.write(
            "#!ensembl-go-converted {0}{1}{2}\n".format(
                stamp,
                " from {0}".format(source_name) if source_name else "",
                " ({0})".format(dialect) if dialect else "",
            )
        )
        for index, row in enumerate(rows):
            handle.write(row.render())
            handle.write("\n")
            if progress_callback and ((index + 1) % 1000 == 0 or index + 1 == len(rows)):
                progress_callback(index + 1, len(rows))

    return output_path


def compress_and_index(gff_path: str) -> Tuple[str, str]:
    """bgzip the file and build a tabix index.

    Best effort: a failure leaves the plain GFF3 in place, which the indexer and
    browser read perfectly well. Returns ``(path, index_path)`` where the index
    path is empty when no tabix index could be produced.
    """
    try:
        import pysam  # imported lazily so the module stays importable without it
    except ImportError:
        return gff_path, ""

    compressed = gff_path + ".gz"
    try:
        pysam.tabix_compress(gff_path, compressed, force=True)
    except Exception:
        return gff_path, ""

    try:
        pysam.tabix_index(compressed, preset="gff", force=True)
        index_path = compressed + ".tbi"
        if not os.path.exists(index_path):
            index_path = ""
    except Exception:
        index_path = ""

    try:
        os.remove(gff_path)
    except OSError:
        pass

    return compressed, index_path
