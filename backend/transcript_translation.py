"""Translating a transcript: the genetic code for its genome and contig (organelle tables
from the lineage, with a cached per-genome context), CDS assembly from the annotation,
and the protein the Feature Explorer, sequence view and structure panel all show.
"""

import threading
from typing import Any, Dict, List, Optional, Tuple

import app_state
import config_store
import data_paths
import genome_context
import sequence_windows
from translation import (
    autodetect_organelle_table,
    build_translation_layout,
    classify_contig_molecule,
    internal_stop_count,
    MOLECULE_NUCLEAR,
    TABLE_STANDARD,
    translate_cds_dna,
    translation_table_for_lineage,
    TranslationLayout,
)


# ── protein translation ───────────────────────────────────────────────────────
#
# The translation rules themselves live in backend/translation.py; what is here
# is the genome plumbing: which genetic code a contig uses, and how CDS bases are
# read out of the FASTA.

_TRANSLATION_CONTEXT_CACHE: Dict[str, Dict[str, Any]] = {}


_TRANSLATION_CONTEXT_GUARD = threading.Lock()


def _genome_taxid(genome: str, species: Dict[str, Any]) -> int:
    """Best-effort NCBI taxid for a configured genome."""
    for key in ("taxid", "species_taxonomy_id", "taxonomy_id"):
        try:
            value = int(species.get(key) or 0)
        except Exception:
            value = 0
        if value:
            return value

    catalog_key = config_store._find_catalog_species_key(species.get("species_key"))
    info = (getattr(app_state.download_manager, "species_data", {}) or {}).get(catalog_key) or {}
    if isinstance(info, dict):
        for key in ("taxid", "species_taxonomy_id"):
            try:
                value = int(info.get(key) or 0)
            except Exception:
                value = 0
            if value:
                return value

    metadata_path = None
    try:
        metadata_path = genome_context._get_genome_metadata_path(genome)
    except Exception:
        metadata_path = None
    if metadata_path:
        return data_paths._assembly_report_taxid(metadata_path)
    return 0


def _genome_lineage(genome: str, species: Dict[str, Any]) -> Tuple[int, ...]:
    taxid = _genome_taxid(genome, species)
    if not taxid:
        return ()
    classifier = getattr(app_state.download_manager, "taxonomy_classifier", None)
    if classifier is None:
        return ()
    try:
        _resolved, lineage = classifier.lineage_for_taxid(taxid)
    except Exception:
        return ()
    return tuple(lineage)


def _translation_context(genome: str) -> Dict[str, Any]:
    """Per-genome translation settings: contig molecule types and species lineage.

    Cached per genome because it reads the assembly report and the taxonomy
    artifact, and the answer is the same for every transcript of that genome.
    """
    context = genome_context._resolve_browse_genome_context(genome)
    species = context.get("species") or {}
    try:
        metadata_path = genome_context._get_genome_metadata_path(genome)
    except Exception:
        metadata_path = None

    # Keyed on the files too, so re-pointing a genome at a different assembly or
    # annotation does not keep the previous answer.
    cache_key = "\x1f".join([
        str(context.get("cache_key") or genome or "reference"),
        str(context.get("fasta_path") or ""),
        str(metadata_path or ""),
    ])
    with _TRANSLATION_CONTEXT_GUARD:
        cached = _TRANSLATION_CONTEXT_CACHE.get(cache_key)
    if cached is not None:
        return cached

    molecules: Dict[str, str] = {}
    if metadata_path:
        for row in genome_context._load_cached_assembly_report_rows(metadata_path):
            molecule = classify_contig_molecule(row.sequence_name, getattr(row, "molecule_type", ""))
            if molecule == MOLECULE_NUCLEAR:
                continue
            for alias in row.ordered_aliases():
                molecules[str(alias).strip().lower()] = molecule

    resolved = {
        "molecules": molecules,
        "lineage": _genome_lineage(genome, species),
    }
    with _TRANSLATION_CONTEXT_GUARD:
        _TRANSLATION_CONTEXT_CACHE[cache_key] = resolved
    return resolved


def _resolve_translation_table(genome: str, chrom: str) -> Tuple[int, str, bool]:
    """Genetic code for *chrom* of *genome*.

    Returns ``(table, molecule, resolved)`` where ``resolved`` is False when the
    species lineage was unavailable, which lets organelle callers fall back to
    auto-detection instead of silently using the wrong code.
    """
    try:
        context = _translation_context(genome)
    except Exception:
        context = {"molecules": {}, "lineage": ()}

    molecules = context.get("molecules") or {}
    lineage = context.get("lineage") or ()
    molecule = molecules.get(str(chrom or "").strip().lower())
    if not molecule:
        molecule = classify_contig_molecule(chrom)

    table = translation_table_for_lineage(molecule, lineage)
    if table is None:
        return TABLE_STANDARD, molecule, False
    return table, molecule, True


