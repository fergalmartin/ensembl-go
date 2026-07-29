"""Map arbitrary annotation vocabularies onto the Ensembl biotype model.

Resolution order for a transcript (documented in docs/CUSTOM_GENOMES.md §3.5):

1. an explicit biotype attribute, mapped through the synonym table;
2. no biotype but a CDS (or start/stop codon) present -> ``protein_coding``;
3. no biotype, no CDS, mature length >= 200 -> ``lncRNA``;
4. no biotype, no CDS, mature length < 200 -> ``sncRNA``.

Step 3/4 use the *mature* length (sum of exon lengths), not the genomic span, so
a short single-exon gene inside a long locus is classified on what it transcribes.

``sncRNA`` is not an Ensembl core term. It is used deliberately for the inferred
case so the display never claims more specificity than the input supports; see
the open question in docs/CUSTOM_GENOMES.md §8.
"""

from __future__ import annotations

from typing import Dict, Iterable, Optional, Tuple

#: Mature length at or above which a non-coding transcript is called ``lncRNA``.
LNCRNA_MIN_MATURE_LENGTH = 200

PROTEIN_CODING = "protein_coding"
LNCRNA = "lncRNA"
SNCRNA = "sncRNA"

#: Rule identifiers reported back to the user so inference is auditable.
RULE_EXPLICIT = "explicit"
RULE_CDS = "inferred_from_cds"
RULE_LENGTH_LONG = "inferred_length_ge_200"
RULE_LENGTH_SHORT = "inferred_length_lt_200"
RULE_PARENT = "inherited_from_gene"

#: Lower-cased source term -> Ensembl biotype.
_SYNONYMS: Dict[str, str] = {
    # coding
    "protein_coding": PROTEIN_CODING,
    "protein-coding": PROTEIN_CODING,
    "proteincoding": PROTEIN_CODING,
    "coding": PROTEIN_CODING,
    "mrna": PROTEIN_CODING,
    "cds": PROTEIN_CODING,
    "polypeptide": PROTEIN_CODING,
    "protein": PROTEIN_CODING,
    "protein_coding_gene": PROTEIN_CODING,
    "nonsense_mediated_decay": "nonsense_mediated_decay",
    "non_stop_decay": "non_stop_decay",
    "protein_coding_lof": "protein_coding_LoF",
    "protein_coding_cds_not_defined": "protein_coding_CDS_not_defined",
    # long non-coding
    "lncrna": LNCRNA,
    "lnc_rna": LNCRNA,
    "lincrna": LNCRNA,
    "linc_rna": LNCRNA,
    "long_noncoding_rna": LNCRNA,
    "antisense": LNCRNA,
    "antisense_rna": LNCRNA,
    "sense_intronic": "sense_intronic",
    "sense_overlapping": "sense_overlapping",
    "macro_lncrna": LNCRNA,
    "bidirectional_promoter_lncrna": LNCRNA,
    "3prime_overlapping_ncrna": LNCRNA,
    "retained_intron": "retained_intron",
    "processed_transcript": "processed_transcript",
    "tec": "TEC",
    # small non-coding
    "mirna": "miRNA",
    "pre_mirna": "miRNA",
    "primary_transcript": "miRNA",
    "snrna": "snRNA",
    "snorna": "snoRNA",
    "scarna": "scaRNA",
    "scrna": "scRNA",
    "srna": SNCRNA,
    "sncrna": SNCRNA,
    "small_rna": SNCRNA,
    "rrna": "rRNA",
    "rrna_gene": "rRNA",
    "trna": "tRNA",
    "trna_gene": "tRNA",
    "mt_rrna": "Mt_rRNA",
    "mt_trna": "Mt_tRNA",
    "misc_rna": "misc_RNA",
    "other_rna": "misc_RNA",
    "ncrna": "ncRNA",
    "non_coding": "ncRNA",
    "noncoding": "ncRNA",
    "ribozyme": "ribozyme",
    "rnase_p_rna": "RNase_P_RNA",
    "rnase_mrp_rna": "RNase_MRP_RNA",
    "srp_rna": "SRP_RNA",
    "telomerase_rna": "telomerase_RNA",
    "vault_rna": "vault_RNA",
    "y_rna": "misc_RNA",
    "guide_rna": "misc_RNA",
    "pirna": "piRNA",
    "sirna": "siRNA",
    # pseudogenes
    "pseudogene": "pseudogene",
    "pseudo": "pseudogene",
    "processed_pseudogene": "processed_pseudogene",
    "unprocessed_pseudogene": "unprocessed_pseudogene",
    "unitary_pseudogene": "unitary_pseudogene",
    "polymorphic_pseudogene": "polymorphic_pseudogene",
    "transcribed_processed_pseudogene": "transcribed_processed_pseudogene",
    "transcribed_unprocessed_pseudogene": "transcribed_unprocessed_pseudogene",
    "transcribed_unitary_pseudogene": "transcribed_unitary_pseudogene",
    "translated_processed_pseudogene": "translated_processed_pseudogene",
    "pseudogenic_transcript": "pseudogene",
    "pseudogenic_exon": "pseudogene",
    # immune loci
    "ig_c_gene": "IG_C_gene",
    "ig_d_gene": "IG_D_gene",
    "ig_j_gene": "IG_J_gene",
    "ig_v_gene": "IG_V_gene",
    "tr_c_gene": "TR_C_gene",
    "tr_d_gene": "TR_D_gene",
    "tr_j_gene": "TR_J_gene",
    "tr_v_gene": "TR_V_gene",
    "c_gene_segment": "IG_C_gene",
    "d_gene_segment": "IG_D_gene",
    "j_gene_segment": "IG_J_gene",
    "v_gene_segment": "IG_V_gene",
    # transposons / other
    "transposable_element": "transposable_element",
    "transposable_element_gene": "transposable_element",
}

