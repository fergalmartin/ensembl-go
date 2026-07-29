"""Reconstruct a gene -> transcript -> exon hierarchy from any annotation flavour.

The rules are documented in docs/CUSTOM_GENOMES.md §3.4. In summary:

* feature roles are decided from the SO term where it is recognised, and from the
  graph shape where it is not, so an unknown column-3 term never silently drops
  a locus the way a fixed allowlist does;
* GFF3 hierarchy comes from ``ID``/``Parent``; GTF hierarchy comes from
  ``gene_id``/``transcript_id``; AUGUSTUS bare tokens are recovered from the
  ``gene_id`` its children carry;
* missing levels are synthesised, missing exons are derived from CDS, missing
  UTRs are computed, and phase is recomputed — each recorded so the caller can
  tell the user exactly what was inferred.

Nothing here touches ``main.create_gff_index``; it is a parallel implementation.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from . import biotype as biotype_rules
from .dialect import (
    BARE_ATTRIBUTE_KEY,
    GTF,
    DialectInfo,
    attr_get,
    attr_list,
    iter_data_lines,
    parse_attributes,
    sniff_annotation,
)
from .issues import ERROR, INFO, WARNING, IssueCollector
from .model import Block, Gene, Transcript, merge_intervals, subtract_interval

# ── feature vocabularies ────────────────────────────────────────────────────

EXON_TYPES = frozenset({"exon", "pseudogenic_exon", "noncoding_exon", "coding_exon"})
CDS_TYPES = frozenset({"CDS", "cds"})
UTR5_TYPES = frozenset({"five_prime_UTR", "5UTR", "five_prime_utr", "5'UTR"})
UTR3_TYPES = frozenset({"three_prime_UTR", "3UTR", "three_prime_utr", "3'UTR"})
UTR_GENERIC_TYPES = frozenset({"UTR", "utr"})
START_CODON_TYPES = frozenset({"start_codon"})
STOP_CODON_TYPES = frozenset({"stop_codon"})

CHILD_TYPES = (
    EXON_TYPES
    | CDS_TYPES
    | UTR5_TYPES
    | UTR3_TYPES
    | UTR_GENERIC_TYPES
    | START_CODON_TYPES
    | STOP_CODON_TYPES
)

#: Rows that carry no gene-model information and are dropped without complaint.
IGNORED_TYPES = frozenset({
    "region", "chromosome", "scaffold", "contig", "supercontig", "biological_region",
    "intron", "Selenocysteine", "selenocysteine", "start_codon_variant",
    "match", "match_part", "cDNA_match", "protein_match", "expressed_sequence_match",
    "D_loop", "origin_of_replication", "sequence_feature", "assembly_gap", "gap",
    "repeat_region", "mobile_genetic_element", "centromere", "telomere",
    "direct_repeat", "inverted_repeat", "tandem_repeat", "microsatellite",
    "STS", "enhancer", "promoter", "silencer", "CAAT_signal", "TATA_box",
    "polyA_site", "polyA_signal_sequence", "transcriptional_cis_regulatory_region",
})

GENE_TYPES = frozenset({
    "gene", "pseudogene", "ncRNA_gene", "rRNA_gene", "snRNA_gene", "snoRNA_gene",
    "miRNA_gene", "misc_RNA_gene", "tRNA_gene", "scRNA_gene", "vault_RNA_gene",
    "transposable_element_gene", "protein_coding_gene", "lncRNA_gene",
})

TRANSCRIPT_TYPES = frozenset({
    "mRNA", "transcript", "lnc_RNA", "lncRNA", "ncRNA", "rRNA", "snRNA", "snoRNA",
    "miRNA", "misc_RNA", "tRNA", "scRNA", "scaRNA", "piRNA", "siRNA",
    "pseudogenic_transcript", "processed_transcript", "unconfirmed_transcript",
    "primary_transcript", "antisense_RNA", "guide_RNA", "vault_RNA", "telomerase_RNA",
    "RNase_P_RNA", "RNase_MRP_RNA", "SRP_RNA", "Y_RNA", "ribozyme", "tmRNA",
    "V_gene_segment", "J_gene_segment", "D_gene_segment", "C_gene_segment",
    "mature_transcript", "transcript_region", "circular_RNA",
})

#: ID prefixes used by Ensembl (``gene:``) and RefSeq (``gene-``) that are
#: stripped when producing the clean identifier, but never when matching
#: ``Parent`` references — those must match the raw ``ID`` byte for byte.
_GENE_PREFIXES = ("gene:", "gene-", "GENE:", "Gene:")
_TX_PREFIXES = ("transcript:", "transcript-", "rna-", "rna:", "mapped_transcript:")

ROLE_GENE = "gene"
ROLE_TRANSCRIPT = "transcript"
ROLE_CHILD = "child"
ROLE_UNKNOWN = "unknown"


def strip_gene_prefix(raw: str) -> str:
    for prefix in _GENE_PREFIXES:
        if raw.startswith(prefix):
            return raw[len(prefix):]
    return raw


def strip_transcript_prefix(raw: str) -> str:
    for prefix in _TX_PREFIXES:
        if raw.startswith(prefix):
            return raw[len(prefix):]
    return raw


# ── intermediate representation ─────────────────────────────────────────────

@dataclass
class _Node:
    """One parsed annotation line, before the hierarchy is resolved."""

    line_no: int
    seqid: str
    source: str
    ftype: str
    start: int
    end: int
    strand: str
    phase: Optional[int]
    attrs: Dict[str, str]
    raw_id: str = ""
    parent_keys: List[str] = field(default_factory=list)
    #: True when the parent link came from GTF ``gene_id``/``transcript_id``
    #: rather than a GFF3 ``Parent``. A GTF file legitimately has no gene rows,
    #: so an unresolved link there is expected rather than a defect.
    parent_from_gtf: bool = False
    role: str = ROLE_UNKNOWN
    #: Populated during linking.
    child_nodes: List["_Node"] = field(default_factory=list)
    #: Internal unique handle, since raw IDs are not guaranteed unique.
    uid: int = 0


@dataclass
class NormalizeResult:
    genes: List[Gene] = field(default_factory=list)
    issues: IssueCollector = field(default_factory=IssueCollector)
    dialect_info: Optional[DialectInfo] = None
    #: Raw column-3 histogram over every data line, including ignored types.
    feature_type_counts: Dict[str, int] = field(default_factory=dict)
    lines_read: int = 0
    lines_malformed: int = 0
    seqids: List[str] = field(default_factory=list)
    #: Counts of each structural repair, keyed by the tags set on Gene/Transcript.
    inference_counts: Dict[str, int] = field(default_factory=dict)
    #: ``{rule: count}`` for how each transcript biotype was decided.
    biotype_rule_counts: Dict[str, int] = field(default_factory=dict)

    @property
    def transcripts(self) -> List[Transcript]:
        return [tx for gene in self.genes for tx in gene.transcripts]


# ── role classification ─────────────────────────────────────────────────────

def classify_role(ftype: str) -> str:
    """Decide a feature's role from its SO term alone, or ``ROLE_UNKNOWN``."""
    if ftype in CHILD_TYPES:
        return ROLE_CHILD
    if ftype in GENE_TYPES:
        return ROLE_GENE
    if ftype in TRANSCRIPT_TYPES:
        return ROLE_TRANSCRIPT
    lowered = ftype.lower()
    if lowered.endswith("_gene"):
        return ROLE_GENE
    if (
        lowered.endswith("rna")
        or lowered.endswith("_transcript")
        or lowered.endswith("_gene_segment")
        or lowered.endswith("_segment")
    ):
        return ROLE_TRANSCRIPT
    return ROLE_UNKNOWN


