#!/usr/bin/env python3
"""
View VCF entries overlapping a genomic interval.

Examples:
  python3 view_vcf_region.py --vcf /path/variants.vcf.gz --region 1:11960000-11960005
  python3 view_vcf_region.py --vcf /path/variants.vcf --region 1:11960000-1:11960005 --show-header
"""

from __future__ import annotations

import argparse
import gzip
import re
import sys
from contextlib import contextmanager
from pathlib import Path
from typing import Iterable, Iterator, List, Optional, Tuple

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
    repeated = _REGION_REPEAT_CHROM.match(text)
    if repeated:
        chrom_a = repeated.group(1).strip()
        chrom_b = repeated.group(3).strip()
        if _normalize_chrom(chrom_a) != _normalize_chrom(chrom_b):
            raise ValueError(f"Region chromosomes differ: {chrom_a} vs {chrom_b}")
        start = _parse_int(repeated.group(2))
        end = _parse_int(repeated.group(4))
        if end < start:
            raise ValueError("Region end must be >= start.")
        return chrom_a, start, end

    simple = _REGION_SIMPLE.match(text)
    if not simple:
        raise ValueError(f"Invalid region format: {region!r}. Expected CHR:START-END")
    chrom = simple.group(1).strip()
    start = _parse_int(simple.group(2))
    end = _parse_int(simple.group(3))
    if end < start:
        raise ValueError("Region end must be >= start.")
    return chrom, start, end


def _chrom_aliases(chrom: str) -> List[str]:
    raw = str(chrom or "").strip()
    if not raw:
        return []
    aliases = [raw]
    if raw.lower().startswith("chr"):
        aliases.append(raw[3:])
    else:
        aliases.append(f"chr{raw}")
    return aliases


def _resolve_vcf_chrom(handle: pysam.VariantFile, requested: str) -> Optional[str]:
    contigs = list(handle.header.contigs.keys())
    contig_set = set(contigs)
    for alias in _chrom_aliases(requested):
        if alias in contig_set:
            return alias
    req_norm = _normalize_chrom(requested)
    for name in contigs:
        if _normalize_chrom(name) == req_norm:
            return name
    return None


@contextmanager
def _quiet_htslib():
    prev = pysam.set_verbosity(0)
    try:
        yield
    finally:
        pysam.set_verbosity(prev)


def _open_maybe_gzip(path: Path):
    if str(path).lower().endswith(".gz"):
        return gzip.open(path, "rt", encoding="utf-8")
    return path.open("r", encoding="utf-8")


def _record_end_from_fields(pos_1based: int, ref: str, info: str) -> int:
    for field in str(info or "").split(";"):
        if field.startswith("END="):
            try:
                return max(pos_1based, int(field.split("=", 1)[1]))
            except Exception:
                break
    ref_len = max(1, len(ref or ""))
    return pos_1based + ref_len - 1


def _overlaps(start_a: int, end_a: int, start_b: int, end_b: int) -> bool:
    return max(start_a, start_b) <= min(end_a, end_b)


def _iter_plain_vcf_matches(path: Path, chrom: str, start_1based: int, end_1based: int) -> Iterator[str]:
    aliases = {_normalize_chrom(alias) for alias in _chrom_aliases(chrom)}
    with _open_maybe_gzip(path) as handle:
        for raw in handle:
            if not raw or raw.startswith("#"):
                continue
            line = raw.rstrip("\n")
            fields = line.split("\t")
            if len(fields) < 8:
                continue
            rec_chrom = fields[0].strip()
            if _normalize_chrom(rec_chrom) not in aliases:
                continue
            try:
                pos = int(fields[1])
            except Exception:
                continue
            ref = fields[3] if len(fields) > 3 else ""
            info = fields[7] if len(fields) > 7 else ""
            rec_end = _record_end_from_fields(pos, ref, info)
            if _overlaps(pos, rec_end, start_1based, end_1based):
                yield line


def _iter_indexed_vcf_matches(path: Path, chrom: str, start_1based: int, end_1based: int) -> Iterator[str]:
    with _quiet_htslib():
        handle = pysam.VariantFile(str(path))
    try:
        resolved_chrom = _resolve_vcf_chrom(handle, chrom)
        if not resolved_chrom:
            available = ", ".join(list(handle.header.contigs.keys())[:10])
            suffix = "..." if len(handle.header.contigs) > 10 else ""
            raise RuntimeError(f"Chromosome {chrom!r} not found in VCF. Available: {available}{suffix}")
        for rec in handle.fetch(resolved_chrom, start_1based - 1, end_1based):
            rec_start = int(rec.pos)
            ref_len = max(1, len(str(rec.ref or "")))
            rec_end = int(getattr(rec, "stop", rec_start + ref_len - 1))
            if _overlaps(rec_start, rec_end, start_1based, end_1based):
                yield str(rec).rstrip("\n")
    finally:
        handle.close()


def iter_vcf_matches(path: Path, chrom: str, start_1based: int, end_1based: int) -> Iterable[str]:
    try:
        yield from _iter_indexed_vcf_matches(path, chrom, start_1based, end_1based)
        return
    except Exception:
        # Fall back to plain scan for unindexed or plain-text VCF inputs.
        pass
    yield from _iter_plain_vcf_matches(path, chrom, start_1based, end_1based)


def _print_header(path: Path) -> None:
    with _open_maybe_gzip(path) as handle:
        for raw in handle:
            if not raw.startswith("#"):
                break
            sys.stdout.write(raw)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Print VCF entries overlapping a 1-based inclusive genomic interval.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--vcf", required=True, help="Path to .vcf or .vcf.gz file.")
    parser.add_argument(
        "--region",
        required=True,
        help="1-based inclusive region, e.g. 1:11960000-11960005 or 1:11960000-1:11960005.",
    )
    parser.add_argument(
        "--show-header",
        action="store_true",
        help="Print VCF header lines before matching entries.",
    )
    parser.add_argument(
        "--count-only",
        action="store_true",
        help="Print only the number of overlapping entries.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    path = Path(args.vcf)
    if not path.exists():
        print(f"ERROR: VCF file not found: {path}", file=sys.stderr)
        return 1

    try:
        chrom, start_1based, end_1based = parse_region(args.region)
        if start_1based < 1:
            raise ValueError("Region start must be >= 1.")
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    try:
        matches = list(iter_vcf_matches(path, chrom, start_1based, end_1based))
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    if args.count_only:
        print(len(matches))
        return 0

    if args.show_header:
        _print_header(path)
    for line in matches:
        print(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
