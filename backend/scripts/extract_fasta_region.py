#!/usr/bin/env python3
"""
Extract a sequence interval from a FASTA file.

Examples:
  python3 extract_fasta_region.py --fasta /path/genome.fa --region 1:11960000-11960005
  python3 extract_fasta_region.py --fasta /path/genome.fa --region 1:11960000-1:11960005
"""

from __future__ import annotations

import argparse
import gzip
import re
import sys
from pathlib import Path
from typing import Dict, Iterable, Optional, Tuple

import pysam


_REGION_SIMPLE = re.compile(r"^([^:\s]+)\s*:\s*([\d,\s]+)\s*-\s*([\d,\s]+)$")
_REGION_REPEAT_CHROM = re.compile(r"^([^:\s]+)\s*:\s*([\d,\s]+)\s*-\s*([^:\s]+)\s*:\s*([\d,\s]+)$")


def _normalize_chrom(chrom: str) -> str:
    text = str(chrom or "").strip()
    lower = text.lower()
    if lower.startswith("chr"):
        return lower[3:]
    return lower


def _parse_int(token: str) -> int:
    return int(str(token).replace(",", "").strip())


def parse_region(region: str) -> Tuple[str, int, int]:
    text = (region or "").strip().replace("–", "-").replace("—", "-")
    m2 = _REGION_REPEAT_CHROM.match(text)
    if m2:
        chrom_a = m2.group(1).strip()
        chrom_b = m2.group(3).strip()
        if _normalize_chrom(chrom_a) != _normalize_chrom(chrom_b):
            raise ValueError(f"Region chromosomes differ: {chrom_a} vs {chrom_b}")
        start = _parse_int(m2.group(2))
        end = _parse_int(m2.group(4))
        if end < start:
            raise ValueError("Region end must be >= start.")
        return chrom_a, start, end

    m1 = _REGION_SIMPLE.match(text)
    if not m1:
        raise ValueError(f"Invalid region format: {region!r}. Expected CHR:START-END")
    chrom = m1.group(1).strip()
    start = _parse_int(m1.group(2))
    end = _parse_int(m1.group(3))
    if end < start:
        raise ValueError("Region end must be >= start.")
    return chrom, start, end


def _chrom_aliases(chrom: str) -> Iterable[str]:
    raw = str(chrom or "").strip()
    if not raw:
        return []
    aliases = [raw]
    if raw.lower().startswith("chr"):
        aliases.append(raw[3:])
    else:
        aliases.append(f"chr{raw}")
    return aliases


def _resolve_chrom(requested: str, available: Iterable[str]) -> Optional[str]:
    available_list = list(available)
    available_set = set(available_list)
    for alias in _chrom_aliases(requested):
        if alias in available_set:
            return alias

    req_norm = _normalize_chrom(requested)
    for name in available_list:
        if _normalize_chrom(name) == req_norm:
            return name
    return None


def _open_maybe_gzip(path: Path):
    if str(path).lower().endswith(".gz"):
        return gzip.open(path, "rt", encoding="utf-8")
    return path.open("r", encoding="utf-8")


def _fetch_plain_fasta(path: Path, chrom: str, start_1based: int, end_1based: int) -> str:
    aliases = {_normalize_chrom(a) for a in _chrom_aliases(chrom)}
    current_name: Optional[str] = None
    seq_chunks = []

    with _open_maybe_gzip(path) as handle:
        for raw in handle:
            line = raw.strip()
            if not line:
                continue
            if line.startswith(">"):
                header = line[1:].strip()
                current_name = header.split()[0] if header else ""
                continue
            if current_name and _normalize_chrom(current_name) in aliases:
                seq_chunks.append(line)

    if not seq_chunks:
        raise RuntimeError(f"Chromosome {chrom!r} not found in FASTA.")
    seq = "".join(seq_chunks).upper()
    if start_1based < 1 or end_1based > len(seq):
        raise RuntimeError(
            f"Requested region {chrom}:{start_1based}-{end_1based} exceeds sequence length {len(seq)}."
        )
    return seq[start_1based - 1 : end_1based]


def extract_sequence(fasta_path: Path, chrom: str, start_1based: int, end_1based: int) -> str:
    try:
        fa = pysam.FastaFile(str(fasta_path))
    except Exception:
        # Index unavailable or FASTA unsupported by pysam; fallback to text parser.
        return _fetch_plain_fasta(fasta_path, chrom, start_1based, end_1based)

    try:
        resolved = _resolve_chrom(chrom, fa.references)
        if not resolved:
            available = ", ".join(fa.references[:8])
            suffix = "..." if len(fa.references) > 8 else ""
            raise RuntimeError(
                f"Chromosome {chrom!r} not found in FASTA index. Available: {available}{suffix}"
            )
        seq = fa.fetch(resolved, start_1based - 1, end_1based).upper()
        if not seq:
            raise RuntimeError(f"No sequence returned for {resolved}:{start_1based}-{end_1based}")
        return seq
    finally:
        fa.close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract sequence for a genomic interval from a FASTA file.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--fasta", required=True, help="Path to FASTA file.")
    parser.add_argument(
        "--region",
        required=True,
        help="Genomic interval (e.g. 1:11960000-11960005 or 1:11960000-1:11960005).",
    )
    parser.add_argument(
        "--with-header",
        action="store_true",
        help="Print FASTA-style header line before sequence.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    fasta_path = Path(args.fasta)
    if not fasta_path.exists():
        print(f"ERROR: FASTA file not found: {fasta_path}", file=sys.stderr)
        return 1

    try:
        chrom, start_1based, end_1based = parse_region(args.region)
        if start_1based < 1:
            raise ValueError("Region start must be >= 1.")
        seq = extract_sequence(fasta_path, chrom, start_1based, end_1based)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    if args.with_header:
        print(f">{chrom}:{start_1based}-{end_1based}")
    print(seq)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

