"""Build the user-facing annotation validation report.

The report answers three questions, in this order:

1. what is in this file (counts, biotypes, sequence regions);
2. what will not survive conversion (issues, by severity);
3. what conversion will have to guess (the inference preview).

Nothing here mutates the annotation; it only describes a :class:`NormalizeResult`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Sequence

from . import biotype as biotype_rules
from .fasta_report import read_sequence_lengths
from .issues import ERROR, INFO, WARNING, Issue
from .normalize import NormalizeResult, normalize_annotation

#: Issue codes that mean identifiers cannot be trusted as-is.
_ID_BLOCKING_CODES = ("duplicate_id_across_regions", "duplicate_id", "self_parent")


@dataclass
class Distribution:
    """Summary of a per-feature count, e.g. exons per transcript."""

    total: int = 0
    mean: float = 0.0
    median: int = 0
    minimum: int = 0
    maximum: int = 0

    def as_dict(self) -> Dict[str, object]:
        return {
            "total": self.total,
            "mean": round(self.mean, 3),
            "median": self.median,
            "min": self.minimum,
            "max": self.maximum,
        }


def _distribution(values: Sequence[int]) -> Distribution:
    if not values:
        return Distribution()
    ordered = sorted(values)
    mid = len(ordered) // 2
    median = ordered[mid] if len(ordered) % 2 else (ordered[mid - 1] + ordered[mid]) // 2
    return Distribution(
        total=sum(ordered),
        mean=sum(ordered) / float(len(ordered)),
        median=median,
        minimum=ordered[0],
        maximum=ordered[-1],
    )


@dataclass
class AnnotationReport:
    path: str = ""

    # -- detected -----------------------------------------------------------
    dialect: str = "unknown"
    compression: str = "none"
    gff_version: str = ""
    producers: List[str] = field(default_factory=list)
    producer_guess: str = ""
    lines_read: int = 0
    lines_malformed: int = 0

    # -- counts -------------------------------------------------------------
    gene_count: int = 0
    transcript_count: int = 0
    exon_count: int = 0
    cds_count: int = 0
    utr_count: int = 0
    monoexonic_transcript_count: int = 0
    coding_transcript_count: int = 0
    total_exonic_bases: int = 0
    total_cds_bases: int = 0
    transcripts_per_gene: Distribution = field(default_factory=Distribution)
    exons_per_transcript: Distribution = field(default_factory=Distribution)
    feature_type_counts: Dict[str, int] = field(default_factory=dict)

    # -- classification -----------------------------------------------------
    gene_biotype_counts: Dict[str, int] = field(default_factory=dict)
    transcript_biotype_counts: Dict[str, int] = field(default_factory=dict)
    source_gene_biotype_counts: Dict[str, int] = field(default_factory=dict)
    source_transcript_biotype_counts: Dict[str, int] = field(default_factory=dict)
    gene_major_class_counts: Dict[str, int] = field(default_factory=dict)
    transcript_major_class_counts: Dict[str, int] = field(default_factory=dict)

    # -- sequence regions ---------------------------------------------------
    seqid_count: int = 0
    seqids: List[str] = field(default_factory=list)
    seqids_missing_from_fasta: List[str] = field(default_factory=list)
    fasta_seqids_without_annotation: int = 0
    naming_style_suggestion: str = ""
    fasta_checked: bool = False

    # -- identifiers --------------------------------------------------------
    duplicate_id_count: int = 0
    duplicate_id_across_regions_count: int = 0
    orphan_parent_count: int = 0
    id_generation_recommended: bool = False

    # -- conversion preview -------------------------------------------------
    inference_counts: Dict[str, int] = field(default_factory=dict)
    biotype_rule_counts: Dict[str, int] = field(default_factory=dict)

    issues: List[Issue] = field(default_factory=list)

    @property
    def error_count(self) -> int:
        return sum(1 for issue in self.issues if issue.severity == ERROR)

    @property
    def warning_count(self) -> int:
        return sum(1 for issue in self.issues if issue.severity == WARNING)

    def as_dict(self) -> Dict[str, object]:
        return {
            "path": self.path,
            "detected": {
                "dialect": self.dialect,
                "compression": self.compression,
                "gff_version": self.gff_version,
                "producers": list(self.producers),
                "producer_guess": self.producer_guess,
                "lines_read": self.lines_read,
                "lines_malformed": self.lines_malformed,
            },
            "counts": {
                "genes": self.gene_count,
                "transcripts": self.transcript_count,
                "exons": self.exon_count,
                "cds": self.cds_count,
                "utrs": self.utr_count,
                "coding_transcripts": self.coding_transcript_count,
                "monoexonic_transcripts": self.monoexonic_transcript_count,
                "total_exonic_bases": self.total_exonic_bases,
                "total_cds_bases": self.total_cds_bases,
                "transcripts_per_gene": self.transcripts_per_gene.as_dict(),
                "exons_per_transcript": self.exons_per_transcript.as_dict(),
                "feature_types": dict(self.feature_type_counts),
            },
            "classification": {
                "gene_biotypes": dict(self.gene_biotype_counts),
                "transcript_biotypes": dict(self.transcript_biotype_counts),
                "source_gene_biotypes": dict(self.source_gene_biotype_counts),
                "source_transcript_biotypes": dict(self.source_transcript_biotype_counts),
                "gene_major_classes": dict(self.gene_major_class_counts),
                "transcript_major_classes": dict(self.transcript_major_class_counts),
            },
            "sequence_regions": {
                "count": self.seqid_count,
                "names": list(self.seqids[:200]),
                "missing_from_fasta": list(self.seqids_missing_from_fasta[:50]),
                "fasta_regions_without_annotation": self.fasta_seqids_without_annotation,
                "naming_style_suggestion": self.naming_style_suggestion,
                "fasta_checked": self.fasta_checked,
            },
            "identifiers": {
                "duplicate_ids": self.duplicate_id_count,
                "duplicate_ids_across_regions": self.duplicate_id_across_regions_count,
                "orphan_parents": self.orphan_parent_count,
                "generation_recommended": self.id_generation_recommended,
            },
            "conversion_preview": {
                "inference": dict(self.inference_counts),
                "biotype_rules": dict(self.biotype_rule_counts),
            },
            "issues": [issue.as_dict() for issue in self.issues],
            "error_count": self.error_count,
            "warning_count": self.warning_count,
        }


def _naming_suggestion(missing: Sequence[str], fasta_names: Sequence[str]) -> str:
    """Detect a systematic ``chr``-prefix or accession mismatch.

    This is the most common reason a custom FASTA/GFF pair renders nothing, so it
    is worth naming the fix precisely rather than just listing missing regions.
    """
    if not missing or not fasta_names:
        return ""
    fasta_set = set(fasta_names)

    stripped = sum(1 for name in missing if name[3:] in fasta_set and name.lower().startswith("chr"))
    if stripped and stripped >= len(missing) * 0.5:
        return (
            "Annotation names carry a 'chr' prefix the FASTA does not "
            "(for example '{0}' vs '{1}'). Conversion can strip it.".format(
                missing[0], missing[0][3:]
            )
        )

    prefixed = sum(1 for name in missing if "chr" + name in fasta_set)
    if prefixed and prefixed >= len(missing) * 0.5:
        return (
            "The FASTA names carry a 'chr' prefix the annotation does not "
            "(for example '{0}' vs 'chr{0}'). Conversion can add it.".format(missing[0])
        )

    versionless = {name.rsplit(".", 1)[0]: name for name in fasta_set if "." in name}
    matched = sum(1 for name in missing if name in versionless or name.rsplit(".", 1)[0] in versionless)
    if matched and matched >= len(missing) * 0.5:
        return (
            "Sequence names differ only by accession version "
            "(for example '{0}'). Check that both files came from the same "
            "assembly release.".format(missing[0])
        )

    return ""


def build_annotation_report(
    path: str,
    fasta_path: Optional[str] = None,
    example_limit: int = 20,
    normalized: Optional[NormalizeResult] = None,
    sequence_lengths: Optional[Dict[str, int]] = None,
    progress_callback: Optional[
        Callable[[str, float, str, Dict[str, int]], None]
    ] = None,
) -> AnnotationReport:
    """Validate an annotation file, optionally cross-checking it against a FASTA.

    ``normalized`` and ``sequence_lengths`` let a caller that has already done
    the work — the conversion pipeline — reuse it instead of re-reading both
    files.
    """
    if sequence_lengths is None and fasta_path:
        if progress_callback:
            progress_callback(
                "reading_fasta",
                1.0,
                "Reading FASTA metadata",
                {},
            )

        def _fasta_progress(read_bytes: int, total_bytes: int, sequences: int) -> None:
            if not progress_callback:
                return
            ratio = min(1.0, read_bytes / float(total_bytes)) if total_bytes else 0.0
            progress_callback(
                "reading_fasta",
                1.0 + ratio * 11.0,
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

    if normalized is None:
        if progress_callback:
            progress_callback(
                "detecting_annotation",
                13.0,
                "Detecting annotation format",
                {},
            )
        result = normalize_annotation(
            path,
            sequence_lengths=sequence_lengths,
            example_limit=example_limit,
            progress_callback=progress_callback,
        )
    else:
        result = normalized

    report = AnnotationReport(path=path)
    info = result.dialect_info
    if info is not None:
        report.dialect = info.dialect
        report.compression = info.compression
        report.gff_version = info.gff_version
        report.producers = list(info.producers[:10])
        report.producer_guess = info.producer_guess
    report.lines_read = result.lines_read
    report.lines_malformed = result.lines_malformed
    report.feature_type_counts = dict(
        sorted(result.feature_type_counts.items(), key=lambda kv: (-kv[1], kv[0]))
    )

    transcripts_per_gene: List[int] = []
    exons_per_transcript: List[int] = []
    if progress_callback:
        progress_callback(
            "summarising_annotation",
            80.0,
            "Summarising annotation",
            {
                "features": result.lines_read,
                "genes": 0,
                "transcripts": 0,
            },
        )

    gene_total = len(result.genes)
    for gene_index, gene in enumerate(result.genes):
        report.gene_count += 1
        transcripts_per_gene.append(len(gene.transcripts))

        gene_biotype = gene.biotype or "unknown"
        report.gene_biotype_counts[gene_biotype] = report.gene_biotype_counts.get(gene_biotype, 0) + 1
        source_gene = gene.source_biotype or "(none)"
        report.source_gene_biotype_counts[source_gene] = (
            report.source_gene_biotype_counts.get(source_gene, 0) + 1
        )
        gene_class = biotype_rules.major_class(gene.biotype)
        report.gene_major_class_counts[gene_class] = (
            report.gene_major_class_counts.get(gene_class, 0) + 1
        )

        for transcript in gene.transcripts:
            report.transcript_count += 1
            exon_n = len(transcript.exons)
            exons_per_transcript.append(exon_n)
            report.exon_count += exon_n
            report.cds_count += len(transcript.cds)
            report.utr_count += len(transcript.utr5) + len(transcript.utr3)
            report.total_exonic_bases += transcript.mature_length
            report.total_cds_bases += transcript.cds_length
            if exon_n == 1:
                report.monoexonic_transcript_count += 1
            if transcript.cds:
                report.coding_transcript_count += 1

            tx_biotype = transcript.biotype or "unknown"
            report.transcript_biotype_counts[tx_biotype] = (
                report.transcript_biotype_counts.get(tx_biotype, 0) + 1
            )
            source_tx = transcript.source_biotype or "(none)"
            report.source_transcript_biotype_counts[source_tx] = (
                report.source_transcript_biotype_counts.get(source_tx, 0) + 1
            )
            tx_class = biotype_rules.major_class(transcript.biotype)
            report.transcript_major_class_counts[tx_class] = (
                report.transcript_major_class_counts.get(tx_class, 0) + 1
            )
        if progress_callback and (
            (gene_index + 1) % 250 == 0 or gene_index + 1 == gene_total
        ):
            ratio = (gene_index + 1) / float(max(1, gene_total))
            progress_callback(
                "summarising_annotation",
                80.0 + ratio * 16.0,
                "Summarising annotation",
                {
                    "features": result.lines_read,
                    "genes": report.gene_count,
                    "transcripts": report.transcript_count,
                },
            )

    if progress_callback and not result.genes:
        progress_callback(
            "summarising_annotation",
            96.0,
            "Summarising annotation",
            {
                "features": result.lines_read,
                "genes": 0,
                "transcripts": 0,
            },
        )

    report.transcripts_per_gene = _distribution(transcripts_per_gene)
    report.exons_per_transcript = _distribution(exons_per_transcript)

    report.seqids = list(result.seqids)
    report.seqid_count = len(result.seqids)

    if sequence_lengths:
        report.fasta_checked = True
        fasta_names = list(sequence_lengths.keys())
        fasta_set = set(fasta_names)
        missing = [name for name in result.seqids if name not in fasta_set]
        report.seqids_missing_from_fasta = missing
        report.fasta_seqids_without_annotation = len(fasta_set - set(result.seqids))
        if missing:
            result.issues.add(
                "seqid_missing_from_fasta",
                ERROR,
                "Annotation refers to sequence regions that are not in the FASTA; "
                "features on them cannot be displayed.",
                example=missing[0],
                increment=len(missing),
            )
            report.naming_style_suggestion = _naming_suggestion(missing, fasta_names)

    report.inference_counts = dict(
        sorted(result.inference_counts.items(), key=lambda kv: (-kv[1], kv[0]))
    )
    report.biotype_rule_counts = dict(
        sorted(result.biotype_rule_counts.items(), key=lambda kv: (-kv[1], kv[0]))
    )

    report.duplicate_id_count = result.issues.count_for("duplicate_id")
    report.duplicate_id_across_regions_count = result.issues.count_for(
        "duplicate_id_across_regions"
    )
    report.orphan_parent_count = result.issues.count_for("orphan_parent")
    report.id_generation_recommended = any(
        result.issues.count_for(code) for code in _ID_BLOCKING_CODES
    )

    if report.gene_count and not report.coding_transcript_count:
        result.issues.add(
            "no_coding_transcripts",
            INFO,
            "No transcript in this file has a CDS; every gene was classified as "
            "non-coding by transcript length.",
        )

    report.issues = result.issues.to_list()
    if progress_callback:
        progress_callback(
            "finalising_report",
            98.0,
            "Finalising analysis report",
            {
                "features": result.lines_read,
                "genes": report.gene_count,
                "transcripts": report.transcript_count,
            },
        )
    return report