# ── parsing ─────────────────────────────────────────────────────────────────

def _parse_int(token: str) -> Optional[int]:
    try:
        return int(str(token).strip())
    except (TypeError, ValueError):
        return None


def _parse_phase(token: str) -> Optional[int]:
    value = str(token or "").strip()
    return int(value) if value in {"0", "1", "2"} else None


def _extract_keys(node: _Node) -> Tuple[str, List[str], bool]:
    """Return ``(raw_id, parent_keys, parent_from_gtf)`` for a node.

    GFF3 uses ``ID``/``Parent``. GTF has no explicit graph, so the hierarchy is
    read out of ``gene_id``/``transcript_id``: a transcript row's parent is its
    ``gene_id``, and a child row's parent is its ``transcript_id``.
    """
    attrs = node.attrs

    gff3_id = attr_get(attrs, "ID")
    gff3_parents = attr_list(attrs, "Parent")
    if gff3_id or gff3_parents:
        return gff3_id, gff3_parents, False

    bare = attrs.get(BARE_ATTRIBUTE_KEY, "")
    gene_id = attr_get(attrs, "gene_id")
    transcript_id = attr_get(attrs, "transcript_id")

    if node.role == ROLE_CHILD:
        parent = transcript_id or bare
        return "", ([parent] if parent else []), True
    if node.role == ROLE_TRANSCRIPT:
        own = transcript_id or bare
        return own, ([gene_id] if gene_id else []), True
    if node.role == ROLE_GENE:
        own = gene_id or bare
        return own, [], True

    # Role still unknown: prefer the most specific identifier available so the
    # structural pass below has something to link on.
    own = transcript_id or gene_id or bare
    parents = [gene_id] if (transcript_id and gene_id) else []
    return own, parents, True


