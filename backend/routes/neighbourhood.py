"""Gene neighbourhoods: anchoring a gene by id or symbol (index or GFF scan), collecting
its flanking genes with their homology links, the ten-minute neighbourhood cache, and
the /api/neighbourhood endpoints.
"""

import logging
import os
import sqlite3
import time
from typing import Any, Dict, List, Optional, Set, Tuple
from urllib.parse import unquote

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

import file_io
import genome_context
import routes.homology

logger = logging.getLogger(__name__)
router = APIRouter()


class GeneSummary(BaseModel):
    id: str
    name: Optional[str] = None
    chrom: str
    start: int
    end: int
    strand: str
    biotype: str = ""
    is_focal: bool = False  # True if this is the query gene


class HomologyLink(BaseModel):
    ref_gene_id: str
    target_gene_id: str
    homology_type: str = ""
    is_rbh: bool = False
    perc_id: Optional[float] = None
    perc_cov: Optional[float] = None


class NeighbourhoodResponse(BaseModel):
    reference_genes: List[GeneSummary]
    target_genes: List[GeneSummary]
    center_ref_id: Optional[str]
    center_target_id: Optional[str]
    homologies: List[Tuple[str, str]] = []  # List of (source_id, target_id) pairs
    homology_links: List[HomologyLink] = []  # Real Compara homology TSV-derived links (only when use_homology=true)
    ref_homology_available: bool = False
    target_homology_available: bool = False
    request_transcript_id: Optional[str] = None
    request_target_transcript_id: Optional[str] = None
    request_ref_gene_id: Optional[str] = None
    request_target_gene_id: Optional[str] = None


# In-memory cache for neighbourhood results. Keyed by (ref_gene_id, target_gene_id, window_size).
# Neighbourhoods are stable data so a 10-minute TTL is safe.
_neighbourhood_cache: dict = {}


_NEIGHBOURHOOD_CACHE_TTL = 600  # seconds


def _normalize_gene_id(raw: Optional[str]) -> str:
    return (raw or "").strip().replace("gene:", "")


def _normalize_transcript_id(raw: Optional[str]) -> str:
    return (raw or "").strip().replace("transcript:", "").replace("mapped_transcript:", "")


def _parse_gff_attrs(attr_str: str) -> Dict[str, str]:
    attrs: Dict[str, str] = {}
    for item in (attr_str or "").strip().split(";"):
        if "=" not in item:
            continue
        k, v = item.split("=", 1)
        attrs[k] = unquote(v)
    return attrs


def resolve_gene_anchor(db_path: str, gene_id: Optional[str] = None, transcript_id: Optional[str] = None) -> Optional[str]:
    """Resolve/validate a gene-focused neighbourhood anchor from gene or transcript input."""
    if not db_path or not os.path.exists(db_path):
        return None

    gene_query = _normalize_gene_id(gene_id)
    tx_query = _normalize_transcript_id(transcript_id)

    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        c = conn.cursor()

        if gene_query:
            c.execute("SELECT id FROM genes WHERE id = ? LIMIT 1", (gene_query,))
            row = c.fetchone()
            if row:
                conn.close()
                return row["id"]

        if tx_query:
            c.execute("SELECT parent_gene_id FROM transcripts WHERE id = ? LIMIT 1", (tx_query,))
            row = c.fetchone()
            if row and row["parent_gene_id"]:
                parent_gene_id = _normalize_gene_id(row["parent_gene_id"])
                c.execute("SELECT id FROM genes WHERE id = ? LIMIT 1", (parent_gene_id,))
                g_row = c.fetchone()
                conn.close()
                if g_row:
                    return g_row["id"]
                return None

        conn.close()
        return None
    except Exception as e:
        logger.error(f"resolve_gene_anchor failed for {db_path}: {e}")
        return None