#: Ensembl biotype -> major display class. Anything unmapped falls through the
#: pattern rules in :func:`major_class`.
_MAJOR_CLASS: Dict[str, str] = {
    PROTEIN_CODING: "coding",
    "protein_coding_LoF": "coding",
    "protein_coding_CDS_not_defined": "coding",
    "nonsense_mediated_decay": "coding",
    "non_stop_decay": "coding",
    "retained_intron": "coding",
    "IG_C_gene": "coding",
    "IG_D_gene": "coding",
    "IG_J_gene": "coding",
    "IG_V_gene": "coding",
    "TR_C_gene": "coding",
    "TR_D_gene": "coding",
    "TR_J_gene": "coding",
    "TR_V_gene": "coding",
    LNCRNA: "lnoncoding",
    "ncRNA": "lnoncoding",
    "processed_transcript": "lnoncoding",
    "sense_intronic": "lnoncoding",
    "sense_overlapping": "lnoncoding",
    "TEC": "lnoncoding",
    SNCRNA: "snoncoding",
    "miRNA": "snoncoding",
    "piRNA": "snoncoding",
    "siRNA": "snoncoding",
    "snRNA": "snoncoding",
    "snoRNA": "snoncoding",
    "scaRNA": "snoncoding",
    "scRNA": "snoncoding",
    "rRNA": "snoncoding",
    "tRNA": "snoncoding",
    "Mt_rRNA": "snoncoding",
    "Mt_tRNA": "snoncoding",
    "misc_RNA": "snoncoding",
    "ribozyme": "snoncoding",
    "vault_RNA": "snoncoding",
    "RNase_P_RNA": "snoncoding",
    "RNase_MRP_RNA": "snoncoding",
    "SRP_RNA": "snoncoding",
    "telomerase_RNA": "snoncoding",
}

#: Attribute names that may carry a biotype, most specific first.
BIOTYPE_ATTRIBUTE_KEYS = (
    "biotype",
    "transcript_biotype",
    "gene_biotype",
    "transcript_type",
    "gene_type",
    "ncrna_class",
    "gbkey",
)

#: ``gbkey`` values that say nothing useful about biotype.
_UNINFORMATIVE = frozenset({"", ".", "gene", "rna", "transcript", "misc_feature", "src"})


def canonical_biotype(raw: Optional[str], strict: bool = False) -> str:
    """Map a source biotype term onto the Ensembl vocabulary.

    Returns ``''`` when the term is absent or carries no information (``gbkey=Gene``
    tells us the row is a gene, not what kind of gene it is).

    ``strict`` restricts the result to terms we actually recognise. Use it when
    the candidate is a GFF column-3 feature type rather than a biotype attribute:
    an unrecognised SO term says nothing about biotype and must fall through to
    the structural rules, whereas an unrecognised *attribute* value is the user's
    own vocabulary and is worth preserving.
    """
    token = str(raw or "").strip()
    if not token:
        return ""
    lowered = token.lower().replace("-", "_").replace(" ", "_")
    if lowered in _UNINFORMATIVE:
        return ""
    mapped = _SYNONYMS.get(lowered)
    if mapped:
        return mapped
    if strict:
        return ""
    # Unrecognised but clearly a pseudogene / RNA subtype: keep the source term
    # rather than discarding information we cannot improve on.
    return token