def _read_nodes(
    path: str,
    dialect: str,
    issues: IssueCollector,
    sequence_lengths: Optional[Dict[str, int]] = None,
    progress_callback: Optional[Callable[[int, int, int], None]] = None,
) -> Tuple[List[_Node], Dict[str, int], int, int]:
    """Stream the file into ``_Node`` objects, validating coordinates."""
    nodes: List[_Node] = []
    feature_type_counts: Dict[str, int] = {}
    lines_read = 0
    lines_malformed = 0
    uid = 0

    latest_bytes = 0
    latest_total = 0

    def _read_progress(read_bytes: int, total_bytes: int) -> None:
        nonlocal latest_bytes, latest_total
        latest_bytes = read_bytes
        latest_total = total_bytes
        if progress_callback:
            progress_callback(read_bytes, total_bytes, lines_read)

    for line_no, line in iter_data_lines(path, progress_callback=_read_progress):
        fields = line.split("\t")
        if len(fields) < 9:
            lines_malformed += 1
            issues.add(
                "malformed_line",
                WARNING,
                "Line does not have the 9 tab-separated columns a GFF/GTF record requires.",
                example="line {0}: {1}".format(line_no, line[:120]),
            )
            continue

        lines_read += 1
        ftype = fields[2].strip()
        feature_type_counts[ftype] = feature_type_counts.get(ftype, 0) + 1

        if ftype in IGNORED_TYPES:
            continue

        start = _parse_int(fields[3])
        end = _parse_int(fields[4])
        if start is None or end is None:
            issues.add(
                "non_integer_coordinates",
                ERROR,
                "Start or end coordinate is not an integer.",
                example="line {0}: {1}..{2}".format(line_no, fields[3], fields[4]),
            )
            continue
        if start > end:
            issues.add(
                "start_after_end",
                ERROR,
                "Feature start is greater than its end; the record cannot be placed.",
                example="line {0}: {1} {2}..{3}".format(line_no, ftype, start, end),
            )
            continue
        if start < 1:
            issues.add(
                "start_below_one",
                ERROR,
                "Feature starts before position 1; GFF coordinates are 1-based.",
                example="line {0}: {1} {2}..{3}".format(line_no, ftype, start, end),
            )
            continue

        seqid = fields[0].strip()
        if sequence_lengths is not None:
            seq_length = sequence_lengths.get(seqid)
            if seq_length is not None and end > seq_length:
                issues.add(
                    "feature_past_sequence_end",
                    ERROR,
                    "Feature extends past the end of its sequence in the FASTA.",
                    example="line {0}: {1} {2}:{3}..{4} (length {5})".format(
                        line_no, ftype, seqid, start, end, seq_length
                    ),
                )

        strand = fields[6].strip() or "."
        if strand not in {"+", "-", ".", "?"}:
            issues.add(
                "invalid_strand",
                WARNING,
                "Strand column is not one of +, -, . or ?; treated as unstranded.",
                example="line {0}: {1!r}".format(line_no, fields[6]),
            )
            strand = "."

        uid += 1
        node = _Node(
            line_no=line_no,
            seqid=seqid,
            source=fields[1].strip() or ".",
            ftype=ftype,
            start=start,
            end=end,
            strand=strand,
            phase=_parse_phase(fields[7]),
            attrs=parse_attributes(fields[8], dialect),
            uid=uid,
        )
        node.role = classify_role(ftype)
        node.raw_id, node.parent_keys, node.parent_from_gtf = _extract_keys(node)
        nodes.append(node)

    if progress_callback:
        progress_callback(latest_bytes or latest_total, latest_total, lines_read)

    return nodes, feature_type_counts, lines_read, lines_malformed


# ── hierarchy resolution ────────────────────────────────────────────────────

def _index_nodes(nodes: Sequence[_Node]) -> Dict[str, List[_Node]]:
    """Index gene/transcript/unknown nodes by raw ID.

    A list per ID rather than a single node, because duplicate IDs are common in
    concatenated or per-scaffold tool output and collapsing them silently loses
    whole loci.
    """
    index: Dict[str, List[_Node]] = {}
    for node in nodes:
        if node.role == ROLE_CHILD or not node.raw_id:
            continue
        index.setdefault(node.raw_id, []).append(node)
    return index


def _resolve_reference(
    candidates: List[_Node],
    referrer: _Node,
) -> Optional[_Node]:
    """Pick which duplicate-ID node a reference means.

    Preference: same sequence region and overlapping span, then same sequence
    region, then the first declared. This is what stops a ``g1`` on chr2 from
    being attached to the ``g1`` on chr1.
    """
    if not candidates:
        return None
    if len(candidates) == 1:
        return candidates[0]
    same_seq = [n for n in candidates if n.seqid == referrer.seqid]
    if not same_seq:
        return candidates[0]
    overlapping = [
        n for n in same_seq
        if n.start <= referrer.end and referrer.start <= n.end
    ]
    if overlapping:
        return overlapping[0]
    return same_seq[0]