def resolve_gene_anchor_gff(gff_path: str, gene_id: Optional[str] = None, transcript_id: Optional[str] = None) -> Optional[str]:
    """No-index fallback anchor resolution for neighbourhood gene queries."""
    if not gff_path or not os.path.exists(gff_path):
        return None

    gene_query = _normalize_gene_id(gene_id)
    tx_query = _normalize_transcript_id(transcript_id)

    gene_feature_types = {
        'gene',
        'pseudogene',
        'ncRNA_gene',
        'rRNA_gene',
        'snRNA_gene',
        'snoRNA_gene',
        'miRNA_gene',
        'misc_RNA_gene',
        'tRNA_gene',
        'transposable_element_gene',
        'scRNA_gene',
        'vault_RNA_gene',
    }
    transcript_types = {
        'lnc_RNA', 'mRNA', 'transcript', 'ncRNA', 'rRNA', 'snRNA',
        'snoRNA', 'miRNA', 'misc_RNA', 'pseudogenic_transcript',
        'processed_transcript', 'unconfirmed_transcript',
        'antisense_RNA', 'primary_transcript', 'guide_RNA', 'vault_RNA',
        'RNase_P_RNA', 'RNase_MRP_RNA', 'SRP_RNA', 'telomerase_RNA',
    }

    try:
        with file_io.open_maybe_gz(gff_path, "r") as handle:
            for line in handle:
                if not line or line.startswith("#"):
                    continue
                parts = line.rstrip("\n").split("\t")
                if len(parts) < 9:
                    continue
                attrs = _parse_gff_attrs(parts[8])
                feature_type = parts[2]
                raw_id = attrs.get("ID", "")
                parent_attr = attrs.get("Parent", "")
                has_gene_id = raw_id.startswith("gene:")
                is_gene_level = (feature_type in gene_feature_types) or (has_gene_id and not parent_attr)
                if gene_query and is_gene_level:
                    row_gene = _normalize_gene_id(raw_id or attrs.get("gene_id", ""))
                    if row_gene == gene_query:
                        return row_gene
                if tx_query and feature_type in transcript_types:
                    row_tx = _normalize_transcript_id(raw_id)
                    row_tx_alt = _normalize_transcript_id(attrs.get("transcript_id", ""))
                    if row_tx == tx_query or row_tx_alt == tx_query:
                        return _normalize_gene_id(attrs.get("Parent", ""))
    except Exception as e:
        logger.error(f"resolve_gene_anchor_gff failed for {gff_path}: {e}")
    return None


def get_gene_neighbourhood_by_gene(gff_path: str, gene_id: str, window_size: int = 5) -> Tuple[List[GeneSummary], Optional[str]]:
    """No-index fallback neighbourhood query using only gene features."""
    search_gene = _normalize_gene_id(gene_id)
    if not search_gene:
        return [], None

    center_chrom: Optional[str] = None
    center_start = 0
    center_end = 0
    center_strand = "+"
    center_name = search_gene
    center_biotype = ""

    try:
        with file_io.open_maybe_gz(gff_path, "r") as handle:
            for line in handle:
                if not line or line.startswith("#"):
                    continue
                parts = line.rstrip("\n").split("\t")
                if len(parts) < 9 or parts[2] != "gene":
                    continue
                attrs = _parse_gff_attrs(parts[8])
                row_gene = _normalize_gene_id(attrs.get("ID", ""))
                if row_gene != search_gene:
                    continue
                center_chrom = parts[0]
                center_start = int(parts[3])
                center_end = int(parts[4])
                center_strand = parts[6]
                center_name = attrs.get("Name", row_gene) or row_gene
                center_biotype = attrs.get("biotype", "") or attrs.get("gene_biotype", "")
                break
    except Exception as e:
        logger.error(f"GFF neighbourhood center lookup failed: {e}")
        return [], None

    if not center_chrom:
        return [], None

    genes: List[GeneSummary] = []
    try:
        with file_io.open_maybe_gz(gff_path, "r") as handle:
            for line in handle:
                if not line or line.startswith("#"):
                    continue
                parts = line.rstrip("\n").split("\t")
                if len(parts) < 9 or parts[2] != "gene" or parts[0] != center_chrom:
                    continue
                attrs = _parse_gff_attrs(parts[8])
                row_gene = _normalize_gene_id(attrs.get("ID", ""))
                if not row_gene:
                    continue
                genes.append(GeneSummary(
                    id=row_gene,
                    name=attrs.get("Name", row_gene) or row_gene,
                    chrom=parts[0],
                    start=int(parts[3]),
                    end=int(parts[4]),
                    strand=parts[6],
                    biotype=attrs.get("biotype", "") or attrs.get("gene_biotype", ""),
                    is_focal=False,
                ))
    except Exception as e:
        logger.error(f"GFF neighbourhood chromosome scan failed: {e}")
        return [], None

    if not genes:
        return [], None

    genes.sort(key=lambda g: (g.start, g.id))
    center_idx = -1
    for idx, g in enumerate(genes):
        if g.id == search_gene:
            center_idx = idx
            genes[idx].is_focal = True
            break
    if center_idx == -1:
        for idx, g in enumerate(genes):
            if g.start <= center_start and g.end >= center_end:
                center_idx = idx
                genes[idx].is_focal = True
                search_gene = g.id
                break
    if center_idx == -1:
        dummy = GeneSummary(
            id=search_gene,
            name=center_name,
            chrom=center_chrom,
            start=center_start,
            end=center_end,
            strand=center_strand,
            biotype=center_biotype,
            is_focal=True,
        )
        genes.append(dummy)
        genes.sort(key=lambda g: g.start)
        center_idx = genes.index(dummy)

    start_idx = max(0, center_idx - window_size)
    end_idx = min(len(genes), center_idx + window_size + 1)
    return genes[start_idx:end_idx], search_gene