def resolve_transcript_biotype(
    explicit: Optional[str],
    feature_type: Optional[str],
    has_cds: bool,
    mature_length: int,
    gene_biotype: Optional[str] = None,
) -> Tuple[str, str]:
    """Return ``(biotype, rule)`` for one transcript.

    ``explicit`` is the raw attribute value, ``feature_type`` the GFF column 3
    term (``lnc_RNA``, ``miRNA``, … are themselves biotypes in SO-typed files).
    """
    # An explicit biotype attribute is the author's assertion and is always
    # honoured, even when it disagrees with the structure. Overriding it would
    # silently rewrite Ensembl and RefSeq annotation; a coding transcript with no
    # CDS is reported as an issue instead.
    mapped = canonical_biotype(explicit)
    if mapped:
        return mapped, RULE_EXPLICIT

    # The column-3 feature type is weaker evidence: tools routinely emit `mRNA`
    # for assembled transcripts that were never shown to be coding, so that term
    # is only trusted when a CDS backs it up.
    mapped = canonical_biotype(feature_type, strict=True)
    if mapped and not (mapped == PROTEIN_CODING and not has_cds):
        return mapped, RULE_EXPLICIT

    if has_cds:
        return PROTEIN_CODING, RULE_CDS

    inherited = canonical_biotype(gene_biotype)
    if inherited and inherited != PROTEIN_CODING:
        return inherited, RULE_PARENT

    if mature_length >= LNCRNA_MIN_MATURE_LENGTH:
        return LNCRNA, RULE_LENGTH_LONG
    return SNCRNA, RULE_LENGTH_SHORT


#: Preference order when collapsing transcript biotypes onto their gene.
_GENE_PRIORITY = ("coding", "pseudogene", "lnoncoding", "snoncoding", "other")


def derive_gene_biotype(
    transcript_biotypes: Iterable[str],
    explicit: Optional[str] = None,
) -> str:
    """Pick a gene biotype from its transcripts, honouring an explicit value.

    An explicit gene biotype wins unless it is uninformative. Otherwise the
    highest-priority transcript class present is used, which keeps a locus with
    one coding and several non-coding isoforms labelled ``protein_coding``.
    """
    mapped_explicit = canonical_biotype(explicit)
    if mapped_explicit:
        return mapped_explicit

    seen = [b for b in transcript_biotypes if b]
    if not seen:
        return ""

    by_class: Dict[str, str] = {}
    for biotype in seen:
        by_class.setdefault(major_class(biotype), biotype)
    for klass in _GENE_PRIORITY:
        if klass in by_class:
            # Prefer the canonical term for the class over an isoform-specific one.
            if klass == "coding":
                return PROTEIN_CODING if PROTEIN_CODING in seen else by_class[klass]
            return by_class[klass]
    return seen[0]


#: Biotypes whose definition requires a CDS. Deliberately narrower than the
#: ``coding`` major class: Ensembl groups ``retained_intron`` and
#: ``processed_transcript`` under coding, but those are the non-coding isoforms
#: of a coding gene and having no CDS is correct for them.
_IMPLIES_CDS = frozenset({
    PROTEIN_CODING,
    "protein_coding_LoF",
    "nonsense_mediated_decay",
    "non_stop_decay",
    "IG_C_gene", "IG_D_gene", "IG_J_gene", "IG_V_gene",
    "TR_C_gene", "TR_D_gene", "TR_J_gene", "TR_V_gene",
})


def implies_cds(biotype: Optional[str]) -> bool:
    """True when a transcript of this biotype is expected to carry a CDS."""
    token = str(biotype or "").strip()
    if not token:
        return False
    return token in _IMPLIES_CDS or canonical_biotype(token) in _IMPLIES_CDS


def major_class(biotype: Optional[str]) -> str:
    """Collapse a biotype to ``coding``/``lnoncoding``/``snoncoding``/``pseudogene``/``other``."""
    token = str(biotype or "").strip()
    if not token:
        return "other"
    direct = _MAJOR_CLASS.get(token)
    if direct:
        return direct
    lowered = token.lower()
    direct = _MAJOR_CLASS.get(canonical_biotype(token) or "")
    if direct:
        return direct
    if "pseudogene" in lowered:
        return "pseudogene"
    if lowered.startswith("protein_coding"):
        return "coding"
    if lowered.startswith("ig_") or lowered.startswith("tr_"):
        return "pseudogene" if lowered.endswith("_pseudogene") else "coding"
    if "lncrna" in lowered or "lnc_rna" in lowered:
        return "lnoncoding"
    if lowered.endswith("rna"):
        return "snoncoding"
    return "other"