def _link(nodes: Sequence[_Node], issues: IssueCollector) -> Dict[str, List[_Node]]:
    """Attach every node to its parent and flag references that go nowhere."""
    index = _index_nodes(nodes)

    for raw_id, candidates in index.items():
        if len(candidates) > 1:
            seqids = sorted({n.seqid for n in candidates})
            code = (
                "duplicate_id_across_regions" if len(seqids) > 1 else "duplicate_id"
            )
            issues.add(
                code,
                ERROR,
                (
                    "The same ID is declared on more than one sequence region. "
                    "Features were matched to the copy on their own region, but "
                    "these identifiers cannot be kept: generate new ones on import."
                    if len(seqids) > 1
                    else "The same ID is declared more than once. These "
                    "identifiers cannot be kept: generate new ones on import."
                ),
                example="{0} on {1}".format(raw_id, ", ".join(seqids)),
                increment=len(candidates) - 1,
            )

    for node in nodes:
        for parent_key in node.parent_keys:
            if not parent_key:
                continue
            parent = _resolve_reference(index.get(parent_key, []), node)
            if parent is None:
                if not node.parent_from_gtf:
                    # GTF carries no gene rows by design, so an unresolved
                    # gene_id there is the normal case and is handled by gene
                    # synthesis; only a dangling GFF3 Parent is a real defect.
                    issues.add(
                        "orphan_parent",
                        WARNING,
                        "Parent reference does not match any ID in the file; "
                        "the feature was re-attached to a synthesised parent.",
                        example="line {0}: Parent={1}".format(node.line_no, parent_key),
                    )
                continue
            if parent.uid == node.uid:
                issues.add(
                    "self_parent",
                    WARNING,
                    "Feature declares itself as its own parent.",
                    example="line {0}: {1}".format(node.line_no, node.raw_id),
                )
                continue
            parent.child_nodes.append(node)

    return index


def _synthesise_transcripts_for_orphan_children(
    nodes: Sequence[_Node],
    issues: IssueCollector,
) -> List[_Node]:
    """Create the transcript rows a CDS-only file never declared.

    Tiberius, and AUGUSTUS in its most minimal mode, emit nothing but CDS lines
    carrying ``transcript_id``/``gene_id``. There is no transcript row for those
    children to attach to, so without this step every feature is dropped and the
    file yields no genes at all.

    Children are grouped by their parent identifier *and* sequence region, so a
    transcript identifier reused across contigs does not fuse into one feature
    spanning both.
    """
    attached = {child.uid for node in nodes for child in node.child_nodes}
    orphans = [
        node for node in nodes
        if node.role == ROLE_CHILD and node.uid not in attached
    ]
    if not orphans:
        return []

    next_uid = max((node.uid for node in nodes), default=0)
    groups: Dict[Tuple[str, str], List[_Node]] = {}
    for node in orphans:
        parent_key = node.parent_keys[0] if node.parent_keys else ""
        if not parent_key:
            issues.add(
                "child_without_parent",
                WARNING,
                "Exon/CDS feature names neither a Parent nor a transcript_id, so "
                "it cannot be attached to any transcript.",
                example="line {0}: {1}".format(node.line_no, node.ftype),
            )
            continue
        groups.setdefault((parent_key, node.seqid), []).append(node)

    created: List[_Node] = []
    for (parent_key, seqid), children in groups.items():
        next_uid += 1
        first = children[0]
        strand = next(
            (child.strand for child in children if child.strand in {"+", "-"}),
            first.strand,
        )
        transcript = _Node(
            line_no=first.line_no,
            seqid=seqid,
            source=first.source,
            ftype="transcript",
            start=min(child.start for child in children),
            end=max(child.end for child in children),
            strand=strand,
            phase=None,
            # Carry the children's attributes so the gene_id they name is still
            # available when a gene is synthesised for this transcript.
            attrs=dict(first.attrs),
            raw_id=parent_key,
            role=ROLE_TRANSCRIPT,
            uid=next_uid,
        )
        transcript.child_nodes = list(children)
        created.append(transcript)

    if created:
        issues.add(
            "transcript_synthesised_from_children",
            INFO,
            "The file declares no transcript rows; one was created for each group "
            "of exon/CDS features sharing a transcript identifier.",
            increment=len(created),
            example=created[0].raw_id,
        )
    return created


def _resolve_unknown_roles(nodes: Sequence[_Node]) -> None:
    """Decide roles for features whose SO term we do not recognise.

    A feature with exon/CDS children is a transcript; a feature whose children
    are transcripts is a gene; a childless feature hanging off a gene is a
    single-exon transcript. This is what lets a novel column-3 term still load,
    where the previous allowlist would have dropped it.
    """
    by_uid = {node.uid: node for node in nodes}
    parent_of: Dict[int, _Node] = {}
    for node in nodes:
        for child in node.child_nodes:
            parent_of[child.uid] = node

    for node in nodes:
        if node.role != ROLE_UNKNOWN:
            continue
        child_roles = {child.role for child in node.child_nodes}
        if child_roles & {ROLE_CHILD}:
            node.role = ROLE_TRANSCRIPT
            continue
        if child_roles & {ROLE_TRANSCRIPT}:
            node.role = ROLE_GENE
            continue
        parent = parent_of.get(node.uid)
        if parent is not None and parent.role == ROLE_GENE:
            node.role = ROLE_TRANSCRIPT
            continue
        if parent is not None and parent.role == ROLE_TRANSCRIPT:
            node.role = ROLE_CHILD
            continue
        # No parent and no children: a lone locus. Treat as a gene so a
        # transcript is synthesised for it and it stays visible.
        node.role = ROLE_GENE

    # A second sweep: nodes whose children were only resolved in the pass above.
    for node in nodes:
        if node.role != ROLE_UNKNOWN:
            continue
        node.role = ROLE_GENE if node.child_nodes else ROLE_TRANSCRIPT

    del by_uid