def get_gene_neighbourhood_index_by_gene(db_path: str, gene_id: str, window_size: int = 5) -> Tuple[List[GeneSummary], Optional[str]]:
    """Get neighbourhood from index by focal gene ID."""
    search_gene = _normalize_gene_id(gene_id)
    if not search_gene:
        return [], None

    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        c = conn.cursor()

        c.execute(
            "SELECT id, name, chrom, start, end, strand, biotype FROM genes WHERE id = ? LIMIT 1",
            (search_gene,)
        )
        center_row = c.fetchone()
        if not center_row:
            conn.close()
            return [], None

        chrom = center_row["chrom"]
        center_start = int(center_row["start"] or 0)

        c.execute(
            "SELECT COUNT(*) FROM genes "
            "WHERE chrom = ? AND (start < ? OR (start = ? AND id < ?))",
            (chrom, center_start, center_start, search_gene)
        )
        preceding_count = int(c.fetchone()[0] or 0)
        window_start_index = max(0, preceding_count - window_size)
        left_count = preceding_count - window_start_index
        limit_count = left_count + 1 + window_size

        c.execute(
            "SELECT id, name, chrom, start, end, strand, biotype FROM genes "
            "WHERE chrom = ? ORDER BY start ASC, id ASC LIMIT ? OFFSET ?",
            (chrom, limit_count, window_start_index)
        )
        neighbourhood_rows = c.fetchall()
        conn.close()

        def make_summary(row: sqlite3.Row) -> GeneSummary:
            return GeneSummary(
                id=row["id"],
                name=row["name"],
                chrom=row["chrom"],
                start=row["start"],
                end=row["end"],
                strand=row["strand"],
                biotype=row["biotype"] or "",
                is_focal=False,
            )

        combined = [make_summary(r) for r in neighbourhood_rows]
        found_center = False
        for gene in combined:
            if gene.id == center_row["id"]:
                gene.is_focal = True
                found_center = True
                break
        if not found_center:
            center_gene = GeneSummary(
                id=center_row["id"],
                name=center_row["name"] or center_row["id"],
                chrom=center_row["chrom"],
                start=center_row["start"],
                end=center_row["end"],
                strand=center_row["strand"],
                biotype=center_row["biotype"] or "",
                is_focal=True,
            )
            combined.append(center_gene)
            combined.sort(key=lambda g: (g.start, g.id))
        return combined, center_row["id"]
    except Exception as e:
        logger.error(f"Index neighbourhood error for {search_gene}: {e}")
        return [], None


