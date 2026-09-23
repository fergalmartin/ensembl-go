"""The achievements progress store: what it holds, how copies merge, how it reaches disk.

Achievements are a game, but the file is still the user's data. Someone who has
spent months unlocking them should find every one still there after a reinstall, an
upgrade or a change of output directory, so the store is built on the same footing
as the notes store in main.py:

* **Merge, never replace.** Several copies can exist (the output-directory sidecar,
  the working-directory sidecar, the cache fallback used before an output directory
  was set). Loading reads all of them and unions them; nothing is ever lost by
  picking the wrong winner.
* **Monotonic.** Every field only grows. An unlock keeps its earliest date, a counter
  its highest value, a set every key it has ever held. That is what makes merging
  safe, and it is also the rule the frontend relies on: an unlock is never taken
  back, even if a later version tightens the rule that granted it.
* **Forward compatible.** Ids this version does not know, and top-level fields it has
  never heard of, are carried through untouched. A file written by a *newer* schema is
  read for display but never written, so an older app cannot flatten it.

Nothing here knows what any achievement means. The rules live in the frontend
catalogue; this module only stores the facts they are evaluated against.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

ACHIEVEMENTS_FILENAME = "achievements.json"
STORE_SCHEMA = 1

# Bounds on what one client can put in the file. Generous enough never to bind in
# normal use; they exist so a runaway caller cannot grow the file without limit.
MAX_ID_CHARS = 100
MAX_KEY_CHARS = 300
MAX_DISTINCT_KEYS = 5000
MAX_COUNTER_STEP = 1_000_000
# One sync covers a few seconds of use. A day is a hard ceiling on what a single
# duration delta can claim, so a clock jump cannot award "ten hours" in one go.
MAX_DURATION_STEP_MS = 24 * 60 * 60 * 1000

_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:\-]*$")

# Settings the frontend may change through a sync. Anything else under "settings"
# that is already on disk is kept, but cannot be written from here.
_SETTING_TYPES = {"notifications": bool, "enabled": bool}

_GRCH37_ACCESSION_RE = re.compile(r"^GC([AF])_000001405\.(\d+)$", re.IGNORECASE)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def empty_store() -> Dict[str, Any]:
    now = utc_now_iso()
    return {
        "schema": STORE_SCHEMA,
        "first_seen": now,
        "updated_at": now,
        "unlocked": {},
        "counters": {},
        "distinct": {},
        "durations_ms": {},
        "taxa": {},
        "settings": {},
    }


# ── Normalisation ──────────────────────────────────────────────────────────────


def _valid_id(value: Any) -> Optional[str]:
    text = str(value or "").strip()
    if not text or len(text) > MAX_ID_CHARS or not _ID_RE.match(text):
        return None
    return text


def _valid_key(value: Any) -> Optional[str]:
    text = str(value if value is not None else "").strip()
    if not text or len(text) > MAX_KEY_CHARS:
        return None
    return text


def _non_negative_int(value: Any) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        try:
            number = int(float(value))
        except (TypeError, ValueError):
            return 0
    return max(0, number)


def _iso_or_now(value: Any) -> str:
    text = str(value or "").strip()
    if text:
        try:
            datetime.fromisoformat(text.replace("Z", "+00:00"))
            return text
        except ValueError:
            pass
    return utc_now_iso()


def schema_of(doc: Any) -> int:
    if not isinstance(doc, dict):
        return 0
    try:
        return int(doc.get("schema") or STORE_SCHEMA)
    except (TypeError, ValueError):
        return 0


def normalize_store(doc: Any) -> Dict[str, Any]:
    """A well-formed store built from whatever was read, keeping unknown fields."""
    base = empty_store()
    if not isinstance(doc, dict):
        return base
    out: Dict[str, Any] = {key: value for key, value in doc.items() if key not in base}
    out["schema"] = max(STORE_SCHEMA, schema_of(doc))
    out["first_seen"] = _iso_or_now(doc.get("first_seen"))
    out["updated_at"] = _iso_or_now(doc.get("updated_at") or out["first_seen"])

    unlocked: Dict[str, Dict[str, Any]] = {}
    for raw_id, raw in (doc.get("unlocked") or {}).items() if isinstance(doc.get("unlocked"), dict) else []:
        achievement_id = _valid_id(raw_id)
        if not achievement_id:
            continue
        record = dict(raw) if isinstance(raw, dict) else {}
        record["at"] = _iso_or_now(record.get("at"))
        unlocked[achievement_id] = record
    out["unlocked"] = unlocked

    counters: Dict[str, int] = {}
    for raw_id, raw in (doc.get("counters") or {}).items() if isinstance(doc.get("counters"), dict) else []:
        counter_id = _valid_id(raw_id)
        if counter_id:
            counters[counter_id] = _non_negative_int(raw)
    out["counters"] = counters

    distinct: Dict[str, List[str]] = {}
    for raw_id, raw in (doc.get("distinct") or {}).items() if isinstance(doc.get("distinct"), dict) else []:
        set_id = _valid_id(raw_id)
        if not set_id or not isinstance(raw, list):
            continue
        keys = sorted({key for key in (_valid_key(item) for item in raw) if key})
        distinct[set_id] = keys[:MAX_DISTINCT_KEYS]
    out["distinct"] = distinct

    durations: Dict[str, int] = {}
    for raw_id, raw in (doc.get("durations_ms") or {}).items() if isinstance(doc.get("durations_ms"), dict) else []:
        duration_id = _valid_id(raw_id)
        if duration_id:
            durations[duration_id] = _non_negative_int(raw)
    out["durations_ms"] = durations

    taxa: Dict[str, int] = {}
    for raw_key, raw in (doc.get("taxa") or {}).items() if isinstance(doc.get("taxa"), dict) else []:
        genome_key = _valid_key(raw_key)
        taxid = _non_negative_int(raw)
        if genome_key and taxid:
            taxa[genome_key] = taxid
    out["taxa"] = taxa

    out["settings"] = dict(doc.get("settings")) if isinstance(doc.get("settings"), dict) else {}
    return out


# ── Merging and deltas ─────────────────────────────────────────────────────────


def merge_stores(*docs: Dict[str, Any]) -> Dict[str, Any]:
    """Union of several copies of the store. Every field keeps its furthest-along value."""
    stores = [normalize_store(doc) for doc in docs if isinstance(doc, dict)]
    if not stores:
        return empty_store()
    merged = normalize_store(stores[0])
    for other in stores[1:]:
        for key, value in other.items():
            if key not in merged:
                merged[key] = value
        merged["schema"] = max(merged["schema"], other["schema"])
        merged["first_seen"] = min(merged["first_seen"], other["first_seen"])
        merged["updated_at"] = max(merged["updated_at"], other["updated_at"])
        for achievement_id, record in other["unlocked"].items():
            existing = merged["unlocked"].get(achievement_id)
            if existing is None or record["at"] < existing["at"]:
                merged["unlocked"][achievement_id] = record
        for counter_id, value in other["counters"].items():
            merged["counters"][counter_id] = max(merged["counters"].get(counter_id, 0), value)
        for set_id, keys in other["distinct"].items():
            union = set(merged["distinct"].get(set_id, [])) | set(keys)
            merged["distinct"][set_id] = sorted(union)[:MAX_DISTINCT_KEYS]
        for duration_id, value in other["durations_ms"].items():
            merged["durations_ms"][duration_id] = max(merged["durations_ms"].get(duration_id, 0), value)
        for genome_key, taxid in other["taxa"].items():
            merged["taxa"].setdefault(genome_key, taxid)
        for setting, value in other["settings"].items():
            merged["settings"].setdefault(setting, value)
    return merged


def apply_delta(doc: Dict[str, Any], delta: Any) -> bool:
    """Fold one batch from the frontend into ``doc``. Returns whether anything changed.

    Counters and durations arrive as increments, sets as keys to add, unlocks as ids
    with the moment they happened. Malformed entries are dropped one by one rather
    than failing the batch: one bad key must not cost the user the rest of it.
    """
    if not isinstance(delta, dict):
        return False
    changed = False

    unlocked = delta.get("unlocked")
    if isinstance(unlocked, dict):
        for raw_id, raw_at in unlocked.items():
            achievement_id = _valid_id(raw_id)
            if not achievement_id or achievement_id in doc["unlocked"]:
                continue
            at = raw_at.get("at") if isinstance(raw_at, dict) else raw_at
            doc["unlocked"][achievement_id] = {"at": _iso_or_now(at)}
            changed = True

    counters = delta.get("counters")
    if isinstance(counters, dict):
        for raw_id, raw_step in counters.items():
            counter_id = _valid_id(raw_id)
            step = min(_non_negative_int(raw_step), MAX_COUNTER_STEP)
            if counter_id and step:
                doc["counters"][counter_id] = doc["counters"].get(counter_id, 0) + step
                changed = True

    distinct = delta.get("distinct")
    if isinstance(distinct, dict):
        for raw_id, raw_keys in distinct.items():
            set_id = _valid_id(raw_id)
            if not set_id or not isinstance(raw_keys, list):
                continue
            existing = set(doc["distinct"].get(set_id, []))
            additions = {key for key in (_valid_key(item) for item in raw_keys) if key} - existing
            if additions and len(existing) < MAX_DISTINCT_KEYS:
                doc["distinct"][set_id] = sorted(existing | additions)[:MAX_DISTINCT_KEYS]
                changed = True

    durations = delta.get("durations_ms")
    if isinstance(durations, dict):
        for raw_id, raw_step in durations.items():
            duration_id = _valid_id(raw_id)
            step = min(_non_negative_int(raw_step), MAX_DURATION_STEP_MS)
            if duration_id and step:
                doc["durations_ms"][duration_id] = doc["durations_ms"].get(duration_id, 0) + step
                changed = True

    settings = delta.get("settings")
    if isinstance(settings, dict):
        for name, expected_type in _SETTING_TYPES.items():
            if name in settings and isinstance(settings[name], expected_type):
                if doc["settings"].get(name) != settings[name]:
                    doc["settings"][name] = settings[name]
                    changed = True

    if changed:
        doc["updated_at"] = utc_now_iso()
    return changed


def is_grch37(assembly: Any, assembly_name: Any = "") -> bool:
    """GRCh37 by name, or by one of the accession versions NCBI issued for it."""
    if str(assembly_name or "").strip().upper().startswith("GRCH37"):
        return True
    if str(assembly or "").strip().upper().startswith("GRCH37"):
        return True
    match = _GRCH37_ACCESSION_RE.match(str(assembly or "").strip())
    if not match:
        return False
    kind, version = match.group(1).upper(), int(match.group(2))
    # GRCh38 took over from GCA_000001405.15 / GCF_000001405.26 onwards.
    return (kind == "A" and 1 <= version <= 14) or (kind == "F" and 13 <= version <= 25)


def record_download(
    doc: Dict[str, Any],
    genome_key: str,
    taxid: int = 0,
    assembly: str = "",
    assembly_name: str = "",
) -> bool:
    """Note that a genome is (or was) downloaded. Idempotent per genome."""
    key = _valid_key(genome_key)
    if not key:
        return False
    changed = False
    downloaded = set(doc["distinct"].get("genome.downloaded", []))
    if key not in downloaded:
        downloaded.add(key)
        doc["distinct"]["genome.downloaded"] = sorted(downloaded)[:MAX_DISTINCT_KEYS]
        changed = True
    taxid = _non_negative_int(taxid)
    if taxid and doc["taxa"].get(key) != taxid:
        doc["taxa"][key] = taxid
        changed = True
    if is_grch37(assembly, assembly_name):
        grch37 = set(doc["distinct"].get("genome.grch37", []))
        if key not in grch37:
            grch37.add(key)
            doc["distinct"]["genome.grch37"] = sorted(grch37)
            changed = True
    if changed:
        doc["updated_at"] = utc_now_iso()
    return changed


def record_deletion(doc: Dict[str, Any], genome_key: str) -> bool:
    key = _valid_key(genome_key)
    if not key:
        return False
    deleted = set(doc["distinct"].get("genome.deleted", []))
    if key in deleted:
        return False
    deleted.add(key)
    doc["distinct"]["genome.deleted"] = sorted(deleted)[:MAX_DISTINCT_KEYS]
    doc["updated_at"] = utc_now_iso()
    return True


def reset_store(doc: Dict[str, Any]) -> Dict[str, Any]:
    """A fresh store that keeps only the user's settings (notifications on or off)."""
    fresh = empty_store()
    fresh["settings"] = dict(doc.get("settings") or {})
    return fresh