# ── transcript assembly ─────────────────────────────────────────────────────

def _blocks_from(nodes: Iterable[_Node], keep_phase: bool = False) -> List[Block]:
    blocks = [
        Block(start=n.start, end=n.end, phase=n.phase if keep_phase else None)
        for n in nodes
    ]
    blocks.sort(key=lambda b: (b.start, b.end))
    return blocks


def _recompute_phase(cds: List[Block], strand: str) -> bool:
    """Recompute CDS phase in translation order. Returns True if anything changed.

    The first block keeps a source-provided phase so 5'-incomplete CDS features
    (common in fragmented assemblies) are not silently declared complete.
    """
    if not cds:
        return False
    ordered = sorted(cds, key=lambda b: b.start, reverse=(strand == "-"))
    changed = False
    offset = ordered[0].phase if ordered[0].phase in (0, 1, 2) else 0
    cumulative = offset
    for index, block in enumerate(ordered):
        expected = 0 if index == 0 and offset == 0 else (3 - (cumulative - offset) % 3) % 3
        if index == 0:
            expected = offset
        if block.phase != expected:
            block.phase = expected
            changed = True
        cumulative += block.length
    return changed


def _split_utrs(
    exon_blocks: List[Tuple[int, int]],
    cds_start: int,
    cds_end: int,
    strand: str,
) -> Tuple[List[Tuple[int, int]], List[Tuple[int, int]]]:
    """Derive ``(utr5, utr3)`` by removing the CDS envelope from the exons."""
    left, right = subtract_interval(exon_blocks, cds_start, cds_end)
    if strand == "-":
        return right, left
    return left, right


