#!/usr/bin/env python3
"""Inspect BigChain .bb files over a reference interval.

This helper prints coarse chain blocks (ref->target) overlapping a reference
window, e.g. "1:1000000-1005000".

Notes:
- BigChain stores chain-level blocks, not base-by-base alignments.
- For nucleotide-level detail, you typically need chain/bigChainLink-level data.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

try:
    import pyBigWig  # type: ignore
except Exception:
    pyBigWig = None


UUID_RE = re.compile(
    r"[0-9a-fA-F]{8}-"
    r"[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{12}"
)


@dataclass
class MappingInfo:
    path: Path
    genome_name: str
    assembly_uuid: str
    hal_to_assembly: Dict[str, str]
    assembly_to_hal: Dict[str, str]
    alias_to_assembly: Dict[str, str]


def _normalize_chrom_token(token: str) -> str:
    t = (token or "").strip()
    if t.lower().startswith("chr"):
        t = t[3:]
    upper = t.upper()
    if upper in {"M", "MT", "CHRM", "CHRMT"}:
        return "MT"
    return upper


def _sv_aliases_for_sequence(token: str) -> List[str]:
    t = (token or "").strip()
    if not t:
        return []
    out = {t, t.lower(), t.upper()}
    if t.lower().startswith("chr") and len(t) > 3:
        out.add(t[3:])
    else:
        out.add(f"chr{t}")
    return [v for v in out if v]


def _resolve_bigwig_chrom_name(requested_chrom: str, chrom_sizes: Dict[str, int]) -> Optional[str]:
    if requested_chrom in chrom_sizes:
        return requested_chrom

    if requested_chrom.startswith("chr"):
        alt = requested_chrom[3:]
        if alt in chrom_sizes:
            return alt
    else:
        alt = f"chr{requested_chrom}"
        if alt in chrom_sizes:
            return alt

    mt_alts = {
        "MT": ["chrM", "M", "chrMT"],
        "chrM": ["MT", "M", "chrMT"],
        "M": ["MT", "chrM", "chrMT"],
        "chrMT": ["MT", "chrM", "M"],
    }
    for alt_name in mt_alts.get(requested_chrom, []):
        if alt_name in chrom_sizes:
            return alt_name

    req_lower = requested_chrom.lower()
    for key in chrom_sizes.keys():
        if key.lower() == req_lower:
            return key

    req_norm = _normalize_chrom_token(requested_chrom)
    token_matches: List[str] = []
    for key in chrom_sizes.keys():
        parts = key.split(":")
        if len(parts) >= 3 and _normalize_chrom_token(parts[2]) == req_norm:
            token_matches.append(key)
    if token_matches:
        token_matches.sort(key=lambda k: (0 if k.startswith("chromosome:") else 1, len(k)))
        return token_matches[0]

    return None


def _parse_region(region: str) -> Tuple[str, int, int]:
    text = (region or "").strip().replace("–", "-").replace("—", "-")
    m = re.match(r"^([^:\s]+)\s*:\s*([\d,\s]+)\s*-\s*([\d,\s]+)$", text)
    if not m:
        raise ValueError(f"Invalid region format: {region!r}. Expected CHR:START-END")
    chrom = m.group(1).strip()
    start = int(m.group(2).replace(",", "").strip())
    end = int(m.group(3).replace(",", "").strip())
    if end <= start:
        raise ValueError("Region end must be greater than start.")
    return chrom, max(0, start), max(1, end)


def _parse_bigchain_entry_rest(rest: str) -> Optional[Dict[str, Any]]:
    parts = (rest or "").split("\t")
    if len(parts) < 8:
        return None
    try:
        q_size = int(parts[3])
        ref_size = int(parts[5])
        ref_start = int(parts[6])
        ref_end = int(parts[7])
    except Exception:
        return None
    return {
        "chain_id": parts[0],
        "score": int(parts[1]) if parts[1].isdigit() else 0,
        "strand": parts[2] if parts[2] in {"+", "-"} else "+",
        "q_size": q_size,
        "ref_seq": parts[4],
        "ref_size": ref_size,
        "ref_start": ref_start,
        "ref_end": ref_end,
        "level": int(parts[8]) if len(parts) >= 9 and parts[8].isdigit() else 0,
    }


def _classify_sv_block(strand: str, target_span: int, ref_span: int) -> str:
    if strand == "-":
        return "inverted_match"
    ratio = float(target_span) / max(1.0, float(ref_span))
    if ratio > 1.2:
        return "gain_or_insertion"
    if ratio < 0.8:
        return "deletion_or_loss"
    return "match"


def _load_mapping(path: Path) -> MappingInfo:
    hal_to_assembly: Dict[str, str] = {}
    assembly_to_hal: Dict[str, str] = {}
    alias_to_assembly: Dict[str, str] = {}
    genome_name = ""
    assembly_uuid = ""

    with path.open("r", encoding="utf-8") as handle:
        reader = csv.DictReader(handle, delimiter="\t")
        for row in reader:
            hal_seq = (row.get("hal_sequence_name") or "").strip()
            assembly_seq = (row.get("assembly_sequence") or "").strip()
            genome_name = (row.get("hal_genome_name") or genome_name).strip()
            assembly_uuid = (row.get("assembly_uuid") or assembly_uuid).strip()
            if not hal_seq or not assembly_seq:
                continue
            hal_to_assembly[hal_seq] = assembly_seq
            assembly_to_hal.setdefault(assembly_seq, hal_seq)
            for alias in _sv_aliases_for_sequence(hal_seq) + _sv_aliases_for_sequence(assembly_seq):
                alias_to_assembly[alias.lower()] = assembly_seq

    return MappingInfo(
        path=path,
        genome_name=genome_name or path.stem,
        assembly_uuid=assembly_uuid,
        hal_to_assembly=hal_to_assembly,
        assembly_to_hal=assembly_to_hal,
        alias_to_assembly=alias_to_assembly,
    )


def _resolve_sequence(mapping: Optional[MappingInfo], token: str) -> Optional[str]:
    if mapping is None:
        return None
    t = (token or "").strip()
    if not t:
        return None
    if t in mapping.assembly_to_hal:
        return t
    if t in mapping.hal_to_assembly:
        return mapping.hal_to_assembly[t]
    return mapping.alias_to_assembly.get(t.lower())


def _sequence_equivalent(seq_a: str, seq_b: str, mapping: Optional[MappingInfo]) -> bool:
    if seq_a == seq_b:
        return True
    if _normalize_chrom_token(seq_a) == _normalize_chrom_token(seq_b):
        return True
    if mapping is None:
        return False
    a_to_assembly = mapping.hal_to_assembly.get(seq_a)
    b_to_assembly = mapping.hal_to_assembly.get(seq_b)
    if a_to_assembly and a_to_assembly == seq_b:
        return True
    if b_to_assembly and b_to_assembly == seq_a:
        return True
    if a_to_assembly and b_to_assembly and a_to_assembly == b_to_assembly:
        return True
    return False


def _discover_mapping_files(data_dir: Path) -> List[MappingInfo]:
    infos: List[MappingInfo] = []
    for p in sorted(data_dir.glob("*.hal_mapping.tsv")):
        try:
            infos.append(_load_mapping(p))
        except Exception as e:
            print(f"[warn] Failed to parse mapping file {p}: {e}", file=sys.stderr)
    return infos


def _auto_pick_bigchain(data_dir: Path) -> Path:
    candidates = sorted(data_dir.glob("*.bigChain.bb"))
    if not candidates:
        raise FileNotFoundError(f"No .bigChain.bb files found in {data_dir}")
    if len(candidates) > 1:
        joined = "\n  - ".join(str(p) for p in candidates)
        raise ValueError(
            "Multiple .bigChain.bb files found. Pass --bigchain explicitly.\n"
            f"  - {joined}"
        )
    return candidates[0]


def _guess_side_from_filename(bigchain_path: Path) -> Optional[str]:
    name = bigchain_path.name.lower()
    if name.startswith("alt_") and "_to_ref_" in name:
        return "target"
    if name.startswith("ref_") and "_to_alt_" in name:
        return "reference"
    return None


def _auto_pick_maps_from_filename(
    bigchain_path: Path,
    mapping_infos: Sequence[MappingInfo],
) -> Tuple[Optional[MappingInfo], Optional[MappingInfo]]:
    by_uuid = {m.assembly_uuid.lower(): m for m in mapping_infos if m.assembly_uuid}
    name = bigchain_path.name.lower()
    m_alt_ref = re.search(r"alt_([0-9a-f-]+)_to_ref_([0-9a-f-]+)", name)
    if m_alt_ref:
        tgt_uuid = m_alt_ref.group(1).lower()
        ref_uuid = m_alt_ref.group(2).lower()
        return by_uuid.get(ref_uuid), by_uuid.get(tgt_uuid)
    m_ref_alt = re.search(r"ref_([0-9a-f-]+)_to_alt_([0-9a-f-]+)", name)
    if m_ref_alt:
        ref_uuid = m_ref_alt.group(1).lower()
        tgt_uuid = m_ref_alt.group(2).lower()
        return by_uuid.get(ref_uuid), by_uuid.get(tgt_uuid)
    return None, None


def _format_bp(n: int) -> str:
    return f"{int(n):,}"


def _render_ref_overview(blocks: Sequence[Dict[str, Any]], ref_start: int, ref_end: int, width: int = 90) -> str:
    if ref_end <= ref_start:
        return ""
    width = max(20, width)
    chars = [" "] * width
    span = max(1, ref_end - ref_start)
    t_char = {
        "match": "=",
        "inverted_match": "~",
        "gain_or_insertion": "+",
        "deletion_or_loss": "-",
    }
    for b in blocks:
        x1 = max(ref_start, int(b["ref_start"]))
        x2 = min(ref_end, int(b["ref_end"]))
        if x2 <= x1:
            continue
        c = t_char.get(str(b.get("type") or "match"), "=")
        p1 = int((x1 - ref_start) * width / span)
        p2 = int((x2 - ref_start) * width / span)
        if p2 <= p1:
            p2 = min(width, p1 + 1)
        for i in range(max(0, p1), min(width, p2)):
            if chars[i] == " ":
                chars[i] = c
            elif chars[i] != c:
                chars[i] = "#"
    return "".join(chars)


def _blocks_from_entries(
    entries: Iterable[Tuple[int, int, str]],
    indexed_side: str,
    ref_seq: str,
    tgt_seq: str,
    ref_window_start: int,
    ref_window_end: int,
    ref_mapping: Optional[MappingInfo],
    tgt_mapping: Optional[MappingInfo],
) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for chrom_start, chrom_end, rest in entries:
        parsed = _parse_bigchain_entry_rest(rest)
        if not parsed:
            continue

        if indexed_side == "reference":
            if not _sequence_equivalent(str(parsed["ref_seq"]), str(tgt_seq), tgt_mapping):
                continue
            ref_block_start = int(chrom_start)
            ref_block_end = int(chrom_end)
            tgt_block_start = int(parsed["ref_start"])
            tgt_block_end = int(parsed["ref_end"])
        else:
            if not _sequence_equivalent(str(parsed["ref_seq"]), str(ref_seq), ref_mapping):
                continue
            ref_block_start = int(parsed["ref_start"])
            ref_block_end = int(parsed["ref_end"])
            tgt_block_start = int(chrom_start)
            tgt_block_end = int(chrom_end)

        if ref_block_end < ref_block_start:
            ref_block_start, ref_block_end = ref_block_end, ref_block_start
        if tgt_block_end < tgt_block_start:
            tgt_block_start, tgt_block_end = tgt_block_end, tgt_block_start

        if ref_block_end < ref_window_start or ref_block_start > ref_window_end:
            continue

        tgt_span = max(1, tgt_block_end - tgt_block_start)
        ref_span = max(1, ref_block_end - ref_block_start)
        block_type = _classify_sv_block(str(parsed["strand"]), tgt_span, ref_span)
        out.append(
            {
                "chain_id": str(parsed["chain_id"]),
                "score": int(parsed["score"]),
                "strand": str(parsed["strand"]),
                "type": block_type,
                "ref_start": int(ref_block_start),
                "ref_end": int(ref_block_end),
                "tgt_start": int(tgt_block_start),
                "tgt_end": int(tgt_block_end),
                "ref_span": int(ref_span),
                "tgt_span": int(tgt_span),
            }
        )
    out.sort(key=lambda b: (int(b["ref_start"]), int(b["tgt_start"])))
    return out


def _dedup_blocks(blocks: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    seen = set()
    out = []
    for b in blocks:
        key = (
            b["chain_id"],
            b["strand"],
            int(b["ref_start"]),
            int(b["ref_end"]),
            int(b["tgt_start"]),
            int(b["tgt_end"]),
        )
        if key in seen:
            continue
        seen.add(key)
        out.append(dict(b))
    return out


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Inspect BigChain blocks for a reference interval.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--region", required=True, help="Reference region, e.g. 1:1000000-1005000")
    parser.add_argument("--bigchain", default="", help="Path to .bigChain.bb file")
    parser.add_argument(
        "--data-dir",
        default=os.environ.get("ENSEMBL_GO_SV_TEST_DATA_DIR", ""),
        help="Directory with .bigChain.bb and mapping TSVs "
             "(defaults to $ENSEMBL_GO_SV_TEST_DATA_DIR)",
    )
    parser.add_argument("--reference-map", default="", help="Reference mapping TSV (*.hal_mapping.tsv)")
    parser.add_argument("--target-map", default="", help="Target mapping TSV (*.hal_mapping.tsv)")
    parser.add_argument("--target-chrom", default="", help="Optional target chromosome token (defaults to same token as reference)")
    parser.add_argument("--indexed-side", choices=["auto", "reference", "target"], default="auto", help="Which side is indexed in BigChain BED coordinates")
    parser.add_argument("--max-blocks", type=int, default=300, help="Max rows to print")
    parser.add_argument("--fast", action="store_true", help="Skip full-chrom fallback scan when indexed side is target")
    parser.add_argument("--json-out", default="", help="Optional path to write full result JSON")
    args = parser.parse_args()

    if pyBigWig is None:
        print("pyBigWig is not available. Install it in this environment first.", file=sys.stderr)
        return 2

    try:
        ref_chrom_token, ref_start, ref_end = _parse_region(args.region)
    except Exception as e:
        print(f"[error] {e}", file=sys.stderr)
        return 2

    data_dir = Path(args.data_dir).expanduser()
    bigchain_path = Path(args.bigchain).expanduser() if args.bigchain else _auto_pick_bigchain(data_dir)
    if not bigchain_path.exists():
        print(f"[error] BigChain file not found: {bigchain_path}", file=sys.stderr)
        return 2

    mapping_infos = _discover_mapping_files(data_dir) if data_dir.exists() else []
    ref_map: Optional[MappingInfo] = _load_mapping(Path(args.reference_map).expanduser()) if args.reference_map else None
    tgt_map: Optional[MappingInfo] = _load_mapping(Path(args.target_map).expanduser()) if args.target_map else None

    auto_ref_map, auto_tgt_map = _auto_pick_maps_from_filename(bigchain_path, mapping_infos)
    if ref_map is None:
        ref_map = auto_ref_map
    if tgt_map is None:
        tgt_map = auto_tgt_map

    side = args.indexed_side
    if side == "auto":
        side = _guess_side_from_filename(bigchain_path) or "target"

    ref_seq = _resolve_sequence(ref_map, ref_chrom_token) or ref_chrom_token
    target_token = args.target_chrom.strip() or ref_chrom_token
    tgt_seq = _resolve_sequence(tgt_map, target_token) or target_token

    bw = pyBigWig.open(str(bigchain_path))
    if bw is None:
        print(f"[error] Could not open BigChain file: {bigchain_path}", file=sys.stderr)
        return 2

    try:
        chrom_sizes = bw.chroms() or {}
        chain_lookup_seq = ref_seq if side == "reference" else tgt_seq
        chain_chrom = _resolve_bigwig_chrom_name(chain_lookup_seq, chrom_sizes)
        if not chain_chrom:
            fallback_token = ref_chrom_token if side == "reference" else target_token
            chain_chrom = _resolve_bigwig_chrom_name(fallback_token, chrom_sizes)
        if not chain_chrom:
            print(
                f"[error] Could not resolve indexed chromosome name for '{chain_lookup_seq}' in {bigchain_path.name}.",
                file=sys.stderr,
            )
            return 2

        chain_len = int(chrom_sizes.get(chain_chrom, 0))
        if chain_len <= 0:
            print(f"[error] Invalid chromosome length for {chain_chrom!r}.", file=sys.stderr)
            return 2

        ranges: List[Tuple[int, int]] = []
        if side == "reference":
            ranges.append((max(0, ref_start), min(chain_len, ref_end)))
        else:
            span = max(1, ref_end - ref_start)
            center_guess = (ref_start + ref_end) // 2
            pad = max(250_000, int(span * 2.0))
            ranges.append((max(0, center_guess - pad), min(chain_len, center_guess + pad)))
            if not args.fast:
                ranges.append((0, chain_len))

        all_blocks: List[Dict[str, Any]] = []
        entries_scanned = 0
        for q_start, q_end in ranges:
            if q_end <= q_start:
                continue
            entries = bw.entries(chain_chrom, int(q_start), int(q_end)) or []
            entries_scanned += len(entries)
            blocks = _blocks_from_entries(
                entries=entries,
                indexed_side=side,
                ref_seq=ref_seq,
                tgt_seq=tgt_seq,
                ref_window_start=ref_start,
                ref_window_end=ref_end,
                ref_mapping=ref_map,
                tgt_mapping=tgt_map,
            )
            all_blocks.extend(blocks)
            if blocks and side == "reference":
                break
            if blocks and side == "target" and args.fast:
                break

        all_blocks = _dedup_blocks(all_blocks)
        if len(all_blocks) > max(1, args.max_blocks):
            all_blocks = all_blocks[: max(1, args.max_blocks)]

        type_counts: Dict[str, int] = {}
        for b in all_blocks:
            t = str(b.get("type") or "match")
            type_counts[t] = type_counts.get(t, 0) + 1

        print(f"BigChain file: {bigchain_path}")
        print(f"Indexed side:  {side}")
        print(f"Ref region:    {ref_chrom_token}:{_format_bp(ref_start)}-{_format_bp(ref_end)}")
        print(f"Resolved ref:  {ref_seq}")
        print(f"Resolved tgt:  {tgt_seq}")
        print(f"Chain chrom:   {chain_chrom} (len={_format_bp(chain_len)})")
        if ref_map:
            print(f"Ref map:       {ref_map.path.name} ({ref_map.genome_name})")
        if tgt_map:
            print(f"Tgt map:       {tgt_map.path.name} ({tgt_map.genome_name})")
        print(f"Entries read:  {_format_bp(entries_scanned)}")
        print(f"Blocks kept:   {_format_bp(len(all_blocks))}")
        if type_counts:
            counts_text = ", ".join(f"{k}={v}" for k, v in sorted(type_counts.items()))
            print(f"Block types:   {counts_text}")
        print("")

        overview = _render_ref_overview(all_blocks, ref_start, ref_end, width=96)
        if overview.strip():
            print("Ref-window overview (= match, ~ inversion, + gain/ins, - del/loss, # overlap-mix):")
            print(f"|{overview}|")
            print("")

        if not all_blocks:
            if side == "target" and args.fast:
                print("No overlapping blocks found. Re-run without --fast to include full-chrom fallback scan.")
            else:
                print("No overlapping blocks found for this reference window.")
            return 0

        header = (
            f"{'#':>4}  {'chain':>8}  {'score':>6}  {'str':>3}  {'type':<18}  "
            f"{'reference':<27}  {'target':<27}"
        )
        print(header)
        print("-" * len(header))
        for i, b in enumerate(all_blocks, start=1):
            ref_label = f"{ref_seq}:{_format_bp(b['ref_start'])}-{_format_bp(b['ref_end'])} ({_format_bp(b['ref_span'])})"
            tgt_label = f"{tgt_seq}:{_format_bp(b['tgt_start'])}-{_format_bp(b['tgt_end'])} ({_format_bp(b['tgt_span'])})"
            print(
                f"{i:4d}  {str(b['chain_id'])[:8]:>8}  {int(b['score']):6d}  "
                f"{str(b['strand']):>3}  {str(b['type']):<18}  "
                f"{ref_label:<27}  {tgt_label:<27}"
            )

        if args.json_out:
            out_path = Path(args.json_out).expanduser()
            out_payload = {
                "bigchain": str(bigchain_path),
                "indexed_side": side,
                "reference_region": {
                    "chrom": ref_chrom_token,
                    "start": ref_start,
                    "end": ref_end,
                    "resolved_ref_seq": ref_seq,
                },
                "resolved_target_seq": tgt_seq,
                "chain_chrom": chain_chrom,
                "entries_scanned": entries_scanned,
                "blocks": all_blocks,
            }
            out_path.write_text(json.dumps(out_payload, indent=2), encoding="utf-8")
            print(f"\nWrote JSON: {out_path}")
    finally:
        try:
            bw.close()
        except Exception:
            pass

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