def _cds_dna_from_layout(fasta, chrom: str, strand: str, layout: TranslationLayout) -> str:
    """Concatenate the translated CDS bases in 5'→3' order.

    A segment that cannot be read (contig missing from the FASTA, coordinates off
    the end) is padded with Ns rather than skipped: dropping bases would shift the
    reading frame of everything downstream.
    """
    pieces: List[str] = []
    for segment in layout.segments:
        expected = segment.coord_end - segment.coord_start + 1
        piece = sequence_windows._fetch_oriented_piece(
            fasta, chrom, segment.genomic_start, segment.genomic_end, strand
        )
        if len(piece) < expected:
            piece = piece + ("N" * (expected - len(piece)))
        pieces.append(piece[:expected])
    return "".join(pieces)


def _translate_cds(
    fasta,
    chrom: str,
    strand: str,
    cds_list: List[Dict[str, Any]],
    table: Optional[int] = None,
) -> str:
    """Amino-acid sequence for a CDS, following Ensembl/RefSeq pep conventions.

    See backend/translation.py for the rules. ``table`` defaults to the standard
    genetic code; callers with a genome in hand should pass the code resolved by
    :func:`_resolve_translation_table` so that organelle genes are not translated
    with the nuclear code.
    """
    protein, _layout, _table = _translate_transcript(
        fasta, chrom, strand, cds_list, table=table
    )
    return protein


def _sequence_view_protein(
    genome: str,
    fasta,
    chrom: str,
    strand: str,
    cds_list: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """One transcript's protein, for the sequence view's panel.

    The genetic code is resolved here rather than by the caller because resolving
    it needs the genome's lineage and its assembly report, which is knowledge this
    module has and ``sequence_view`` deliberately does not -- the package is
    handed the functions it needs instead of importing this one.

    The same call the Feature Explorer's protein rows go through, so the two
    views cannot disagree about a residue. What comes back alongside the protein
    is what the panel has to say about it in words: which code was used, and
    whether the CDS begins mid-codon.
    """
    table, molecule, resolved = _resolve_translation_table(genome, chrom)
    protein, layout, used_table = _translate_transcript(
        fasta, chrom, strand, cds_list,
        table=table, molecule=molecule, autodetect=not resolved,
    )
    return {
        "protein": protein,
        "phase": int(layout.start_phase or 0),
        # Virtual bases standing in for the codon that began outside the CDS, so
        # that residue n is always at positions 3n-2..3n. The padded positions
        # map to no genomic base, which is the honest answer for bases the
        # annotation does not have.
        "pad": int(layout.pad or 0),
        "cds_length": int(layout.cds_length or 0),
        "dropped_trailing": int(layout.dropped_trailing or 0),
        "table": int(used_table),
        "molecule": str(molecule),
        # An internal stop is real information about the annotation -- a
        # readthrough, a frameshift, a mis-annotation -- and the panel says so
        # rather than letting a reader find it by eye.
        "internal_stops": internal_stop_count(protein),
        # Plain dicts rather than the dataclass: `sequence_view` is handed the
        # functions it needs instead of importing this module, and a dataclass
        # crossing that line would be one more thing it had to know about.
        "segments": [
            {
                "coord_start": int(segment.coord_start),
                "coord_end": int(segment.coord_end),
                "genomic_start": int(segment.genomic_start),
                "genomic_end": int(segment.genomic_end),
            }
            for segment in layout.segments
        ],
    }


def _translate_transcript(
    fasta,
    chrom: str,
    strand: str,
    cds_list: List[Dict[str, Any]],
    table: Optional[int] = None,
    molecule: str = MOLECULE_NUCLEAR,
    autodetect: bool = False,
) -> Tuple[str, TranslationLayout, int]:
    """Translate a transcript, returning the protein, CDS layout and code used."""
    layout = build_translation_layout(cds_list, strand)
    if not layout.segments:
        return "", layout, int(table or TABLE_STANDARD)

    dna = _cds_dna_from_layout(fasta, chrom, strand, layout)
    if not dna:
        return "", layout, int(table or TABLE_STANDARD)

    resolved_table = int(table or TABLE_STANDARD)
    if autodetect and molecule != MOLECULE_NUCLEAR:
        resolved_table = autodetect_organelle_table(dna, start_phase=layout.start_phase)

    protein = translate_cds_dna(dna, start_phase=layout.start_phase, table=resolved_table)
    return protein, layout, resolved_table