# ── Disk ───────────────────────────────────────────────────────────────────────


class StoreReadResult:
    """What reading one copy of the store found."""

    __slots__ = ("path", "doc", "status", "detail")

    def __init__(self, path: Path, doc: Optional[Dict[str, Any]], status: str, detail: str = ""):
        self.path = path
        self.doc = doc
        # "ok" | "missing" | "corrupt" | "newer"
        self.status = status
        self.detail = detail


def quarantine(path: Path) -> Optional[Path]:
    """Rename an unreadable store aside, so nothing writes over the only copy."""
    try:
        if not path.exists() or path.stat().st_size == 0:
            return None
        target = path.with_name(f"{path.name}.corrupt-{int(time.time())}")
        path.rename(target)
        return target
    except OSError:
        return None


def read_store(path: Path) -> StoreReadResult:
    if not path.exists():
        return StoreReadResult(path, None, "missing")
    try:
        with open(path, encoding="utf-8") as handle:
            raw = json.load(handle)
    except Exception as exc:
        moved = quarantine(path)
        detail = f"{path.name} could not be read ({exc})."
        if moved:
            detail += f" It was moved to {moved.name} and a new one started."
        return StoreReadResult(path, None, "corrupt", detail)
    if not isinstance(raw, dict):
        moved = quarantine(path)
        return StoreReadResult(path, None, "corrupt", f"{path.name} is not an achievements file.")
    if schema_of(raw) > STORE_SCHEMA:
        return StoreReadResult(
            path,
            normalize_store(raw),
            "newer",
            f"{path.name} was written by a newer version of Ensembl Go. Your achievements are "
            f"shown, but this version will not change the file.",
        )
    return StoreReadResult(path, normalize_store(raw), "ok")


def load_stores(paths: Iterable[Path]) -> Tuple[Dict[str, Any], List[StoreReadResult]]:
    results = [read_store(path) for path in paths]
    docs = [result.doc for result in results if result.doc is not None]
    return (merge_stores(*docs) if docs else empty_store()), results


def write_store(path: Path, doc: Dict[str, Any], backup: bool = True) -> None:
    """Atomic write, keeping the previous copy as ``.bak``. Refuses to downgrade a newer file."""
    if path.exists():
        existing = read_store(path)
        if existing.status == "newer":
            raise PermissionError(f"{path} was written by a newer version and will not be changed")
        if backup and existing.status == "ok":
            try:
                shutil.copy2(path, path.with_name(f"{path.name}.bak"))
            except OSError:
                pass
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = normalize_store(doc)
    tmp_fd, tmp_path = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
        os.replace(tmp_path, path)
    finally:
        if os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


def backup_copy(path: Path) -> Optional[Path]:
    """A timestamped copy kept before a reset, which is the one destructive action here."""
    try:
        if not path.exists() or path.stat().st_size == 0:
            return None
        target = path.with_name(f"{path.name}.backup-{int(time.time())}")
        shutil.copy2(path, target)
        return target
    except OSError:
        return None
