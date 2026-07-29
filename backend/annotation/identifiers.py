"""Audit and mint stable Ensembl-style identifiers.

Two modes, chosen by the user at import (docs/CUSTOM_GENOMES.md §3.6):

``keep``
    Use the identifiers already in the file. :func:`audit_identifiers` reports
    whether that is safe; duplicates make it unsafe because the converted file
    would be invalid GFF3 and the SQLite index would silently drop rows.

``generate``
    Mint ``{PREFIX}G00000000001`` / ``T`` / ``E`` / ``P`` in genome order. The
    originals are preserved on every feature as ``source_id`` plus ``Alias``, and
    written to a sibling ``id_map.tsv`` so results can be traced back.

Minting is ordered by sequence region then start coordinate, so the same input
always produces the same identifiers — re-importing an unchanged file does not
renumber the genome.
"""

from __future__ import annotations

import csv
import re
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from .model import Gene, Transcript

#: Number of digits after the type letter, matching Ensembl's own format.
ID_DIGITS = 11

MODE_KEEP = "keep"
MODE_GENERATE = "generate"

_PREFIX_RE = re.compile(r"^[A-Z][A-Z0-9]{2,9}$")

#: Issue codes from the normaliser that make source identifiers unusable.
BLOCKING_ID_CODES = ("duplicate_id", "duplicate_id_across_regions")


class IdentifierError(ValueError):
    """Raised when a requested identifier configuration cannot be honoured."""


@dataclass
class IdentifierAudit:
    total_genes: int = 0
    total_transcripts: int = 0
    genes_without_source_id: int = 0
    transcripts_without_source_id: int = 0
    duplicate_gene_ids: List[str] = field(default_factory=list)
    duplicate_transcript_ids: List[str] = field(default_factory=list)
    generation_required: bool = False
    generation_recommended: bool = False

    def as_dict(self) -> Dict[str, object]:
        return {
            "total_genes": self.total_genes,
            "total_transcripts": self.total_transcripts,
            "genes_without_source_id": self.genes_without_source_id,
            "transcripts_without_source_id": self.transcripts_without_source_id,
            "duplicate_gene_ids": list(self.duplicate_gene_ids[:20]),
            "duplicate_transcript_ids": list(self.duplicate_transcript_ids[:20]),
            "generation_required": self.generation_required,
            "generation_recommended": self.generation_recommended,
        }


def normalize_prefix(prefix: str) -> str:
    """Validate and upper-case an identifier prefix.

    Ensembl prefixes are short upper-case alphanumerics (``ENSMUS``); we accept
    3-10 characters starting with a letter so generated ids stay recognisable
    and cannot collide with the ``G``/``T``/``E``/``P`` type letter.
    """
    token = str(prefix or "").strip().upper()
    if not token:
        raise IdentifierError("An identifier prefix is required to generate identifiers.")
    if not _PREFIX_RE.match(token):
        raise IdentifierError(
            "Identifier prefix must be 3-10 characters, start with a letter and "
            "contain only letters and digits (for example 'ENSXYZ')."
        )
    return token


def audit_identifiers(genes: Sequence[Gene]) -> IdentifierAudit:
    """Check whether the source identifiers can be carried into the output."""
    audit = IdentifierAudit(total_genes=len(genes))

    gene_seen: Dict[str, int] = {}
    tx_seen: Dict[str, int] = {}

    for gene in genes:
        if not gene.source_id:
            audit.genes_without_source_id += 1
        gene_seen[gene.gene_id] = gene_seen.get(gene.gene_id, 0) + 1
        for transcript in gene.transcripts:
            audit.total_transcripts += 1
            if not transcript.source_id:
                audit.transcripts_without_source_id += 1
            tx_seen[transcript.transcript_id] = tx_seen.get(transcript.transcript_id, 0) + 1

    audit.duplicate_gene_ids = sorted(k for k, n in gene_seen.items() if n > 1)
    audit.duplicate_transcript_ids = sorted(k for k, n in tx_seen.items() if n > 1)
    audit.generation_required = bool(
        audit.duplicate_gene_ids or audit.duplicate_transcript_ids
    )
    audit.generation_recommended = audit.generation_required or bool(
        audit.genes_without_source_id or audit.transcripts_without_source_id
    )
    return audit


def _format_id(prefix: str, letter: str, number: int) -> str:
    return "{0}{1}{2:0{3}d}".format(prefix, letter, number, ID_DIGITS)


@dataclass
class IdentifierMapping:
    """One row of the generated ``id_map.tsv``."""

    new_id: str
    old_id: str
    feature_type: str
    seq_region: str
    start: int
    end: int

    def as_row(self) -> List[str]:
        return [
            self.new_id,
            self.old_id,
            self.feature_type,
            self.seq_region,
            str(self.start),
            str(self.end),
        ]


