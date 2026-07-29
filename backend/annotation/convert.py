"""Turn any supported annotation file into canonical Ensembl-style GFF3.

This is the integration point for the whole package: normalise, optionally mint
identifiers, then write a file in the one dialect the rest of the application
already handles well. The original is never modified — the converted file is
written alongside it and registered as the dataset release, with the source kept
in the manifest.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Callable, Dict, Optional, Tuple

from .dialect import GFF3, sniff_annotation
from .emit import compress_and_index, write_canonical_gff3
from .fasta_report import read_sequence_lengths
from .identifiers import (
    MODE_GENERATE,
    MODE_KEEP,
    IdentifierAudit,
    assign_source_exon_ids,
    audit_identifiers,
    mint_identifiers,
    normalize_prefix,
    resolve_mode,
    write_id_map,
)
from .normalize import NormalizeResult, normalize_annotation
from .report import AnnotationReport, build_annotation_report

#: Suffix identifying files this package produced.
CONVERTED_SUFFIX = ".ensembl.gff3"

#: Repairs the existing ``create_gff_index`` cannot reproduce, so a file needing
#: any of them must be converted before it can be browsed correctly.
#:
#: Two repairs are deliberately absent because the indexer already handles them:
#: ``transcript_synthesised`` (it creates a transcript for a childless gene) and
#: ``exon_from_transcript_span`` (its own fallback does the same thing).
#: ``exons_from_cds`` is conditional and handled in :func:`conversion_required`.
STRUCTURAL_REPAIR_TAGS = frozenset({
    # Without a gene row the indexer records no gene at all.
    "gene_synthesised",
    # Orphan CDS/exon rows are dropped outright by the indexer.
    "transcript_synthesised_from_children",
    # GTF stop-codon handling has no equivalent in the indexer.
    "cds_extended_stop_codon",
})

_STRIP_EXTENSIONS = re.compile(
    r"\.(gff3|gff|gtf|gff2)(\.(gz|bgz))?$", re.IGNORECASE
)


@dataclass
class ConversionResult:
    source_path: str = ""
    output_path: str = ""
    tabix_index_path: str = ""
    id_map_path: str = ""
    id_mode: str = MODE_KEEP
    id_prefix: str = ""
    gene_count: int = 0
    transcript_count: int = 0
    exon_count: int = 0
    coding_transcript_count: int = 0
    report: Optional[AnnotationReport] = None
    audit: Optional[IdentifierAudit] = None

    def as_dict(self) -> Dict[str, object]:
        return {
            "source_path": self.source_path,
            "output_path": self.output_path,
            "tabix_index_path": self.tabix_index_path,
            "id_map_path": self.id_map_path,
            "id_mode": self.id_mode,
            "id_prefix": self.id_prefix,
            "gene_count": self.gene_count,
            "transcript_count": self.transcript_count,
            "exon_count": self.exon_count,
            "coding_transcript_count": self.coding_transcript_count,
            "identifiers": self.audit.as_dict() if self.audit else {},
            "report": self.report.as_dict() if self.report else {},
        }


def converted_basename(source_path: str) -> str:
    """``genes.gtf.gz`` -> ``genes.ensembl.gff3``."""
    name = os.path.basename(str(source_path or "") or "annotation")
    stem = _STRIP_EXTENSIONS.sub("", name) or "annotation"
    return stem + CONVERTED_SUFFIX


def conversion_required(
    normalized: NormalizeResult,
    id_mode: str = MODE_KEEP,
) -> Tuple[bool, str]:
    """Decide whether a file must be converted before it can be browsed.

    Returns ``(required, reason)``. A clean GFF3 that the existing indexer
    already handles is passed through untouched, so importing an Ensembl or
    RefSeq file keeps working exactly as it does today.
    """
    dialect = (normalized.dialect_info.dialect if normalized.dialect_info else "") or ""
    if dialect and dialect != GFF3:
        return True, "the file is {0}, which cannot be indexed directly".format(
            dialect.upper()
        )

    if str(id_mode or MODE_KEEP).strip().lower() == MODE_GENERATE:
        return True, "new identifiers were requested"

    repairs = sorted(STRUCTURAL_REPAIR_TAGS & set(normalized.inference_counts))
    if repairs:
        return True, "the gene model has to be rebuilt ({0})".format(", ".join(repairs))

    # Exons derived from CDS only matter when the transcript has introns. The
    # indexer's fallback is a single exon spanning the whole transcript, which is
    # identical for a single-block CDS but draws straight over the introns of a
    # multi-block one — the case that has to be converted.
    for gene in normalized.genes:
        for transcript in gene.transcripts:
            if "exons_from_cds" in transcript.inferred and len(transcript.exons) > 1:
                return True, "the gene model has to be rebuilt (exons_from_cds)"

    return False, ""


def prepare_annotation(
    annotation_path: str,
    fasta_path: Optional[str] = None,
    output_dir: Optional[str] = None,
    id_mode: str = MODE_KEEP,
    id_prefix: str = "",
    compress: bool = True,
    progress_callback: Optional[
        Callable[[str, float, str, Dict[str, int]], None]
    ] = None,
) -> Dict[str, object]:
    """Return the annotation path that should actually be indexed.

    Converts first when the file needs it, and passes a clean GFF3 through
    untouched. This is what the manual "add a genome" flow calls, so a user who
    points at a GTF gets a browsable genome rather than an empty gene track.

    Converted output is written beside the source file, so a custom genome stays
    self-contained in the directory the user chose.
    """
    sequence_lengths: Optional[Dict[str, int]] = None
    if progress_callback:
        progress_callback("reading_fasta", 2.0, "Reading FASTA metadata", {})
    if fasta_path:
        def _fasta_progress(read_bytes: int, total_bytes: int, sequences: int) -> None:
            if not progress_callback:
                return
            ratio = min(1.0, read_bytes / float(total_bytes)) if total_bytes else 0.0
            progress_callback(
                "reading_fasta",
                2.0 + ratio * 10.0,
                "Reading FASTA metadata",
                {"sequences": sequences},
            )

        try:
            sequence_lengths = read_sequence_lengths(
                fasta_path,
                progress_callback=_fasta_progress,
            )
        except OSError:
            sequence_lengths = None
    if progress_callback:
        progress_callback(
            "reading_fasta",
            12.0,
            "FASTA metadata ready",
            {"sequences": len(sequence_lengths or {})},
        )

    info = sniff_annotation(annotation_path)
    normalized = normalize_annotation(
        annotation_path,
        dialect_info=info,
        sequence_lengths=sequence_lengths,
        progress_callback=progress_callback,
    )
    required, reason = conversion_required(normalized, id_mode)

    if not required:
        if progress_callback:
            progress_callback(
                "registering",
                98.0,
                "Registering genome",
                {
                    "genes": len(normalized.genes),
                    "transcripts": sum(len(g.transcripts) for g in normalized.genes),
                },
            )
        return {
            "annotation_path": annotation_path,
            "converted": False,
            "reason": "",
            "gene_count": len(normalized.genes),
            "transcript_count": sum(len(g.transcripts) for g in normalized.genes),
            "dialect": info.dialect,
            "producer": info.producer_guess,
            "id_map_path": "",
        }

    target_dir = output_dir or os.path.dirname(os.path.abspath(annotation_path))
    if not os.access(target_dir, os.W_OK):
        raise ValueError(
            "Cannot write the converted annotation to {0}. Choose a writable "
            "location or copy the annotation somewhere writable.".format(target_dir)
        )

    result = convert_annotation(
        annotation_path,
        target_dir,
        fasta_path=fasta_path,
        id_mode=id_mode,
        id_prefix=id_prefix,
        compress=compress,
        normalized=normalized,
        sequence_lengths=sequence_lengths,
        progress_callback=progress_callback,
    )
    return {
        "annotation_path": result.output_path,
        "converted": True,
        "reason": reason,
        "gene_count": result.gene_count,
        "transcript_count": result.transcript_count,
        "exon_count": result.exon_count,
        "coding_transcript_count": result.coding_transcript_count,
        "dialect": info.dialect,
        "producer": info.producer_guess,
        "id_mode": result.id_mode,
        "id_prefix": result.id_prefix,
        "id_map_path": result.id_map_path,
        "source_path": annotation_path,
    }


def convert_annotation(
    annotation_path: str,
    output_dir: str,
    fasta_path: Optional[str] = None,
    id_mode: str = MODE_KEEP,
    id_prefix: str = "",
    compress: bool = True,
    example_limit: int = 20,
    normalized: Optional[NormalizeResult] = None,
    sequence_lengths: Optional[Dict[str, int]] = None,
    progress_callback: Optional[
        Callable[[str, float, str, Dict[str, int]], None]
    ] = None,
) -> ConversionResult:
    """Convert ``annotation_path`` into canonical GFF3 inside ``output_dir``.

    Raises :class:`IdentifierError` when ``id_mode`` cannot be honoured — most
    often ``keep`` on a file whose identifiers are not unique, which would
    produce invalid GFF3 and silently lose rows at index time.
    """
    if sequence_lengths is None and fasta_path:
        def _fasta_progress(read_bytes: int, total_bytes: int, sequences: int) -> None:
            if not progress_callback:
                return
            ratio = min(1.0, read_bytes / float(total_bytes)) if total_bytes else 0.0
            progress_callback(
                "reading_fasta",
                2.0 + ratio * 10.0,
                "Reading FASTA metadata",
                {"sequences": sequences},
            )

        try:
            sequence_lengths = read_sequence_lengths(
                fasta_path,
                progress_callback=_fasta_progress,
            )
        except OSError:
            sequence_lengths = None

    info = normalized.dialect_info if normalized and normalized.dialect_info else sniff_annotation(annotation_path)
    normalized = normalized or normalize_annotation(
        annotation_path,
        dialect_info=info,
        sequence_lengths=sequence_lengths,
        example_limit=example_limit,
        progress_callback=progress_callback,
    )

    # The report describes the *source* file, so build it before minting
    # rewrites any identifiers.
    report = build_annotation_report(
        annotation_path,
        fasta_path=fasta_path,
        example_limit=example_limit,
        normalized=normalized,
        sequence_lengths=sequence_lengths,
    )

    audit = audit_identifiers(normalized.genes)
    mode = resolve_mode(id_mode, audit, id_prefix)

    if not normalized.genes:
        raise ValueError(
            "No genes could be reconstructed from this annotation; there is "
            "nothing to convert."
        )

    os.makedirs(output_dir, exist_ok=True)
    output_path = os.path.join(output_dir, converted_basename(annotation_path))

    id_map_path = ""
    prefix = ""
    if mode == MODE_GENERATE:
        prefix = normalize_prefix(id_prefix)
        mappings = mint_identifiers(normalized.genes, prefix)
        id_map_path = write_id_map(os.path.join(output_dir, "id_map.tsv"), mappings)
    else:
        assign_source_exon_ids(normalized.genes)

    if progress_callback:
        progress_callback(
            "writing_annotation",
            80.0,
            "Writing normalized annotation",
            {
                "genes": len(normalized.genes),
                "transcripts": report.transcript_count,
            },
        )

    def _write_progress(written: int, total: int) -> None:
        if not progress_callback:
            return
        ratio = written / float(total) if total else 1.0
        progress_callback(
            "writing_annotation",
            82.0 + min(1.0, ratio) * 12.0,
            "Writing normalized annotation",
            {
                "genes": len(normalized.genes),
                "transcripts": report.transcript_count,
                "records_written": written,
            },
        )

    write_canonical_gff3(
        normalized.genes,
        output_path,
        sequence_lengths=sequence_lengths,
        source_name=os.path.basename(annotation_path),
        dialect=info.dialect,
        progress_callback=_write_progress,
    )

    tabix_index_path = ""
    if compress:
        if progress_callback:
            progress_callback(
                "compressing_annotation",
                96.0,
                "Compressing normalized annotation",
                {
                    "genes": len(normalized.genes),
                    "transcripts": report.transcript_count,
                },
            )
        output_path, tabix_index_path = compress_and_index(output_path)

    if progress_callback:
        progress_callback(
            "registering",
            98.0,
            "Registering genome",
            {
                "genes": len(normalized.genes),
                "transcripts": report.transcript_count,
            },
        )

    return ConversionResult(
        source_path=annotation_path,
        output_path=output_path,
        tabix_index_path=tabix_index_path,
        id_map_path=id_map_path,
        id_mode=mode,
        id_prefix=prefix,
        gene_count=len(normalized.genes),
        transcript_count=report.transcript_count,
        exon_count=report.exon_count,
        coding_transcript_count=report.coding_transcript_count,
        report=report,
        audit=audit,
    )
