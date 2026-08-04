"""Which files may be deleted when a genome is removed.

Kept free of FastAPI, sqlite-of-the-app and pysam imports so the rules can be unit
tested directly; ``main.py`` owns the endpoints and the download-managed side.

The hard case is a manually added genome. Its FASTA and annotation live wherever
the user put them and must never be deleted, but the app writes real data beside
them — a GFF3 index and its lock, ``.fai``/``.gzi``, tabix indexes, a converted
``.ensembl.gff3.gz``, stats caches, and a decompressed copy of a gzipped FASTA
that can run to several GB. Nothing cleans any of that up today.

Every rule here is a whitelist with a proof attached:

* a candidate is only ever *derived* from a registered file (the "seeds"),
* it must then prove it is ours — an index must be SQLite naming this genome's
  GFF as its source, a converted annotation must carry the
  ``#!ensembl-go-converted`` pragma we wrote into it, a stats cache must parse as
  our JSON,
* and it must not be a seed of any other registered genome, a symlink, or a
  directory.

Anything that fails a proof is reported as protected with a reason, so the
confirmation dialog can show the user exactly which of their files are staying.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import re
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

# Suffixes of files that only ever come from a tool we run, so their existence
# beside a registered file is proof enough on its own.
FASTA_SIDECAR_SUFFIXES = (".fai", ".gzi")
ANNOTATION_SIDECAR_SUFFIXES = (".tbi", ".csi")

CONVERTED_ANNOTATION_RE = re.compile(r"\.ensembl\.gff3(\.(?:gz|bgz))?$", re.IGNORECASE)
CONVERTED_PRAGMA = "#!ensembl-go-converted"
STATS_SUFFIX = ".stats.v1.json"
STATS_FASTA_TMP_DIR = Path("/tmp/ensembl_local_stats_fasta")

# Never a candidate, whatever a rule claims.
_FORBIDDEN_ROOTS = {Path("/"), Path("/usr"), Path("/etc"), Path("/var"), Path("/System"), Path("/bin")}


@dataclass(frozen=True)
class RemovalCandidate:
    path: str
    kind: str
    bytes: int = 0

    def as_dict(self) -> Dict[str, Any]:
        return {"path": self.path, "kind": self.kind, "bytes": int(self.bytes)}


@dataclass
class RemovalPlan:
    genome_key: str = ""
    deletable: List[RemovalCandidate] = field(default_factory=list)
    protected: List[Dict[str, str]] = field(default_factory=list)
    left_in_place: List[Dict[str, Any]] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)

    @property
    def total_bytes(self) -> int:
        return sum(int(item.bytes) for item in self.deletable)

    def add(self, path: Path, kind: str) -> None:
        if any(str(item.path) == str(path) for item in self.deletable):
            return
        self.deletable.append(RemovalCandidate(str(path), kind, _size_of(path)))

    def protect(self, path: Any, reason: str) -> None:
        text = str(path)
        if any(item.get("path") == text for item in self.protected):
            return
        self.protected.append({"path": text, "reason": reason})

    def as_dict(self) -> Dict[str, Any]:
        return {
            "genome_key": self.genome_key,
            "deletable": [item.as_dict() for item in self.deletable],
            "protected": list(self.protected),
            "left_in_place": list(self.left_in_place),
            "notes": list(self.notes),
            "total_bytes": self.total_bytes,
        }


def _size_of(path: Path) -> int:
    try:
        return int(path.stat().st_size)
    except Exception:
        return 0


def resolve_path(value: Any) -> Optional[Path]:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return Path(text).expanduser().resolve()
    except Exception:
        return None


# ── proofs ───────────────────────────────────────────────────────────────────


def is_bgzipped(path: Any) -> bool:
    """bgzip sets the FEXTRA flag; plain gzip does not."""
    try:
        with open(str(path), "rb") as handle:
            return handle.read(4) == b"\x1f\x8b\x08\x04"
    except Exception:
        return False


def read_leading_pragmas(path: Any, max_bytes: int = 32 * 1024 * 1024) -> List[str]:
    """Comment lines at the head of a GFF3, reading through gzip/bgzip.

    ``write_canonical_gff3`` emits ``##gff-version``, then one
    ``##sequence-region`` per sequence, then its provenance pragma — so the
    marker sits at the *end* of the block, and a fragmented assembly puts
    hundreds of thousands of lines in front of it. The cap is therefore generous:
    a 64 KB one stopped 1500 sequence-regions in and reported a file we had
    converted as one of the user's.
    """
    lines: List[str] = []
    try:
        opener = gzip.open if str(path).lower().endswith((".gz", ".bgz")) else open
        with opener(str(path), "rt", encoding="utf-8", errors="replace") as handle:  # type: ignore[operator]
            read = 0
            for line in handle:
                read += len(line)
                if not line.startswith("#"):
                    break
                lines.append(line.rstrip("\n"))
                if read >= max_bytes:
                    break
    except Exception:
        return []
    return lines


def is_converted_annotation(path: Any) -> bool:
    """True when we wrote this GFF3 ourselves, per its own provenance pragma."""
    return any(line.startswith(CONVERTED_PRAGMA) for line in read_leading_pragmas(path))


def index_source_gff(path: Any) -> Optional[str]:
    """The annotation a GFF3 index was built from, or None if it is not ours."""
    try:
        with open(str(path), "rb") as handle:
            if handle.read(16) != b"SQLite format 3\x00":
                return None
    except Exception:
        return None
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    except Exception:
        return None
    try:
        row = conn.execute("SELECT value FROM metadata WHERE key = 'source_gff'").fetchone()
    except Exception:
        return None
    finally:
        conn.close()
    return str(row[0]) if row and row[0] else None


def is_stats_cache(path: Any) -> bool:
    try:
        with open(str(path), "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except Exception:
        return False
    return isinstance(payload, dict) and bool(payload.get("schema") or payload.get("version") or payload.get("generated_at"))


# ── candidate derivation ─────────────────────────────────────────────────────


def derive_index_candidates(
    gff_path: Optional[Path],
    output_dir: Optional[str],
    index_basename: str,
    index_hint: Any = "",
) -> List[Path]:
    """Everywhere an index for this annotation could have been written.

    Over-enumeration is safe: each candidate still has to prove it is a SQLite
    index naming this annotation as its source before it can be deleted. That
    also catches indexes left by earlier versions, which wrote to the bare output
    directory.
    """
    candidates: List[Path] = []

    def _add(value: Any) -> None:
        resolved = resolve_path(value)
        if resolved is not None and resolved not in candidates:
            candidates.append(resolved)

    _add(index_hint)
    if gff_path is not None:
        _add(gff_path.parent / index_basename)
        # Siblings, for annotations renamed or indexed under an older scheme.
        try:
            for sibling in sorted(gff_path.parent.iterdir()):
                if sibling.is_file() and sibling.name.endswith(".index.db"):
                    _add(sibling)
        except Exception:
            pass
    root = resolve_path(output_dir)
    if root is not None:
        _add(root / "indexes" / index_basename)
        _add(root / index_basename)
    return candidates


def index_sidecars(db_path: Path) -> List[Path]:
    """Lock and journal files an index build leaves beside its database."""
    out: List[Path] = [Path(f"{db_path}.build.lock")]
    for suffix in ("-journal", "-wal", "-shm"):
        out.append(Path(f"{db_path}{suffix}"))
    try:
        for sibling in sorted(db_path.parent.glob(f"{db_path.name}.building-*")):
            out.append(sibling)
    except Exception:
        pass
    return out


def stats_cache_candidates(
    species: Dict[str, Any],
    gff_path: Optional[Path],
    cache_root: Optional[Path],
) -> List[Path]:
    """Stats caches for this genome, enumerated without touching the disk.

    ``stats_utils.choose_stats_cache_path`` picks one of these, but it probes
    writability by creating files and makes directories, which a preview must not
    do — so the locations are mirrored here and each is confirmed by parsing.
    """
    candidates: List[Path] = []
    if gff_path is not None:
        prefix = re.sub(r"\.gff3(\.(?:gz|bgz))?$", "", gff_path.name, flags=re.IGNORECASE) or "genome"
        candidates.append(gff_path.parent / f"{prefix}{STATS_SUFFIX}")
    if cache_root is not None:
        species_key = str(species.get("species_key") or "").strip()
        assembly = str(species.get("assembly") or "").strip()
        gff3 = str((species.get("files") or {}).get("gff3") or "").strip()
        digest = hashlib.sha1(f"{species_key}|{assembly}|{gff3}".encode("utf-8")).hexdigest()
        candidates.append(Path(cache_root) / "stats" / "manual" / f"{digest}{STATS_SUFFIX}")
    return candidates


def stats_fasta_tmp_candidates(fasta_path: Optional[Path]) -> List[Path]:
    """The decompressed FASTA the stats code parks in /tmp when a directory is read-only."""
    if fasta_path is None or not fasta_path.exists():
        return []
    try:
        stat = fasta_path.stat()
        digest = hashlib.sha1(
            f"{fasta_path}:{stat.st_size}:{int(stat.st_mtime)}".encode("utf-8")
        ).hexdigest()
    except Exception:
        return []
    target = STATS_FASTA_TMP_DIR / f"{digest}_{fasta_path.stem}"
    return [target, Path(f"{target}.fai")]


# ── the manual-genome planner ────────────────────────────────────────────────


def collect_seed_paths(entries: Iterable[Dict[str, Any]]) -> Set[Path]:
    """Every file path registered genomes point at, as resolved paths."""
    seeds: Set[Path] = set()
    for entry in entries or []:
        if not isinstance(entry, dict):
            continue
        files = entry.get("files") or {}
        if not isinstance(files, dict):
            continue
        for value in files.values():
            resolved = resolve_path(value)
            if resolved is not None:
                seeds.add(resolved)
    return seeds


def plan_manual_genome_removal(
    entry: Dict[str, Any],
    *,
    output_dir: str = "",
    cache_root: Optional[Path] = None,
    foreign_seeds: Optional[Set[Path]] = None,
    index_basename: str = "",
    genome_key: str = "",
) -> RemovalPlan:
    """What may be deleted for a genome the user registered from their own files.

    ``foreign_seeds`` are files other registered genomes depend on — two manual
    genomes often share a directory, and sometimes a FASTA.
    """
    plan = RemovalPlan(genome_key=genome_key or str(entry.get("selection_key") or entry.get("key") or ""))
    files = entry.get("files") or {}
    artifacts = entry.get("artifacts") or {}
    if not isinstance(files, dict):
        return plan

    fasta = resolve_path(files.get("fasta"))
    gff = resolve_path(files.get("gff3"))
    homology = resolve_path(files.get("homology"))
    own_seeds = {path for path in (fasta, gff, homology) if path is not None}
    others = set(foreign_seeds or set())

    # A seed another genome also registers keeps its sidecars: two manual
    # genomes often share a FASTA, and removing one must not force the other to
    # rebuild an index over gigabytes.
    shared_seeds = own_seeds & others
    others = others - own_seeds
    if fasta is not None and fasta in shared_seeds:
        plan.protect(fasta, "another genome uses this file")
        fasta = None
    if gff is not None and gff in shared_seeds:
        plan.protect(gff, "another genome uses this file")
        gff = None

    def _consider(path: Optional[Path], kind: str, *, allowed_parents: Sequence[Path] = ()) -> bool:
        if path is None:
            return False
        if path in others:
            plan.protect(path, "another genome uses this file")
            return False
        if path.is_symlink():
            plan.protect(path, "symlink, not followed")
            return False
        if path in _FORBIDDEN_ROOTS or path.parent == path:
            return False
        if not path.is_file():
            return False
        if allowed_parents and path.parent not in {Path(parent) for parent in allowed_parents}:
            plan.protect(path, "outside the directory this genome was registered from")
            return False
        plan.add(path, kind)
        return True

    seed_dirs = [path.parent for path in own_seeds]

    # The user's own files, stated explicitly so the dialog can show them.
    if fasta is not None:
        plan.protect(fasta, "your genome sequence, left where you put it")
    if homology is not None:
        plan.protect(homology, "your file, left where you put it")

    # 1. The annotation: only ours when we converted it.
    converted_record = resolve_path(artifacts.get("converted_annotation"))
    if gff is not None:
        recorded = converted_record is not None and converted_record == gff
        if recorded or (CONVERTED_ANNOTATION_RE.search(gff.name) and is_converted_annotation(gff)):
            _consider(gff, "converted_annotation", allowed_parents=seed_dirs)
            # An uncompressed conversion left behind when bgzip failed.
            if gff.name.lower().endswith((".gz", ".bgz")):
                _consider(Path(str(gff)[: -len(gff.suffix)]), "converted_annotation", allowed_parents=seed_dirs)
        else:
            plan.protect(gff, "your annotation, left where you put it")

    source_annotation = resolve_path(artifacts.get("source_annotation"))
    if source_annotation is not None and source_annotation != gff:
        plan.protect(source_annotation, "the annotation you supplied, left where you put it")

    # 2. Tabix indexes for the annotation.
    if gff is not None:
        for suffix in ANNOTATION_SIDECAR_SUFFIXES:
            _consider(Path(f"{gff}{suffix}"), "tabix_index", allowed_parents=seed_dirs)

    # 3. The GFF3 index, proved by the annotation it names as its source.
    managed_parents = []
    root = resolve_path(output_dir)
    if root is not None:
        managed_parents = [root / "indexes", root]
    for candidate in derive_index_candidates(gff, output_dir, index_basename, files.get("index")):
        if not candidate.is_file() or candidate in others:
            continue
        source = index_source_gff(candidate)
        if source is None:
            continue
        source_resolved = resolve_path(source)
        if gff is None or source_resolved != gff:
            continue
        if _consider(candidate, "index_db", allowed_parents=list(seed_dirs) + managed_parents):
            for sidecar in index_sidecars(candidate):
                _consider(sidecar, "index_sidecar", allowed_parents=[candidate.parent])

    # 4. FASTA sidecars, and the plain copy we make of a non-bgzip .gz.
    if fasta is not None:
        for suffix in FASTA_SIDECAR_SUFFIXES:
            _consider(Path(f"{fasta}{suffix}"), "fasta_sidecar", allowed_parents=seed_dirs)
        if fasta.name.lower().endswith(".gz") and not is_bgzipped(fasta):
            plain = Path(str(fasta)[:-3])
            if _consider(plain, "decompressed_fasta", allowed_parents=seed_dirs):
                for suffix in FASTA_SIDECAR_SUFFIXES:
                    _consider(Path(f"{plain}{suffix}"), "fasta_sidecar", allowed_parents=seed_dirs)

    # 5. Stats caches.
    for candidate in stats_cache_candidates(entry, gff, cache_root):
        if candidate.is_file() and is_stats_cache(candidate):
            _consider(candidate, "stats_cache", allowed_parents=[candidate.parent])
    for candidate in stats_fasta_tmp_candidates(fasta):
        if candidate.is_file():
            _consider(candidate, "stats_fasta_tmp", allowed_parents=[STATS_FASTA_TMP_DIR])

    # 6. The id map, only when the import recorded writing it: the filename is
    #    fixed, so two conversions in one directory would otherwise take turns
    #    deleting each other's map.
    id_map = resolve_path(artifacts.get("id_map"))
    if id_map is not None:
        _consider(id_map, "id_map", allowed_parents=seed_dirs)

    if plan.protected:
        plan.notes.append("Files you supplied are never deleted.")
    return plan


# ── plan token ───────────────────────────────────────────────────────────────


def plan_token(plans: Sequence[RemovalPlan]) -> str:
    """Fingerprint of what a preview promised, so the delete can detect drift."""
    digest = hashlib.sha256()
    for entry in sorted(
        (item for plan in plans for item in plan.deletable),
        key=lambda item: item.path,
    ):
        digest.update(f"{entry.path}\x1f{entry.bytes}\x1e".encode("utf-8"))
    return digest.hexdigest()


def unlink_paths(paths: Iterable[Any]) -> Tuple[List[str], List[Dict[str, str]]]:
    """Delete each path, reporting failures instead of stopping at the first."""
    deleted: List[str] = []
    failed: List[Dict[str, str]] = []
    for raw in paths:
        path = Path(str(raw))
        try:
            if path.is_symlink() or not path.is_file():
                continue
            path.unlink()
            deleted.append(str(path))
        except FileNotFoundError:
            continue
        except Exception as exc:
            failed.append({"path": str(path), "error": str(exc)})
    return deleted, failed


def is_index_lock_held(db_path: Any) -> bool:
    """Whether an index build currently holds this database's lock."""
    lock_path = Path(f"{db_path}.build.lock")
    if not lock_path.is_file():
        return False
    try:
        import fcntl

        with open(lock_path, "a+b") as handle:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                return True
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    except Exception:
        return False
    return False


def directory_size(path: Any) -> int:
    total = 0
    try:
        for entry in Path(str(path)).rglob("*"):
            if entry.is_file() and not entry.is_symlink():
                total += _size_of(entry)
    except Exception:
        return total
    return total