def _build_transcript(
    node: _Node,
    gene_id: str,
    dialect: str,
    issues: IssueCollector,
) -> Transcript:
    """Assemble one transcript and apply the structural repair rules."""
    children = node.child_nodes
    exon_nodes = [c for c in children if c.ftype in EXON_TYPES]
    cds_nodes = [c for c in children if c.ftype in CDS_TYPES]
    utr5_nodes = [c for c in children if c.ftype in UTR5_TYPES]
    utr3_nodes = [c for c in children if c.ftype in UTR3_TYPES]
    utr_generic = [c for c in children if c.ftype in UTR_GENERIC_TYPES]
    stop_nodes = [c for c in children if c.ftype in STOP_CODON_TYPES]
    start_nodes = [c for c in children if c.ftype in START_CODON_TYPES]

    strand = node.strand
    if strand not in {"+", "-"}:
        # Fall back to a child's strand before giving up: many tools leave the
        # transcript row unstranded but stamp the strand on every exon.
        for child in children:
            if child.strand in {"+", "-"}:
                strand = child.strand
                break

    transcript = Transcript(
        transcript_id=strip_transcript_prefix(node.raw_id) or node.raw_id,
        gene_id=gene_id,
        seqid=node.seqid,
        start=node.start,
        end=node.end,
        strand=strand,
        source=node.source,
        feature_type=node.ftype,
        source_id=node.raw_id,
        attributes=dict(node.attrs),
    )

    cds = _blocks_from(cds_nodes, keep_phase=True)

    # GTF excludes the stop codon from CDS; Ensembl GFF3 includes it. Fold it in
    # so translated sequence is consistent regardless of the input dialect.
    if cds and stop_nodes and dialect == GTF:
        cds_span = merge_intervals([b.as_tuple() for b in cds])
        added = False
        for stop in stop_nodes:
            covered = any(s <= stop.start and stop.end <= e for s, e in cds_span)
            if not covered:
                cds.append(Block(start=stop.start, end=stop.end))
                added = True
        if added:
            # Re-merge so a stop codon abutting the terminal CDS becomes one
            # block rather than an adjacent pair, which would otherwise look
            # like a spurious single-base intron.
            cds = [
                Block(start=s, end=e)
                for s, e in merge_intervals([b.as_tuple() for b in cds])
            ]
            transcript.note("cds_extended_stop_codon")
        cds.sort(key=lambda b: b.start)

    exons = _blocks_from(exon_nodes)
    if not exons:
        # Rule 3: no exon rows. Derive them from CDS plus any UTR blocks, which
        # is the normal shape of BRAKER / AUGUSTUS / Tiberius output. Falling
        # back to the transcript span here would draw one exon across the introns.
        derived = [b.as_tuple() for b in cds]
        derived += [(n.start, n.end) for n in utr5_nodes + utr3_nodes + utr_generic]
        derived += [(n.start, n.end) for n in start_nodes + stop_nodes]
        merged = merge_intervals(derived)
        if merged:
            exons = [Block(start=s, end=e) for s, e in merged]
            transcript.note("exons_from_cds")
        else:
            exons = [Block(start=node.start, end=node.end)]
            transcript.note("exon_from_transcript_span")

    transcript.exons = exons
    transcript.cds = cds

    # The transcript row may be absent or narrower than its children.
    span_start = min([node.start] + [b.start for b in exons])
    span_end = max([node.end] + [b.end for b in exons])
    if span_start != transcript.start or span_end != transcript.end:
        transcript.start = span_start
        transcript.end = span_end
        transcript.note("span_expanded_to_children")

    if cds and _recompute_phase(transcript.cds, strand):
        transcript.note("phase_recomputed")

    # UTRs: explicit ones win; a generic `UTR` is assigned by position; otherwise
    # they are computed by subtracting the CDS envelope from the exons.
    exon_tuples = [b.as_tuple() for b in transcript.exons]
    if utr5_nodes or utr3_nodes:
        transcript.utr5 = _blocks_from(utr5_nodes)
        transcript.utr3 = _blocks_from(utr3_nodes)
        if utr_generic and cds:
            cds_start = min(b.start for b in cds)
            cds_end = max(b.end for b in cds)
            for child in utr_generic:
                is_left = child.end < cds_start
                target = (
                    transcript.utr5 if (is_left == (strand != "-")) else transcript.utr3
                )
                target.append(Block(start=child.start, end=child.end))
            transcript.note("generic_utr_assigned")
    elif utr_generic and cds:
        cds_start = min(b.start for b in cds)
        cds_end = max(b.end for b in cds)
        for child in utr_generic:
            is_left = child.end < cds_start
            target = transcript.utr5 if (is_left == (strand != "-")) else transcript.utr3
            target.append(Block(start=child.start, end=child.end))
        transcript.note("generic_utr_assigned")
    elif cds:
        cds_start = min(b.start for b in cds)
        cds_end = max(b.end for b in cds)
        utr5, utr3 = _split_utrs(exon_tuples, cds_start, cds_end, strand)
        transcript.utr5 = [Block(start=s, end=e) for s, e in utr5]
        transcript.utr3 = [Block(start=s, end=e) for s, e in utr3]
        if transcript.utr5 or transcript.utr3:
            transcript.note("utrs_computed")

    for block_list in (transcript.utr5, transcript.utr3):
        block_list.sort(key=lambda b: b.start)

    tags = attr_list(node.attrs, "tag")
    transcript.tags = tags
    transcript.is_canonical = any(
        token in tags
        for token in ("Ensembl_canonical", "MANE_Select", "MANE Select",
                      "MANE_Plus_Clinical", "MANE Plus Clinical", "RefSeq Select")
    )

    source_biotype = attr_get(node.attrs, *biotype_rules.BIOTYPE_ATTRIBUTE_KEYS)
    transcript.source_biotype = source_biotype

    if cds and transcript.cds_length % 3 != 0:
        issues.add(
            "cds_not_multiple_of_three",
            WARNING,
            "Coding sequence length is not a multiple of 3; the translation will be truncated.",
            example="{0} ({1} bp)".format(transcript.transcript_id, transcript.cds_length),
        )

    return transcript


def _select_canonical(gene: Gene) -> None:
    """Guarantee exactly one canonical transcript per gene.

    Source tags win. Otherwise: longest CDS, then longest mature length, then
    lowest identifier so the choice is stable across re-imports.
    """
    if not gene.transcripts:
        return
    tagged = [tx for tx in gene.transcripts if tx.is_canonical]
    if len(tagged) == 1:
        chosen = tagged[0]
    else:
        pool = tagged or gene.transcripts
        chosen = sorted(
            pool,
            key=lambda tx: (-tx.cds_length, -tx.mature_length, tx.transcript_id),
        )[0]
    for transcript in gene.transcripts:
        transcript.is_canonical = transcript is chosen


def _synthesise_gene_id(node: _Node, used: Set[str], suffix: str = "gene") -> str:
    base = strip_transcript_prefix(node.raw_id) or "{0}_{1}_{2}".format(
        node.seqid, node.start, node.end
    )
    candidate = "{0}_{1}".format(base, suffix) if base in used else base
    counter = 1
    while candidate in used:
        counter += 1
        candidate = "{0}_{1}{2}".format(base, suffix, counter)
    used.add(candidate)
    return candidate


