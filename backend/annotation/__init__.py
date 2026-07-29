"""Dialect-tolerant annotation ingest for user-supplied genomes.

This package is additive: nothing here is wired into ``main.create_gff_index``.
The existing Ensembl/RefSeq indexing path is untouched and remains the only
parser used for browsing until the normaliser has been validated against the
fixture corpus in ``backend/tests/fixtures/annotation``.

Public surface used by the API layer:

    sniff_annotation(path)      -> DialectInfo
    scan_fasta(path)            -> FastaReport
    build_annotation_report(..) -> AnnotationReport
"""

from .dialect import (  # noqa: F401
    BARE_ATTRIBUTE_KEY,
    DialectInfo,
    GFF2,
    GFF3,
    GTF,
    UNKNOWN,
    attr_first,
    attr_get,
    attr_list,
    iter_data_lines,
    parse_attributes,
    sniff_annotation,
)
from .convert import (  # noqa: F401
    CONVERTED_SUFFIX,
    ConversionResult,
    conversion_required,
    convert_annotation,
    converted_basename,
    prepare_annotation,
)
from .fasta_report import FastaReport, SequenceStat, read_sequence_lengths, scan_fasta  # noqa: F401
from .identifiers import (  # noqa: F401
    MODE_GENERATE,
    MODE_KEEP,
    IdentifierAudit,
    IdentifierError,
    audit_identifiers,
    normalize_prefix,
)
from .report import AnnotationReport, Issue, build_annotation_report  # noqa: F401

__all__ = [
    "CONVERTED_SUFFIX",
    "ConversionResult",
    "IdentifierAudit",
    "IdentifierError",
    "MODE_GENERATE",
    "MODE_KEEP",
    "audit_identifiers",
    "conversion_required",
    "convert_annotation",
    "converted_basename",
    "normalize_prefix",
    "prepare_annotation",
    "read_sequence_lengths",
    "BARE_ATTRIBUTE_KEY",
    "DialectInfo",
    "GFF2",
    "GFF3",
    "GTF",
    "UNKNOWN",
    "AnnotationReport",
    "FastaReport",
    "Issue",
    "SequenceStat",
    "attr_first",
    "attr_get",
    "attr_list",
    "build_annotation_report",
    "iter_data_lines",
    "parse_attributes",
    "scan_fasta",
    "sniff_annotation",
]
