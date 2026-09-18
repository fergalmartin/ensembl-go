"""Remembering the answers that were expensive to work out.

Class runs are cached; sequence is not, deliberately.

Working out a gene's classes means reading every isoform's exons out of a JSON
blob, voting on every boundary and resolving the overlaps, and a reader moves
between a gene and its transcripts and back repeatedly. Reading sequence, by
contrast, is pysam on a bgzipped FASTA -- about a millisecond for the 12 kb the
view asks for -- and the operating system's page cache already holds the blocks.
A disk cache of raw sequence would be a second, staler copy of the FASTA, so
there is not one here and there should not be one later.

The key carries a schema version. Bumping SCHEMA_VERSION when the payload shape
changes retires every stale entry without anyone having to find and delete them.
"""

import hashlib
import json
import os
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any, Dict, Optional

# v2: a location's runs are the gene classes rather than genic/intergenic,
# and the payload carries `overlaps`, `detail` and `gene_count`.
SCHEMA_VERSION = "v2"

# How many answers to keep in memory in front of the disk. A reader moving
# between the levels of one gene touches a handful; this is enough to make going
# back up free without holding a window's worth of runs for every gene visited.
MEMORY_ENTRIES = 32


def cache_key(*parts: Any) -> str:
    """A key over everything the answer depends on, including the annotation file.

    The index's modification time and size are in the key so that rebuilding an
    annotation retires its cached answers rather than serving them alongside new
    ones.
    """
    joined = "|".join([SCHEMA_VERSION, *(str(part) for part in parts)])
    return hashlib.sha1(joined.encode("utf-8")).hexdigest()


def source_fingerprint(path: str) -> str:
    """A file's identity for cache purposes: its path, size and mtime."""
    text = str(path or "")
    if not text:
        return ""
    try:
        stat = os.stat(text)
    except OSError:
        return text
    return f"{text}:{stat.st_size}:{int(stat.st_mtime)}"


class ClassCache:
    """A bounded in-memory map in front of a directory of JSON files."""

    def __init__(self, root: Optional[Path] = None, memory_entries: int = MEMORY_ENTRIES) -> None:
        self.root = Path(root) if root else None
        self._memory: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
        self._limit = max(1, int(memory_entries))
        self._lock = threading.Lock()

    def _path_for(self, key: str) -> Optional[Path]:
        if not self.root:
            return None
        return self.root / f"{key}.json"

    def get(self, key: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            entry = self._memory.get(key)
            if entry is not None:
                self._memory.move_to_end(key)
                return entry

        path = self._path_for(key)
        if not path or not path.exists():
            return None
        try:
            with path.open("r", encoding="utf-8") as handle:
                value = json.load(handle)
        except (OSError, ValueError):
            # A half-written or corrupt entry is not worth recovering; it will be
            # recomputed and overwritten on the way back out.
            return None
        self._remember(key, value)
        return value

    def put(self, key: str, value: Dict[str, Any]) -> None:
        self._remember(key, value)
        path = self._path_for(key)
        if not path:
            return
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            # Written beside the target and moved into place, so a reader never
            # sees a partial file.
            temporary = path.with_suffix(".json.tmp")
            with temporary.open("w", encoding="utf-8") as handle:
                json.dump(value, handle, separators=(",", ":"))
            temporary.replace(path)
        except OSError:
            # The cache is an optimisation. Failing to write one is not a reason
            # to fail the request that produced the answer.
            pass

    def _remember(self, key: str, value: Dict[str, Any]) -> None:
        with self._lock:
            self._memory[key] = value
            self._memory.move_to_end(key)
            while len(self._memory) > self._limit:
                self._memory.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._memory.clear()