# Backward-compatible wrappers for older call sites that pass transcript IDs.
def get_gene_neighbourhood(gff_path: str, transcript_id: str, window_size: int = 5) -> Tuple[List[GeneSummary], Optional[str]]:
    gene_id = resolve_gene_anchor_gff(gff_path, transcript_id=transcript_id)
    if not gene_id:
        return [], None
    return get_gene_neighbourhood_by_gene(gff_path, gene_id, window_size)


def get_gene_neighbourhood_index(db_path: str, transcript_id: str, window_size: int = 5) -> Tuple[List[GeneSummary], Optional[str]]:
    gene_id = resolve_gene_anchor(db_path, transcript_id=transcript_id) or resolve_gene_anchor(db_path, gene_id=transcript_id)
    if not gene_id:
        return [], None
    return get_gene_neighbourhood_index_by_gene(db_path, gene_id, window_size)


@router.get("/api/neighbourhood", response_model=NeighbourhoodResponse)
async def get_neighbourhood(
    ref_gene_id: Optional[str] = None,
    target_gene_id: Optional[str] = None,
    transcript_id: Optional[str] = None,
    target_transcript_id: Optional[str] = None,
    ref_genome: str = "reference",
    target_genome: str = "target",
    window_size: int = 25,
    use_homology: bool = False,
):
    """Get gene-level neighbourhood for reference and optional target anchors."""
    window_size = max(1, min(600, int(window_size)))
    req_started = time.perf_counter()

    ref_context = genome_context._resolve_browse_genome_context(ref_genome)
    target_context = genome_context._resolve_browse_genome_context(target_genome)
    ref_gff = str(ref_context.get("gff_path") or "").strip()
    target_gff = str(target_context.get("gff_path") or "").strip()
    ref_index = str(ref_context.get("db_path") or "").strip()
    target_index = str(target_context.get("db_path") or "").strip()

    if not ref_gff:
        raise HTTPException(status_code=400, detail="Reference GFF file not configured")

    anchor_started = time.perf_counter()
    has_ref_index = bool(ref_index and os.path.exists(ref_index))
    has_tgt_index = bool(target_index and os.path.exists(target_index))

    resolved_ref_gene = None
    if has_ref_index:
        resolved_ref_gene = await run_in_threadpool(resolve_gene_anchor, ref_index, ref_gene_id, transcript_id)
    else:
        resolved_ref_gene = await run_in_threadpool(resolve_gene_anchor_gff, ref_gff, ref_gene_id, transcript_id)

    if not resolved_ref_gene:
        raise HTTPException(status_code=400, detail="Reference gene anchor missing or invalid.")

    resolved_target_gene: Optional[str] = None
    if target_gene_id or target_transcript_id:
        if target_gff:
            if has_tgt_index:
                resolved_target_gene = await run_in_threadpool(
                    resolve_gene_anchor, target_index, target_gene_id, target_transcript_id
                )
            else:
                resolved_target_gene = await run_in_threadpool(
                    resolve_gene_anchor_gff, target_gff, target_gene_id, target_transcript_id
                )
    anchor_ms = (time.perf_counter() - anchor_started) * 1000

    # Fast path: return cached result if still fresh.
    _cache_key = (
        str(ref_genome or "reference").strip() or "reference",
        str(target_genome or "target").strip() or "target",
        resolved_ref_gene,
        resolved_target_gene or "",
        window_size,
        bool(use_homology),
    )
    _cached = _neighbourhood_cache.get(_cache_key)
    if _cached:
        _ts, _result = _cached
        if time.time() - _ts < _NEIGHBOURHOOD_CACHE_TTL:
            cached_ref = getattr(_result, "reference_genes", []) or []
            cached_tgt = getattr(_result, "target_genes", []) or []
            all_cached = list(cached_ref) + list(cached_tgt)
            has_genes = len(all_cached) > 0
            has_any_biotype = any(bool((getattr(g, "biotype", "") or "").strip()) for g in all_cached)
            if (not has_genes) or has_any_biotype:
                logger.info(
                    "Neighbourhood cache hit ref=%s target=%s window=%s (anchor %.1fms total %.1fms)",
                    resolved_ref_gene,
                    resolved_target_gene or "",
                    window_size,
                    anchor_ms,
                    (time.perf_counter() - req_started) * 1000,
                )
                return _result

    file_io.log_progress(f"Fetching neighbourhood for {resolved_ref_gene}...")

    ref_started = time.perf_counter()
    if has_ref_index:
        file_io.log_progress("  ✓ Using Reference Index")
        ref_genes, ref_center = await run_in_threadpool(
            get_gene_neighbourhood_index_by_gene,
            ref_index,
            resolved_ref_gene,
            window_size,
        )
    else:
        file_io.log_progress("  Using GFF gene scan (Reference)...")
        ref_genes, ref_center = await run_in_threadpool(
            get_gene_neighbourhood_by_gene,
            ref_gff,
            resolved_ref_gene,
            window_size,
        )
    ref_ms = (time.perf_counter() - ref_started) * 1000

    if not ref_center or not ref_genes:
        raise HTTPException(status_code=400, detail=f"Reference gene anchor '{resolved_ref_gene}' could not be loaded.")

    target_genes: List[GeneSummary] = []
    target_center: Optional[str] = None
    tgt_ms = 0.0
    if resolved_target_gene and target_gff:
        tgt_started = time.perf_counter()
        if has_tgt_index:
            file_io.log_progress("  ✓ Using Target Index")
            target_genes, target_center = await run_in_threadpool(
                get_gene_neighbourhood_index_by_gene,
                target_index,
                resolved_target_gene,
                window_size,
            )
        else:
            file_io.log_progress("  Using GFF gene scan (Target)...")
            target_genes, target_center = await run_in_threadpool(
                get_gene_neighbourhood_by_gene,
                target_gff,
                resolved_target_gene,
                window_size,
            )
        tgt_ms = (time.perf_counter() - tgt_started) * 1000

    link_started = time.perf_counter()
    final_homologies: List[Tuple[str, str]] = []
    if ref_genes and target_genes:
        tgt_by_id = {g.id: g for g in target_genes}
        ref_order = {g.id: idx for idx, g in enumerate(sorted(ref_genes, key=lambda g: g.start))}
        tgt_order = {g.id: idx for idx, g in enumerate(sorted(target_genes, key=lambda g: g.start))}
        used_ref_ids: Set[str] = set()
        used_tgt_ids: Set[str] = set()
        seen_pairs: Set[Tuple[str, str]] = set()

        def add_pair(ref_id: str, tgt_id: str) -> bool:
            if not ref_id or not tgt_id:
                return False
            if ref_id in used_ref_ids or tgt_id in used_tgt_ids:
                return False
            pair = (ref_id, tgt_id)
            if pair in seen_pairs:
                return False
            final_homologies.append(pair)
            seen_pairs.add(pair)
            used_ref_ids.add(ref_id)
            used_tgt_ids.add(tgt_id)
            return True

        def normalized_symbol(gene: GeneSummary) -> str:
            return (gene.name or "").strip().lower()

        def pair_group_by_neighbourhood(ref_candidates: List[GeneSummary], tgt_candidates: List[GeneSummary]):
            remaining_tgts = sorted(tgt_candidates, key=lambda g: tgt_order.get(g.id, 10**9))
            for r_gene in sorted(ref_candidates, key=lambda g: ref_order.get(g.id, 10**9)):
                if r_gene.id in used_ref_ids:
                    continue
                if not remaining_tgts:
                    break
                r_idx = ref_order.get(r_gene.id, 0)
                best_idx = min(
                    range(len(remaining_tgts)),
                    key=lambda idx: abs(r_idx - tgt_order.get(remaining_tgts[idx].id, 0))
                )
                best_tgt = remaining_tgts.pop(best_idx)
                add_pair(r_gene.id, best_tgt.id)

        # Priority 1: exact gene ID matches.
        for r_gene in sorted(ref_genes, key=lambda g: ref_order.get(g.id, 10**9)):
            if r_gene.id in tgt_by_id:
                add_pair(r_gene.id, r_gene.id)

        # Priority 2: symbol matches with neighbourhood-order disambiguation.
        ref_symbol_groups: Dict[str, List[GeneSummary]] = {}
        tgt_symbol_groups: Dict[str, List[GeneSummary]] = {}
        for g in ref_genes:
            if g.id in used_ref_ids:
                continue
            sym = normalized_symbol(g)
            if sym:
                ref_symbol_groups.setdefault(sym, []).append(g)
        for g in target_genes:
            if g.id in used_tgt_ids:
                continue
            sym = normalized_symbol(g)
            if sym:
                tgt_symbol_groups.setdefault(sym, []).append(g)

        shared_symbols = set(ref_symbol_groups.keys()) & set(tgt_symbol_groups.keys())
        for sym in sorted(shared_symbols):
            refs = ref_symbol_groups[sym]
            tgts = tgt_symbol_groups[sym]
            if len(refs) == 1 and len(tgts) == 1:
                add_pair(refs[0].id, tgts[0].id)
        for sym in sorted(shared_symbols):
            refs = [g for g in ref_symbol_groups[sym] if g.id not in used_ref_ids]
            tgts = [g for g in tgt_symbol_groups[sym] if g.id not in used_tgt_ids]
            if refs and tgts:
                pair_group_by_neighbourhood(refs, tgts)

        if not final_homologies and ref_center and target_center:
            final_homologies.append((ref_center, target_center))
    link_ms = (time.perf_counter() - link_started) * 1000

    homology_links: List[HomologyLink] = []
    ref_homology_available = False
    target_homology_available = False
    if use_homology and ref_genes and target_genes:
        homology_started = time.perf_counter()

        ref_species_info = ref_context.get("species") or {}
        target_species_info = target_context.get("species") or {}
        ref_homology_path = str((ref_species_info.get("files") or {}).get("homology") or "").strip()
        target_homology_path = str((target_species_info.get("files") or {}).get("homology") or "").strip()
        ref_assembly_name = str(ref_species_info.get("assembly_name") or ref_species_info.get("assembly") or "").strip()
        target_assembly_name = str(target_species_info.get("assembly_name") or target_species_info.get("assembly") or "").strip()

        ref_homology_available = bool(ref_homology_path and os.path.exists(ref_homology_path))
        target_homology_available = bool(target_homology_path and os.path.exists(target_homology_path))

        ref_gene_id_set = {g.id for g in ref_genes}
        target_gene_id_set = {g.id for g in target_genes}
        merged_links: Dict[Tuple[str, str], Dict[str, Any]] = {}

        def merge_homology_row(ref_id: str, target_id: str, homology_type: str, perc_id: Any, perc_cov: Any):
            if ref_id not in ref_gene_id_set or target_id not in target_gene_id_set:
                return
            key = (ref_id, target_id)
            is_rbh = str(homology_type or "").strip().lower() == "homolog_rbbh"
            existing = merged_links.get(key)
            if existing is None:
                merged_links[key] = {
                    "ref_gene_id": ref_id,
                    "target_gene_id": target_id,
                    "homology_type": homology_type or "",
                    "is_rbh": is_rbh,
                    "perc_id": routes.homology._parse_optional_float(perc_id),
                    "perc_cov": routes.homology._parse_optional_float(perc_cov),
                }
            elif is_rbh and not existing["is_rbh"]:
                existing["is_rbh"] = True
                existing["homology_type"] = homology_type or existing["homology_type"]

        if ref_homology_available and target_assembly_name:
            ref_rows = await run_in_threadpool(
                routes.homology.homology_file_index.find_homology_pairs,
                ref_homology_path,
                ref_gene_id_set,
                target_assembly_name,
            )
            for row in ref_rows:
                merge_homology_row(
                    row["query_gene_id"],
                    row["ref_gene_stable_id"],
                    row.get("homology_type", ""),
                    row.get("query_perc_id"),
                    row.get("query_perc_cov"),
                )

        if target_homology_available and ref_assembly_name:
            target_rows = await run_in_threadpool(
                routes.homology.homology_file_index.find_homology_pairs,
                target_homology_path,
                target_gene_id_set,
                ref_assembly_name,
            )
            for row in target_rows:
                merge_homology_row(
                    row["ref_gene_stable_id"],
                    row["query_gene_id"],
                    row.get("homology_type", ""),
                    row.get("query_perc_id"),
                    row.get("query_perc_cov"),
                )

        homology_links = [HomologyLink(**link) for link in merged_links.values()]
        homology_ms = (time.perf_counter() - homology_started) * 1000
        file_io.log_progress(
            f"  Homology links: {len(homology_links)} (ref_available={ref_homology_available} "
            f"target_available={target_homology_available}, {homology_ms:.1f}ms)"
        )

    result = NeighbourhoodResponse(
        reference_genes=ref_genes,
        target_genes=target_genes,
        center_ref_id=ref_center,
        center_target_id=target_center,
        homologies=final_homologies,
        homology_links=homology_links,
        ref_homology_available=ref_homology_available,
        target_homology_available=target_homology_available,
        request_transcript_id=transcript_id,
        request_target_transcript_id=target_transcript_id,
        request_ref_gene_id=resolved_ref_gene,
        request_target_gene_id=resolved_target_gene,
    )
    _neighbourhood_cache[_cache_key] = (time.time(), result)

    total_ms = (time.perf_counter() - req_started) * 1000
    logger.info(
        "Neighbourhood timings ref=%s target=%s window=%s anchor=%.1fms ref=%.1fms target=%.1fms links=%.1fms total=%.1fms",
        resolved_ref_gene,
        resolved_target_gene or "",
        window_size,
        anchor_ms,
        ref_ms,
        tgt_ms,
        link_ms,
        total_ms,
    )
    return result