def mint_identifiers(genes: List[Gene], prefix: str) -> List[IdentifierMapping]:
    """Rewrite every identifier in ``genes`` in place; return the mapping rows.

    Genes are numbered in genome order. Within a gene, transcripts are numbered
    in start order and exons are deduplicated by coordinate so isoforms sharing
    an exon share its identifier.
    """
    clean_prefix = normalize_prefix(prefix)
    mappings: List[IdentifierMapping] = []

    gene_counter = 0
    tx_counter = 0
    exon_counter = 0
    protein_counter = 0

    ordered_genes = sorted(genes, key=lambda g: (g.seqid, g.start, g.end, g.gene_id))

    for gene in ordered_genes:
        gene_counter += 1
        old_gene_id = gene.source_id or gene.gene_id
        new_gene_id = _format_id(clean_prefix, "G", gene_counter)
        mappings.append(
            IdentifierMapping(
                new_id=new_gene_id,
                old_id=old_gene_id,
                feature_type="gene",
                seq_region=gene.seqid,
                start=gene.start,
                end=gene.end,
            )
        )
        gene.source_id = old_gene_id
        gene.gene_id = new_gene_id

        # Exons are gene-level objects: one identifier per distinct interval.
        exon_ids: Dict[Tuple[int, int], str] = {}

        ordered_transcripts = sorted(
            gene.transcripts, key=lambda t: (t.start, t.end, t.transcript_id)
        )
        for transcript in ordered_transcripts:
            tx_counter += 1
            old_tx_id = transcript.source_id or transcript.transcript_id
            new_tx_id = _format_id(clean_prefix, "T", tx_counter)
            mappings.append(
                IdentifierMapping(
                    new_id=new_tx_id,
                    old_id=old_tx_id,
                    feature_type="transcript",
                    seq_region=transcript.seqid,
                    start=transcript.start,
                    end=transcript.end,
                )
            )
            transcript.source_id = old_tx_id
            transcript.transcript_id = new_tx_id
            transcript.gene_id = new_gene_id

            for block in sorted(transcript.exons, key=lambda b: (b.start, b.end)):
                key = (block.start, block.end)
                existing = exon_ids.get(key)
                if existing is None:
                    exon_counter += 1
                    existing = _format_id(clean_prefix, "E", exon_counter)
                    exon_ids[key] = existing
                    mappings.append(
                        IdentifierMapping(
                            new_id=existing,
                            old_id=block.feature_id or "",
                            feature_type="exon",
                            seq_region=transcript.seqid,
                            start=block.start,
                            end=block.end,
                        )
                    )
                block.feature_id = existing

            if transcript.cds:
                protein_counter += 1
                protein_id = _format_id(clean_prefix, "P", protein_counter)
                old_protein = str(transcript.attributes.get("protein_id") or "")
                transcript.attributes["protein_id"] = protein_id
                mappings.append(
                    IdentifierMapping(
                        new_id=protein_id,
                        old_id=old_protein,
                        feature_type="protein",
                        seq_region=transcript.seqid,
                        start=min(b.start for b in transcript.cds),
                        end=max(b.end for b in transcript.cds),
                    )
                )

        gene.transcripts = ordered_transcripts

    return mappings


def assign_source_exon_ids(genes: Iterable[Gene]) -> None:
    """Give exons stable ids derived from their transcript, for ``keep`` mode.

    Source files rarely name exons, but the canonical output needs an
    ``exon_id`` for the browser and for exports. Numbering is per gene and in
    transcription order, so a shared exon keeps one identity across isoforms.
    """
    for gene in genes:
        exon_ids: Dict[Tuple[int, int], str] = {}
        counter = 0
        for transcript in gene.transcripts:
            reverse = transcript.strand == "-"
            ordered = sorted(transcript.exons, key=lambda b: b.start, reverse=reverse)
            for block in ordered:
                key = (block.start, block.end)
                existing = exon_ids.get(key)
                if existing is None:
                    counter += 1
                    existing = "{0}-E{1}".format(gene.gene_id, counter)
                    exon_ids[key] = existing
                block.feature_id = existing


def write_id_map(path: str, mappings: Sequence[IdentifierMapping]) -> str:
    """Write the ``id_map.tsv`` sidecar and return its path."""
    with open(path, "w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, delimiter="\t", lineterminator="\n")
        writer.writerow(["new_id", "old_id", "feature_type", "seq_region", "start", "end"])
        for mapping in mappings:
            writer.writerow(mapping.as_row())
    return path


def resolve_mode(
    id_mode: Optional[str],
    audit: IdentifierAudit,
    prefix: Optional[str] = None,
) -> str:
    """Validate the requested mode against what the file can actually support."""
    mode = str(id_mode or MODE_KEEP).strip().lower()
    if mode not in (MODE_KEEP, MODE_GENERATE):
        raise IdentifierError(
            "Unknown identifier mode {0!r}; expected 'keep' or 'generate'.".format(id_mode)
        )
    if mode == MODE_GENERATE:
        normalize_prefix(prefix or "")
        return mode
    if audit.generation_required:
        raise IdentifierError(
            "This file has duplicate identifiers, so they cannot be preserved. "
            "Choose generated identifiers and supply a prefix, or fix the source file."
        )
    return mode