def normalize_annotation(
    path: str,
    dialect_info: Optional[DialectInfo] = None,
    sequence_lengths: Optional[Dict[str, int]] = None,
    example_limit: int = 20,
    progress_callback: Optional[
        Callable[[str, float, str, Dict[str, int]], None]
    ] = None,
) -> NormalizeResult:
    """Parse ``path`` into the canonical model, recording every repair made."""
    info = dialect_info or sniff_annotation(path)
    issues = IssueCollector(example_limit=example_limit)

    def _parse_progress(read_bytes: int, total_bytes: int, features: int) -> None:
        if not progress_callback:
            return
        ratio = min(1.0, read_bytes / float(total_bytes)) if total_bytes else 0.0
        progress_callback(
            "parsing_annotation",
            15.0 + ratio * 45.0,
            "Parsing annotation",
            {"features": features},
        )

    nodes, feature_type_counts, lines_read, lines_malformed = _read_nodes(
        path,
        info.dialect,
        issues,
        sequence_lengths,
        progress_callback=_parse_progress,
    )
    if progress_callback:
        progress_callback(
            "building_gene_models",
            62.0,
            "Building gene models",
            {"features": lines_read},
        )

    result = NormalizeResult(
        issues=issues,
        dialect_info=info,
        feature_type_counts=feature_type_counts,
        lines_read=lines_read,
        lines_malformed=lines_malformed,
    )
    if not nodes:
        issues.add(
            "no_features",
            ERROR,
            "No usable annotation records were found in the file.",
        )
        return result

    _link(nodes, issues)
    _resolve_unknown_roles(nodes)
    # Must follow role resolution: a child only counts as orphaned once we know
    # nothing above it turned out to be its transcript.
    nodes.extend(_synthesise_transcripts_for_orphan_children(nodes, issues))

    # Roles can change during the structural pass, so children collected under a
    # node that turned out to be a gene need re-homing. Rebuild the child lists
    # once roles are final.
    gene_nodes = [n for n in nodes if n.role == ROLE_GENE]
    transcript_nodes = [n for n in nodes if n.role == ROLE_TRANSCRIPT]

    parent_of: Dict[int, _Node] = {}
    for node in nodes:
        for child in node.child_nodes:
            parent_of[child.uid] = node

    # AUGUSTUS bare-token transcripts carry no parent link; recover the gene from
    # the `gene_id` its children spell out.
    tx_by_raw_id: Dict[str, List[_Node]] = {}
    for node in transcript_nodes:
        if node.raw_id:
            tx_by_raw_id.setdefault(node.raw_id, []).append(node)

    gene_by_raw_id: Dict[str, List[_Node]] = {}
    for node in gene_nodes:
        if node.raw_id:
            gene_by_raw_id.setdefault(node.raw_id, []).append(node)

    for node in transcript_nodes:
        if parent_of.get(node.uid) is not None:
            continue
        gene_hint = ""
        for child in node.child_nodes:
            gene_hint = attr_get(child.attrs, "gene_id")
            if gene_hint:
                break
        if not gene_hint:
            continue
        gene_node = _resolve_reference(gene_by_raw_id.get(gene_hint, []), node)
        if gene_node is not None:
            gene_node.child_nodes.append(node)
            parent_of[node.uid] = gene_node

    # Assemble transcripts, keyed by the gene node they belong to.
    used_gene_ids: Set[str] = set()
    genes: List[Gene] = []
    gene_by_uid: Dict[int, Gene] = {}

    for gene_index, node in enumerate(gene_nodes):
        clean_id = strip_gene_prefix(node.raw_id) or _synthesise_gene_id(node, used_gene_ids)
        used_gene_ids.add(clean_id)
        gene = Gene(
            gene_id=clean_id,
            seqid=node.seqid,
            start=node.start,
            end=node.end,
            strand=node.strand,
            source=node.source,
            feature_type=node.ftype,
            name=attr_get(node.attrs, "Name", "gene_name", "gene", "locus_tag") or clean_id,
            description=attr_get(node.attrs, "description", "gene_description", "product"),
            source_biotype=attr_get(node.attrs, *biotype_rules.BIOTYPE_ATTRIBUTE_KEYS),
            source_id=node.raw_id,
            attributes=dict(node.attrs),
        )
        genes.append(gene)
        gene_by_uid[node.uid] = gene
        if progress_callback and (gene_index + 1) % 500 == 0:
            ratio = (gene_index + 1) / float(max(1, len(gene_nodes)))
            progress_callback(
                "building_gene_models",
                62.0 + ratio * 8.0,
                "Building gene models",
                {"features": lines_read, "genes": len(genes)},
            )

    # Transcripts with a resolved gene parent.
    orphan_transcripts: List[_Node] = []
    for transcript_index, node in enumerate(transcript_nodes):
        parent = parent_of.get(node.uid)
        gene = gene_by_uid.get(parent.uid) if parent is not None else None
        if gene is None:
            orphan_transcripts.append(node)
            continue
        gene.transcripts.append(_build_transcript(node, gene.gene_id, info.dialect, issues))
        if progress_callback and (transcript_index + 1) % 500 == 0:
            ratio = (transcript_index + 1) / float(max(1, len(transcript_nodes)))
            progress_callback(
                "building_gene_models",
                70.0 + ratio * 6.0,
                "Building gene models",
                {
                    "features": lines_read,
                    "genes": len(genes),
                    "transcripts": transcript_index + 1,
                },
            )

    # Rule 1: a transcript with no gene gets one synthesised around it. Where a
    # GTF `gene_id` groups several transcripts, they share the synthesised gene.
    synthetic_by_key: Dict[str, Gene] = {}
    for node in orphan_transcripts:
        # A GTF `gene_id` groups isoforms into one locus. Without one, each
        # transcript becomes its own gene, keyed so two transcripts sharing a
        # name on different regions do not merge.
        locus_id = attr_get(node.attrs, "gene_id") or attr_get(node.attrs, "Parent")
        group_key = locus_id or "{0}\t{1}".format(node.seqid, node.raw_id or node.line_no)
        gene = synthetic_by_key.get(group_key)
        if gene is None:
            clean_id = (
                strip_gene_prefix(locus_id)
                if locus_id
                else strip_transcript_prefix(node.raw_id)
            )
            if not clean_id or clean_id in used_gene_ids:
                clean_id = _synthesise_gene_id(node, used_gene_ids)
            used_gene_ids.add(clean_id)
            gene = Gene(
                gene_id=clean_id,
                seqid=node.seqid,
                start=node.start,
                end=node.end,
                strand=node.strand,
                source=node.source,
                feature_type="gene",
                name=clean_id,
                attributes={},
            )
            gene.note("gene_synthesised")
            synthetic_by_key[group_key] = gene
            genes.append(gene)
        gene.transcripts.append(_build_transcript(node, gene.gene_id, info.dialect, issues))

    if synthetic_by_key:
        issues.add(
            "gene_synthesised",
            INFO,
            "Transcripts had no gene feature; a gene was created to hold them.",
            increment=len(synthetic_by_key),
            example=next(iter(synthetic_by_key.values())).gene_id,
        )

    # Rule 2: a gene with no transcript children gets one spanning it, so the
    # locus stays visible in the browser. Any exon/CDS rows parented directly on
    # the gene (RefSeq prokaryote style) become that transcript's children.
    for node in gene_nodes:
        gene = gene_by_uid.get(node.uid)
        if gene is None or gene.transcripts:
            continue
        direct_children = [c for c in node.child_nodes if c.role == ROLE_CHILD]
        pseudo = _Node(
            line_no=node.line_no,
            seqid=node.seqid,
            source=node.source,
            ftype="transcript",
            start=node.start,
            end=node.end,
            strand=node.strand,
            phase=None,
            attrs=dict(node.attrs),
            raw_id=node.raw_id,
            uid=node.uid,
        )
        pseudo.child_nodes = direct_children
        transcript = _build_transcript(pseudo, gene.gene_id, info.dialect, issues)
        transcript.transcript_id = gene.gene_id
        transcript.note("transcript_synthesised")
        gene.transcripts.append(transcript)

    # Finalise biotypes, spans and canonical flags.
    for gene in genes:
        for transcript in gene.transcripts:
            resolved, rule = biotype_rules.resolve_transcript_biotype(
                explicit=transcript.source_biotype,
                feature_type=transcript.feature_type,
                has_cds=bool(transcript.cds),
                mature_length=transcript.mature_length,
                gene_biotype=gene.source_biotype,
            )
            transcript.biotype = resolved
            transcript.biotype_rule = rule
            result.biotype_rule_counts[rule] = result.biotype_rule_counts.get(rule, 0) + 1

            if not transcript.cds and biotype_rules.implies_cds(resolved):
                issues.add(
                    "coding_biotype_without_cds",
                    WARNING,
                    "Transcript is declared coding but has no CDS. The biotype was "
                    "kept as given; no protein can be translated for it.",
                    example="{0} ({1})".format(transcript.transcript_id, resolved),
                )

        gene.biotype = biotype_rules.derive_gene_biotype(
            [tx.biotype for tx in gene.transcripts],
            explicit=gene.source_biotype,
        )

        if gene.transcripts:
            span_start = min(tx.start for tx in gene.transcripts)
            span_end = max(tx.end for tx in gene.transcripts)
            if span_start < gene.start or span_end > gene.end:
                gene.start = min(gene.start, span_start)
                gene.end = max(gene.end, span_end)
                gene.note("span_expanded_to_transcripts")
            if gene.strand not in {"+", "-"}:
                for transcript in gene.transcripts:
                    if transcript.strand in {"+", "-"}:
                        gene.strand = transcript.strand
                        gene.note("strand_from_transcripts")
                        break

        _select_canonical(gene)

    genes.sort(key=lambda g: (g.seqid, g.start, g.end, g.gene_id))
    result.genes = genes
    result.seqids = sorted({gene.seqid for gene in genes})

    for gene in genes:
        for tag in gene.inferred:
            result.inference_counts[tag] = result.inference_counts.get(tag, 0) + 1
        for transcript in gene.transcripts:
            for tag in transcript.inferred:
                result.inference_counts[tag] = result.inference_counts.get(tag, 0) + 1

    if not genes:
        issues.add(
            "no_genes",
            ERROR,
            "No gene or transcript features could be reconstructed from this file.",
        )

    if progress_callback:
        progress_callback(
            "building_gene_models",
            78.0,
            "Gene models ready",
            {
                "features": lines_read,
                "genes": len(result.genes),
                "transcripts": sum(len(gene.transcripts) for gene in result.genes),
            },
        )
    return result