class HomologyAnchorHit(BaseModel):
    gene_id: str
    gene_name: str = ""
    homology_type: str = ""
    is_rbh: bool = False
    perc_id: Optional[float] = None
    perc_cov: Optional[float] = None


class HomologyAnchorResponse(BaseModel):
    primary_homology_available: bool = False
    hits: Dict[str, Optional[HomologyAnchorHit]] = {}


@router.get("/api/neighbourhood/homology_anchor", response_model=HomologyAnchorResponse)
async def get_neighbourhood_homology_anchor(
    genome: str,
    gene_id: str,
    target_genomes: str = "",
):
    """Given a focus gene already chosen in one genome, find its single best homology
    hit (by RBH preference, then identity/coverage) in each of several other genomes —
    used to auto-populate Neighbourhood View tracks that don't yet have a focus gene."""
    gid = str(gene_id or "").strip()
    if not gid:
        raise HTTPException(status_code=400, detail="gene_id is required")

    primary_context = genome_context._resolve_browse_genome_context(genome)
    primary_species = primary_context.get("species") or {}
    primary_homology_path = str((primary_species.get("files") or {}).get("homology") or "").strip()
    primary_available = bool(primary_homology_path and os.path.exists(primary_homology_path))

    target_keys = [t.strip() for t in str(target_genomes or "").split(",") if t.strip()]
    hits: Dict[str, Optional[HomologyAnchorHit]] = {key: None for key in target_keys}

    if primary_available:
        for target_key in target_keys:
            target_context = genome_context._resolve_browse_genome_context(target_key)
            target_species = target_context.get("species") or {}
            target_assembly_name = str(target_species.get("assembly_name") or target_species.get("assembly") or "").strip()
            if not target_assembly_name:
                continue
            rows = await run_in_threadpool(
                routes.homology.homology_file_index.find_homology_pairs,
                primary_homology_path,
                {gid},
                target_assembly_name,
            )
            if not rows:
                continue
            best = max(rows, key=routes.homology._homology_row_score)
            hits[target_key] = HomologyAnchorHit(
                gene_id=best.get("ref_gene_stable_id", ""),
                gene_name=best.get("ref_gene_name", ""),
                homology_type=best.get("homology_type", ""),
                is_rbh=str(best.get("homology_type", "")).strip().lower() == "homolog_rbbh",
                perc_id=routes.homology._parse_optional_float(best.get("query_perc_id")),
                perc_cov=routes.homology._parse_optional_float(best.get("query_perc_cov")),
            )

    return HomologyAnchorResponse(primary_homology_available=primary_available, hits=hits)
