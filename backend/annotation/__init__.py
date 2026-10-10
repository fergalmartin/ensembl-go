"""Validate and convert user-supplied FASTA and annotation files.

The import routes use sniff_annotation, scan_fasta and build_annotation_report
to validate inputs. Conversion normalises supported dialects into canonical
GFF3 for the existing browse indexer in gff_index.
"""

from .cooperative import CooperativeYielder, yielding_enabled  # noqa: F401
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
    "CooperativeYielder",
    "yielding_enabled",
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
