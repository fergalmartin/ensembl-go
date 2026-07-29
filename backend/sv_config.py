"""Human-readable configuration files for structural-variation alignments.

An SV alignment needs very little to be displayable: two assemblies, a BigChain
file, which side of that file is indexed, and optionally some signal/interval
tracks. Everything else the registration flow used to ask for was a by-product of
the production pipeline rather than something the view needs.

This module owns that file format. It converts between three shapes:

``config``
    What a user reads and edits. Genomes are declared once under short handles and
    referenced by handle from each alignment, so a record is a few short lines
    rather than a page of duplicated accessions and aliases.

``dataset``
    The flat dict the rest of the backend already consumes. Producing this shape
    unchanged is what lets ``_sv_public_dataset``, ``_select_sv_dataset`` and the
    view endpoints stay as they are.

``legacy record``
    What ``sv_alignment_registry.json`` held before this format existed, and what
    sidecar ``sv_alignment.json`` manifests still hold. Read-only; migrated on load.

Parsing never touches the filesystem beyond resolving relative paths, so it can be
run against text the user is still typing. Whether the files exist is a separate
question answered later, by the caller.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

CONFIG_VERSION = 1
CONFIG_VERSION_KEY = "ensembl_go_sv_config"

INDEXED_SIDES = ("reference", "target")

# Extension -> track type. The view only knows how to draw these two.
TRACK_TYPES_BY_SUFFIX = {
    ".bw": "bigwig",
    ".bigwig": "bigwig",
    ".bb": "bigbed",
    ".bigbed": "bigbed",
}


class SvConfigError(ValueError):
    """Raised when a config cannot be parsed at all (bad JSON, wrong root type)."""


# ---------------------------------------------------------------------------
# Diagnostics
# ---------------------------------------------------------------------------


def diagnostic(severity: str, pointer: str, message: str, line: int = 0) -> Dict[str, Any]:
    return {
        "severity": "error" if severity == "error" else "warning",
        "pointer": str(pointer or ""),
        "message": str(message or ""),
        "line": int(line or 0),
    }


def has_errors(diagnostics: Iterable[Dict[str, Any]]) -> bool:
    return any(str(item.get("severity")) == "error" for item in diagnostics or [])


def build_pointer_line_index(text: str) -> Dict[str, int]:
    """Map every JSON pointer in ``text`` to the line it starts on.

    A plain text search cannot do this: ``pairs/0/alignments/1/chain`` and
    ``pairs/0/alignments/0/chain`` look identical to it, so an error on the second
    alignment would highlight the first. Scanning structurally is the only way to
    tell array elements apart, and pointing at the wrong record is worse than
    pointing at nothing.

    Deliberately lenient -- it indexes as much as it can understand and stops at the
    first thing it cannot. It runs on text the user is still editing, where a parse
    error is the normal case, and partial line information still beats none.
    """
    index: Dict[str, int] = {}
    if not text:
        return index

    length = len(text)
    position = 0
    line = 1
    # Each frame: [kind, path, array_index, pending_key]
    stack: List[List[Any]] = []

    def current_path() -> str:
        if not stack:
            return ""
        kind, path, array_index, pending_key = stack[-1]
        if kind == "obj":
            return f"{path}/{pending_key}" if pending_key is not None else path
        return f"{path}/{array_index}"

    def record(pointer: str, at_line: int) -> None:
        if pointer and pointer not in index:
            index[pointer] = at_line

    def read_string(start: int) -> Tuple[str, int]:
        out: List[str] = []
        i = start + 1
        while i < length:
            char = text[i]
            if char == "\\":
                i += 2
                out.append(text[i - 1] if i - 1 < length else "")
                continue
            if char == '"':
                return "".join(out), i + 1
            out.append(char)
            i += 1
        return "".join(out), length

    while position < length:
        char = text[position]
        if char == "\n":
            line += 1
            position += 1
            continue
        if char in " \t\r":
            position += 1
            continue

        if char == '"':
            expects_key = bool(stack) and stack[-1][0] == "obj" and stack[-1][3] is None
            raw, next_position = read_string(position)
            # A quoted string may span lines only via escapes, but count anyway.
            line += text.count("\n", position, next_position)
            if expects_key:
                stack[-1][3] = raw.replace("~", "~0").replace("/", "~1")
                record(current_path(), line)
            elif stack and stack[-1][0] == "arr":
                record(current_path(), line)
            position = next_position
            continue

        if char in "{[":
            pointer = current_path()
            record(pointer, line)
            stack.append(["obj" if char == "{" else "arr", pointer, 0, None])
            position += 1
            continue

        if char in "}]":
            if stack:
                stack.pop()
            position += 1
            continue

        if char == ",":
            if stack:
                if stack[-1][0] == "obj":
                    stack[-1][3] = None
                else:
                    stack[-1][2] += 1
            position += 1
            continue

        if char == ":":
            position += 1
            continue

        # A bare scalar: number, true, false, null.
        if stack and stack[-1][0] == "arr":
            record(current_path(), line)
        while position < length and text[position] not in ",}]\n \t\r":
            position += 1
        continue

    return index


def locate_pointer_lines(text: str, diagnostics: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Attach a source line to each diagnostic that already lacks one.

    A pointer that cannot be located keeps ``line: 0``, which the UI renders as "no
    line" rather than guessing. Falls back to the nearest indexable ancestor, so an
    error on a field that is missing entirely still points at the record it belongs
    to.
    """
    if not text or not diagnostics:
        return list(diagnostics or [])
    index = build_pointer_line_index(text)
    out: List[Dict[str, Any]] = []
    for item in diagnostics:
        if int(item.get("line") or 0) > 0:
            out.append(dict(item))
            continue
        segments = [seg for seg in str(item.get("pointer") or "").split("/") if seg]
        line_no = 0
        while segments:
            hit = index.get("/" + "/".join(segments))
            if hit:
                line_no = hit
                break
            segments.pop()
        out.append({**item, "line": line_no})
    return out


# ---------------------------------------------------------------------------
# Small pure helpers, shared with main.py
# ---------------------------------------------------------------------------


def normalize_token(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").strip().lower())


def sequence_name_aliases(token: Any) -> List[str]:
    """Spelling variants of one sequence name: case, and the ``chr`` prefix."""
    text = str(token or "").strip()
    if not text:
        return []
    out = {text, text.lower(), text.upper()}
    if text.lower().startswith("chr") and len(text) > 3:
        out.add(text[3:])
    else:
        out.add(f"chr{text}")
    return [value for value in out if value]


def sort_region_key(region_name: Any) -> Tuple[int, int, str]:
    """Order chromosomes 1..22, X, Y, MT, then everything else alphabetically."""
    text = str(region_name or "").strip()
    lowered = text.lower()
    core = lowered[3:] if lowered.startswith("chr") else lowered
    if core.isdigit():
        return (0, int(core), text)
    special = {"x": 23, "y": 24, "m": 25, "mt": 25}
    if core in special:
        return (0, special[core], text)
    return (1, 0, text)


def track_type_from_path(path: Any) -> str:
    lower = str(path or "").strip().lower()
    for suffix, track_type in TRACK_TYPES_BY_SUFFIX.items():
        if lower.endswith(suffix):
            return track_type
    return ""


def unique_strings(values: Iterable[Any]) -> List[str]:
    out: List[str] = []
    seen: Set[str] = set()
    for value in values:
        text = str(value or "").strip()
        if not text:
            continue
        key = text.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(text)
    return out


def slugify_label(label: Any) -> str:
    """Stable id from a label.

    Ids used to be ``sha1(chain|ref_tsv|tgt_tsv)``, which meant moving the files
    forked a new registry entry instead of updating the existing one. Deriving the
    id from the label instead makes re-registering the same alignment at a new path
    an update, which is what a user re-pointing a config at moved files expects.
    """
    slug = re.sub(r"[^a-z0-9]+", "_", str(label or "").strip().lower()).strip("_")
    return slug or "alignment"


def infer_indexed_side_from_filename(chain_path: Any) -> str:
    """The pipeline's own naming convention, when the config does not say."""
    name = Path(str(chain_path or "")).name.lower()
    if name.startswith("alt_") and "_to_ref_" in name:
        return "target"
    if name.startswith("ref_") and "_to_alt_" in name:
        return "reference"
    return ""


def _resolve_path(value: Any, base_dir: Optional[Path]) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    path = Path(text).expanduser()
    if not path.is_absolute() and base_dir:
        path = Path(base_dir) / path
    return str(path)


# ---------------------------------------------------------------------------
# Sequence maps
# ---------------------------------------------------------------------------


def build_sequence_map(
    assembly_to_hal: Dict[str, str],
    explicit_aliases: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Assemble the mapping dict the view endpoints consume.

    Same four keys the mapping-TSV loader has always produced, so callers do not
    care whether the names came from a TSV or were derived from the assembly.
    """
    hal_to_assembly: Dict[str, str] = {}
    alias_to_assembly: Dict[str, str] = {}
    for assembly_seq, hal_seq in assembly_to_hal.items():
        if hal_seq and hal_seq != assembly_seq:
            hal_to_assembly[hal_seq] = assembly_seq
        for alias in sequence_name_aliases(assembly_seq) + sequence_name_aliases(hal_seq):
            alias_to_assembly.setdefault(alias.lower(), assembly_seq)
    for alias, assembly_seq in (explicit_aliases or {}).items():
        if not alias or not assembly_seq:
            continue
        hal_to_assembly.setdefault(str(alias), str(assembly_seq))
        # An explicit alias is the user overriding what we guessed, so it wins.
        for variant in sequence_name_aliases(alias):
            alias_to_assembly[variant.lower()] = str(assembly_seq)
    return {
        "hal_to_assembly": hal_to_assembly,
        "assembly_to_hal": dict(assembly_to_hal),
        "alias_to_assembly": alias_to_assembly,
        "genome_name": "",
        "assembly_uuid": "",
    }


def derive_sequence_map(
    chain_chroms: Iterable[str],
    assembly_sequences: Iterable[str],
    explicit_aliases: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Sequence names for one side, without a mapping TSV.

    Driven by the BigChain's own chromosome list rather than by the assembly's, on
    purpose. A fragmented assembly can carry hundreds of thousands of contigs, and
    indexing all of them to answer questions about the few dozen the chain actually
    covers would cost far more memory than the answer is worth. A sequence the chain
    does not mention has no alignment to show anyway.

    ``explicit_aliases`` is the escape hatch for the case the ``chr`` rule cannot
    cover -- a chain naming a sequence ``CM089167.1`` where the assembly calls it
    ``1``. Those aliases also seed the map, so such a sequence still yields a region
    even though the raw names never match.
    """
    available = [str(name or "").strip() for name in assembly_sequences if str(name or "").strip()]
    lookup = {name.lower(): name for name in available}
    aliases = {str(k): str(v) for k, v in (explicit_aliases or {}).items() if k and v}

    assembly_to_hal: Dict[str, str] = {}
    for raw_chrom in chain_chroms:
        chrom = str(raw_chrom or "").strip()
        if not chrom:
            continue
        resolved = ""
        for candidate in [chrom] + sequence_name_aliases(chrom):
            hit = lookup.get(candidate.lower())
            if hit:
                resolved = hit
                break
        if not resolved:
            aliased = aliases.get(chrom)
            if aliased:
                resolved = lookup.get(str(aliased).lower()) or str(aliased)
        if not resolved:
            continue
        assembly_to_hal.setdefault(resolved, chrom)

    return build_sequence_map(assembly_to_hal, aliases)


# ---------------------------------------------------------------------------
# Genome records
# ---------------------------------------------------------------------------


def _genome_record_from_config(handle: str, raw: Any) -> Dict[str, Any]:
    """Config genome entry -> the genome dict the catalog and matcher expect.

    The handle is carried through as an alias so a config that names a genome
    ``GRCh38`` still matches a local assembly registered under that name, not only
    under its accession.
    """
    source = raw if isinstance(raw, dict) else {}
    accession = str(
        source.get("accession")
        or source.get("assembly")
        or source.get("gca")
        or ""
    ).strip()
    assembly_name = str(source.get("assembly_name") or source.get("name") or "").strip()
    species = str(source.get("species") or source.get("scientific_name") or "").strip()
    aliases = unique_strings([
        handle,
        accession,
        assembly_name,
        *(source.get("aliases") or []),
        *(source.get("equivalent_accessions") or []),
    ])
    out: Dict[str, Any] = {
        "handle": str(handle),
        "accession": accession,
        "assembly": accession,
        "gca": accession if accession.upper().startswith("GC") else "",
        "assembly_name": assembly_name or accession,
        "scientific_name": species,
        "common_name": str(source.get("common_name") or "").strip(),
        "display_name": str(source.get("display_name") or "").strip(),
        "species_key": str(source.get("species_key") or "").strip(),
        "aliases": aliases,
        "equivalent_accessions": unique_strings(source.get("equivalent_accessions") or []),
    }
    provider = str(source.get("provider") or "").strip()
    if provider:
        out["provider"] = provider
    return out


def _genome_config_from_record(record: Any, handle: str) -> Dict[str, Any]:
    """Inverse of :func:`_genome_record_from_config`, dropping derived noise.

    Only fields a human would want to see or edit survive: the accession that
    establishes identity, and enough naming to recognise it. Aliases that are just
    restatements of the accession, the assembly name or the handle are dropped --
    they are regenerated on load, and keeping them is what made the old registry
    unreadable.
    """
    source = record if isinstance(record, dict) else {}
    accession = str(source.get("accession") or source.get("assembly") or source.get("gca") or "").strip()
    assembly_name = str(source.get("assembly_name") or "").strip()
    species = str(source.get("scientific_name") or "").strip()
    out: Dict[str, Any] = {}
    if accession:
        out["accession"] = accession
    if assembly_name and assembly_name != accession:
        out["assembly_name"] = assembly_name
    if species:
        out["species"] = species

    # An alias earns its place only if it says something the fields above do not.
    # Legacy records carried three kinds that do not: restatements of the accession
    # or assembly name, decorated forms of them such as
    # "ensembl:Homo_sapiens:GCA_000001405.29", and species-level names like "Human"
    # that are shared by every human assembly and so match all of them.
    implied = {
        normalize_token(value)
        for value in (
            accession,
            assembly_name,
            handle,
            species,
            source.get("common_name"),
            source.get("display_name"),
            source.get("species_key"),
            source.get("provider"),
        )
        if normalize_token(value)
    }

    def is_redundant(alias: str) -> bool:
        token = normalize_token(alias)
        if not token:
            return True
        return any(token == other or other in token for other in implied)

    extra = [alias for alias in unique_strings(source.get("aliases") or []) if not is_redundant(alias)]
    if extra:
        out["aliases"] = extra
    return out


def _handle_for_genome(record: Dict[str, Any], taken: Set[str]) -> str:
    """A short, readable, unique handle for a genome."""
    for candidate in (
        record.get("handle"),
        record.get("assembly_name"),
        record.get("display_name"),
        record.get("accession"),
        record.get("assembly"),
    ):
        base = str(candidate or "").strip()
        if not base:
            continue
        if base not in taken:
            return base
        suffix = 2
        while f"{base}.{suffix}" in taken:
            suffix += 1
        return f"{base}.{suffix}"
    base = "genome"
    suffix = 1
    while f"{base}{suffix}" in taken:
        suffix += 1
    return f"{base}{suffix}"


def genome_identity_key(record: Dict[str, Any]) -> str:
    """Group key for deciding whether two entries mean the same assembly."""
    for field in ("accession", "assembly", "gca", "assembly_name"):
        token = normalize_token(record.get(field))
        if token:
            return token
    return normalize_token(record.get("handle")) or "genome"


# ---------------------------------------------------------------------------
# Tracks
# ---------------------------------------------------------------------------


def _tracks_from_config(raw: Any, base_dir: Optional[Path], pointer: str,
                        diagnostics: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    if raw is None:
        return out
    if not isinstance(raw, list):
        diagnostics.append(diagnostic("error", pointer, "tracks must be a list."))
        return out
    for index, item in enumerate(raw):
        item_pointer = f"{pointer}/{index}"
        if isinstance(item, str):
            item = {"path": item}
        if not isinstance(item, dict):
            diagnostics.append(diagnostic("error", item_pointer, "A track must be an object or a path string."))
            continue
        path = _resolve_path(item.get("path") or item.get("url"), base_dir)
        if not path:
            diagnostics.append(diagnostic("error", f"{item_pointer}/path", "A track needs a path."))
            continue
        track_type = str(item.get("type") or "").strip().lower() or track_type_from_path(path)
        if track_type not in {"bigwig", "bigbed"}:
            diagnostics.append(diagnostic(
                "error",
                f"{item_pointer}/path",
                f"Unsupported track file '{Path(path).name}'. Expected a BigWig (.bw) or BigBed (.bb) file.",
            ))
            continue
        label = str(item.get("label") or item.get("name") or "").strip()
        if not label:
            label = "Signal" if track_type == "bigwig" else "SV intervals"
        out.append({"type": track_type, "label": label, "path": path})
    return out


def _tracks_to_config(tracks: Iterable[Dict[str, Any]], base_dir: Optional[Path]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for track in tracks or []:
        path = str(track.get("path") or "").strip()
        if not path:
            continue
        entry: Dict[str, Any] = {"path": _relativize(path, base_dir)}
        label = str(track.get("label") or "").strip()
        default_label = "Signal" if track.get("type") == "bigwig" else "SV intervals"
        if label and label != default_label:
            entry["label"] = label
        # Type is recoverable from the extension; only state it when it is not.
        if not track_type_from_path(path):
            entry["type"] = str(track.get("type") or "")
        out.append(entry)
    return out


def _relativize(path: Any, base_dir: Optional[Path]) -> str:
    """Write paths relative to the config when they sit under it, so bundles move."""
    text = str(path or "").strip()
    if not text or not base_dir:
        return text
    try:
        return str(Path(text).relative_to(Path(base_dir)))
    except ValueError:
        return text


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


def parse_sv_config(source: Any, base_dir: Optional[Path] = None) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """Read config text (or an already-decoded object) into a normalised config.

    Returns ``(config, diagnostics)``. The config is always returned, even when
    diagnostics contain errors, so the caller can show what was understood
    alongside what was not. Callers that intend to *use* the result must check
    :func:`has_errors` first.
    """
    diagnostics: List[Dict[str, Any]] = []

    if isinstance(source, (str, bytes)):
        text = source.decode("utf-8") if isinstance(source, bytes) else source
        if not text.strip():
            return _empty_config(), [diagnostic("error", "", "The configuration is empty.")]
        try:
            payload = json.loads(text)
        except json.JSONDecodeError as exc:
            return _empty_config(), [diagnostic("error", "", f"Invalid JSON: {exc.msg}", line=exc.lineno)]
    else:
        payload = source

    if not isinstance(payload, dict):
        return _empty_config(), [diagnostic("error", "", "The configuration must be a JSON object.")]

    if _looks_like_legacy_registry(payload):
        payload = migrate_legacy_registry(payload, base_dir=base_dir)

    version = payload.get(CONFIG_VERSION_KEY, CONFIG_VERSION)
    try:
        version_number = int(version)
    except (TypeError, ValueError):
        version_number = CONFIG_VERSION
        diagnostics.append(diagnostic("warning", CONFIG_VERSION_KEY, f"Unrecognised version {version!r}; assuming {CONFIG_VERSION}."))
    if version_number > CONFIG_VERSION:
        diagnostics.append(diagnostic(
            "warning",
            CONFIG_VERSION_KEY,
            f"This file declares version {version_number}, newer than the version {CONFIG_VERSION} this build understands. "
            "Unknown fields will be ignored.",
        ))

    genomes = _parse_genomes(payload.get("genomes"), base_dir, diagnostics)
    pairs = _parse_pairs(payload, genomes, base_dir, diagnostics)

    config = {
        CONFIG_VERSION_KEY: CONFIG_VERSION,
        "description": str(payload.get("description") or "").strip(),
        "genomes": genomes,
        "pairs": pairs,
    }
    return config, diagnostics


def _empty_config() -> Dict[str, Any]:
    return {CONFIG_VERSION_KEY: CONFIG_VERSION, "description": "", "genomes": {}, "pairs": []}


def _parse_genomes(raw: Any, base_dir: Optional[Path],
                   diagnostics: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    genomes: Dict[str, Dict[str, Any]] = {}
    if raw is None:
        return genomes
    if not isinstance(raw, dict):
        diagnostics.append(diagnostic("error", "genomes", "genomes must be an object mapping a handle to an assembly."))
        return genomes

    for handle, entry in raw.items():
        pointer = f"genomes/{handle}"
        if not isinstance(entry, dict):
            diagnostics.append(diagnostic("error", pointer, f"Genome '{handle}' must be an object."))
            continue
        record = _genome_record_from_config(str(handle), entry)
        if not record["accession"]:
            diagnostics.append(diagnostic(
                "error",
                f"{pointer}/accession",
                f"Genome '{handle}' needs an accession, for example GCA_000001405.29.",
            ))
        aliases_raw = entry.get("sequence_aliases")
        sequence_aliases: Dict[str, str] = {}
        if aliases_raw is not None:
            if isinstance(aliases_raw, dict):
                sequence_aliases = {
                    str(key).strip(): str(value).strip()
                    for key, value in aliases_raw.items()
                    if str(key).strip() and str(value).strip()
                }
            else:
                diagnostics.append(diagnostic(
                    "error",
                    f"{pointer}/sequence_aliases",
                    "sequence_aliases must map a name used by the alignment to the name used by the assembly.",
                ))
        record["sequence_aliases"] = sequence_aliases
        record["tracks"] = _tracks_from_config(entry.get("tracks"), base_dir, f"{pointer}/tracks", diagnostics)
        genomes[str(handle)] = record

    return genomes


def _parse_pairs(payload: Dict[str, Any], genomes: Dict[str, Dict[str, Any]],
                 base_dir: Optional[Path], diagnostics: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    raw_pairs = payload.get("pairs")
    if raw_pairs is None and isinstance(payload.get("alignments"), list):
        # Shorthand: a flat alignment list with no pair wrapper.
        raw_pairs = [{"alignments": payload.get("alignments")}]
    if raw_pairs is None:
        return []
    if not isinstance(raw_pairs, list):
        diagnostics.append(diagnostic("error", "pairs", "pairs must be a list."))
        return []

    seen_labels: Dict[str, str] = {}
    pairs: List[Dict[str, Any]] = []

    for pair_index, raw_pair in enumerate(raw_pairs):
        pointer = f"pairs/{pair_index}"
        if not isinstance(raw_pair, dict):
            diagnostics.append(diagnostic("error", pointer, "Each pair must be an object."))
            continue
        raw_alignments = raw_pair.get("alignments")
        if not isinstance(raw_alignments, list):
            diagnostics.append(diagnostic("error", f"{pointer}/alignments", "A pair needs an alignments list."))
            continue

        alignments: List[Dict[str, Any]] = []
        for align_index, raw_alignment in enumerate(raw_alignments):
            alignment = _parse_alignment(
                raw_alignment,
                genomes,
                base_dir,
                f"{pointer}/alignments/{align_index}",
                seen_labels,
                diagnostics,
            )
            if alignment:
                alignments.append(alignment)

        declared = raw_pair.get("genomes")
        handles: List[str] = []
        if isinstance(declared, list):
            for handle in declared:
                text = str(handle or "").strip()
                if not text:
                    continue
                if text not in genomes:
                    diagnostics.append(diagnostic(
                        "error",
                        f"{pointer}/genomes",
                        f"Pair names genome '{text}', which is not declared under genomes.",
                    ))
                    continue
                handles.append(text)
        elif declared is not None:
            diagnostics.append(diagnostic("error", f"{pointer}/genomes", "A pair's genomes must be a list of handles."))

        if not handles:
            for alignment in alignments:
                for handle in (alignment["reference"], alignment["target"]):
                    if handle and handle not in handles:
                        handles.append(handle)

        pairs.append({
            "genomes": handles,
            "label": str(raw_pair.get("label") or "").strip(),
            "description": str(raw_pair.get("description") or "").strip(),
            "alignments": alignments,
        })

    return pairs


def _parse_alignment(raw: Any, genomes: Dict[str, Dict[str, Any]], base_dir: Optional[Path],
                     pointer: str, seen_labels: Dict[str, str],
                     diagnostics: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict):
        diagnostics.append(diagnostic("error", pointer, "Each alignment must be an object."))
        return None

    label = str(raw.get("label") or "").strip()
    if not label:
        diagnostics.append(diagnostic("error", f"{pointer}/label", "An alignment needs a label."))
    else:
        key = label.lower()
        if key in seen_labels:
            diagnostics.append(diagnostic(
                "error",
                f"{pointer}/label",
                f"Label '{label}' is already used by {seen_labels[key]}. Labels identify an alignment, so they must be unique.",
            ))
        else:
            seen_labels[key] = pointer

    reference = str(raw.get("reference") or "").strip()
    target = str(raw.get("target") or "").strip()
    for field, handle in (("reference", reference), ("target", target)):
        if not handle:
            diagnostics.append(diagnostic("error", f"{pointer}/{field}", f"An alignment needs a {field} genome handle."))
        elif handle not in genomes:
            known = ", ".join(sorted(genomes)) or "none declared"
            diagnostics.append(diagnostic(
                "error",
                f"{pointer}/{field}",
                f"Unknown genome handle '{handle}'. Declared genomes: {known}.",
            ))
    if reference and target and reference == target:
        diagnostics.append(diagnostic(
            "error",
            f"{pointer}/target",
            "An alignment's reference and target must be different genomes.",
        ))

    chain = _resolve_path(raw.get("chain") or raw.get("chain_path") or raw.get("bigchain"), base_dir)
    if not chain:
        diagnostics.append(diagnostic("error", f"{pointer}/chain", "An alignment needs a chain file (*.bigChain.bb)."))

    declared_side = str(raw.get("indexed_side") or "").strip().lower()
    inferred_side = infer_indexed_side_from_filename(chain)
    if declared_side and declared_side not in INDEXED_SIDES:
        diagnostics.append(diagnostic(
            "error",
            f"{pointer}/indexed_side",
            f"indexed_side must be 'reference' or 'target', not {declared_side!r}.",
        ))
        declared_side = ""
    if declared_side and inferred_side and declared_side != inferred_side:
        diagnostics.append(diagnostic(
            "warning",
            f"{pointer}/indexed_side",
            f"indexed_side is '{declared_side}', but the file name suggests '{inferred_side}'. "
            "If no alignment ribbons appear, this is the first thing to check.",
        ))

    # Only present on records migrated from the era when sequence names came from a
    # side file. Carried through so migrating a working setup does not break it.
    legacy_mappings: Dict[str, str] = {}
    raw_legacy = raw.get("legacy_mappings")
    if isinstance(raw_legacy, dict):
        for key in ("reference_mapping", "target_mapping"):
            resolved = _resolve_path(raw_legacy.get(key), base_dir)
            if resolved:
                legacy_mappings[key] = resolved
    elif raw_legacy is not None:
        diagnostics.append(diagnostic(
            "error",
            f"{pointer}/legacy_mappings",
            "legacy_mappings must be an object with reference_mapping and target_mapping paths.",
        ))

    tracks: Dict[str, List[Dict[str, Any]]] = {}
    raw_tracks = raw.get("tracks")
    if isinstance(raw_tracks, dict):
        for handle, items in raw_tracks.items():
            handle_text = str(handle or "").strip()
            track_pointer = f"{pointer}/tracks/{handle_text}"
            if handle_text not in genomes:
                diagnostics.append(diagnostic(
                    "error",
                    track_pointer,
                    f"Tracks are listed for '{handle_text}', which is not a declared genome.",
                ))
                continue
            tracks[handle_text] = _tracks_from_config(items, base_dir, track_pointer, diagnostics)
    elif raw_tracks is not None:
        diagnostics.append(diagnostic(
            "error",
            f"{pointer}/tracks",
            "An alignment's tracks must be an object keyed by genome handle.",
        ))

    return {
        "id": str(raw.get("id") or "").strip() or slugify_label(label),
        "label": label,
        "description": str(raw.get("description") or "").strip(),
        "reference": reference,
        "target": target,
        "chain": chain,
        "indexed_side": declared_side,
        "inferred_indexed_side": inferred_side,
        "legacy_mappings": legacy_mappings,
        "tracks": tracks,
    }


def _looks_like_legacy_registry(payload: Any) -> bool:
    if not isinstance(payload, dict):
        return False
    if CONFIG_VERSION_KEY in payload or "pairs" in payload or "genomes" in payload:
        return False
    alignments = payload.get("alignments")
    if not isinstance(alignments, list):
        return False
    return any(
        isinstance(item, dict) and (
            "chain_path" in item or "ref_mapping_path" in item or "reference_genome" in item
        )
        for item in alignments
    )


# ---------------------------------------------------------------------------
# Config -> datasets
# ---------------------------------------------------------------------------


def config_to_datasets(config: Dict[str, Any], source: str = "config",
                       config_path: str = "") -> List[Dict[str, Any]]:
    """Flatten a parsed config into the dataset dicts the backend consumes.

    Genome-level tracks are applied first and alignment-level ones on top, so a
    BigWig declared once on a genome shows up for every alignment that genome takes
    part in without being repeated per direction. Duplicates are dropped on
    ``(type, path)``.

    Paths are already absolute here -- :func:`parse_sv_config` resolved them against
    the config's directory -- so this step needs no ``base_dir`` of its own.
    """
    genomes = config.get("genomes") or {}
    datasets: List[Dict[str, Any]] = []

    for pair_index, pair in enumerate(config.get("pairs") or []):
        for alignment in pair.get("alignments") or []:
            reference = genomes.get(alignment.get("reference") or "")
            target = genomes.get(alignment.get("target") or "")
            if not reference or not target:
                continue

            # Keyed on the assemblies, not on the handles. Handles are local to one
            # file, so two configs naming GRCh38 differently would otherwise put the
            # same genome pair in two different groups.
            pair_id = "__".join(sorted(
                token for token in (genome_identity_key(reference), genome_identity_key(target)) if token
            )) or f"pair_{pair_index}"

            indexed_side = alignment.get("indexed_side") or alignment.get("inferred_indexed_side") or "target"
            tracks = {
                "reference": _merge_tracks(
                    reference.get("tracks") or [],
                    (alignment.get("tracks") or {}).get(alignment.get("reference")) or [],
                    side="reference",
                ),
                "target": _merge_tracks(
                    target.get("tracks") or [],
                    (alignment.get("tracks") or {}).get(alignment.get("target")) or [],
                    side="target",
                ),
            }
            # Which of those were declared on the genome rather than on this
            # alignment. Rendering back to config has to put each one where the user
            # wrote it; inferring the level from what the tracks have in common gets
            # it wrong as soon as a genome has only one alignment.
            genome_level = {
                "reference": _track_keys(reference.get("tracks") or []),
                "target": _track_keys(target.get("tracks") or []),
            }

            datasets.append({
                "id": alignment.get("id") or slugify_label(alignment.get("label")),
                "alignment_id": alignment.get("id") or slugify_label(alignment.get("label")),
                "label": alignment.get("label") or "",
                "description": alignment.get("description") or "",
                "source": source,
                "config_path": str(config_path or ""),
                "pair_id": pair_id,
                "chain_path": alignment.get("chain") or "",
                "ref_mapping_path": (alignment.get("legacy_mappings") or {}).get("reference_mapping", ""),
                "tgt_mapping_path": (alignment.get("legacy_mappings") or {}).get("target_mapping", ""),
                "indexed_side": indexed_side,
                "reference_genome": _dataset_genome(reference),
                "target_genome": _dataset_genome(target),
                "ref_aliases": list(reference.get("aliases") or []),
                "tgt_aliases": list(target.get("aliases") or []),
                "reference_sequence_aliases": dict(reference.get("sequence_aliases") or {}),
                "target_sequence_aliases": dict(target.get("sequence_aliases") or {}),
                "tracks": tracks,
                "genome_level_tracks": genome_level,
            })

    return datasets


def _dataset_genome(record: Dict[str, Any]) -> Dict[str, Any]:
    out = {
        key: value for key, value in record.items()
        if key not in {"tracks", "sequence_aliases", "handle"}
    }
    out["handle"] = record.get("handle") or ""
    return out


def _track_keys(tracks: Iterable[Dict[str, Any]]) -> List[List[str]]:
    """Identity of each track, as JSON-safe pairs. Lists, not tuples, so this
    survives a round trip through the dataset dict when it is serialised."""
    out: List[List[str]] = []
    for track in tracks or []:
        path = str(track.get("path") or "").strip()
        if not path:
            continue
        out.append([str(track.get("type") or "") or track_type_from_path(path), path])
    return out


def _merge_tracks(*groups: Sequence[Dict[str, Any]], side: str) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    seen: Set[Tuple[str, str]] = set()
    for group in groups:
        for track in group or []:
            path = str(track.get("path") or "").strip()
            track_type = str(track.get("type") or "").strip() or track_type_from_path(path)
            if not path or track_type not in {"bigwig", "bigbed"}:
                continue
            key = (track_type, path)
            if key in seen:
                continue
            seen.add(key)
            out.append({
                "id": hashlib.sha1(f"{side}|{track_type}|{path}".encode("utf-8")).hexdigest()[:16],
                "side": side,
                "type": track_type,
                "label": str(track.get("label") or "").strip() or ("Signal" if track_type == "bigwig" else "SV intervals"),
                "path": path,
                "display_mode": "flatten",
            })
    return out


# ---------------------------------------------------------------------------
# Datasets -> config
# ---------------------------------------------------------------------------


def datasets_to_config(datasets: Iterable[Dict[str, Any]], base_dir: Optional[Path] = None,
                       description: str = "") -> Dict[str, Any]:
    """Render datasets back as a config a person can read.

    Genomes are de-duplicated by accession across every alignment, so a config
    holding ten comparisons against GRCh38 declares GRCh38 once. A track carried by
    every alignment of a genome is hoisted onto that genome for the same reason.
    """
    handles_by_identity: Dict[str, str] = {}
    genome_records: Dict[str, Dict[str, Any]] = {}
    taken: Set[str] = set()

    def handle_for(record: Any) -> str:
        source = record if isinstance(record, dict) else {}
        identity = genome_identity_key(source)
        if identity in handles_by_identity:
            return handles_by_identity[identity]
        handle = _handle_for_genome(source, taken)
        taken.add(handle)
        handles_by_identity[identity] = handle
        genome_records[handle] = dict(source)
        return handle

    entries: List[Dict[str, Any]] = []
    genome_track_keys: Dict[str, Set[Tuple[str, str]]] = {}
    tracks_by_handle: Dict[str, List[Dict[str, Any]]] = {}

    for dataset in datasets or []:
        reference = dataset.get("reference_genome") or {}
        target = dataset.get("target_genome") or {}
        ref_handle = handle_for(reference)
        tgt_handle = handle_for(target)

        dataset_tracks = dataset.get("tracks") or {}
        ref_tracks = list(dataset_tracks.get("reference") or [])
        tgt_tracks = list(dataset_tracks.get("target") or [])
        declared = dataset.get("genome_level_tracks") or {}
        for handle, side, tracks in ((ref_handle, "reference", ref_tracks), (tgt_handle, "target", tgt_tracks)):
            keys = {(str(key[0]), str(key[1])) for key in declared.get(side) or []}
            genome_track_keys.setdefault(handle, set()).update(keys)
            for track in tracks:
                key = (str(track.get("type") or ""), str(track.get("path") or ""))
                if key in keys:
                    tracks_by_handle.setdefault(handle, []).append(track)

        label = str(dataset.get("label") or "").strip() or str(dataset.get("id") or "").strip()
        entries.append({
            "pair_key": tuple(sorted((ref_handle, tgt_handle))),
            "ref_handle": ref_handle,
            "tgt_handle": tgt_handle,
            "label": label,
            "id": str(dataset.get("id") or "").strip(),
            "description": str(dataset.get("description") or "").strip(),
            "chain": str(dataset.get("chain_path") or ""),
            "indexed_side": str(dataset.get("indexed_side") or "target"),
            "ref_tracks": ref_tracks,
            "tgt_tracks": tgt_tracks,
            "sequence_aliases": {
                ref_handle: dict(dataset.get("reference_sequence_aliases") or {}),
                tgt_handle: dict(dataset.get("target_sequence_aliases") or {}),
            },
            # Legacy records that still name mapping TSVs keep them, so migrating a
            # registry never silently discards a working configuration.
            "ref_mapping_path": str(dataset.get("ref_mapping_path") or ""),
            "tgt_mapping_path": str(dataset.get("tgt_mapping_path") or ""),
        })

    genome_tracks: Dict[str, List[Dict[str, Any]]] = {}
    for handle, tracks in tracks_by_handle.items():
        seen: Set[Tuple[str, str]] = set()
        collected: List[Dict[str, Any]] = []
        for track in tracks:
            key = (str(track.get("type") or ""), str(track.get("path") or ""))
            if key in seen:
                continue
            seen.add(key)
            collected.append(track)
        genome_tracks[handle] = collected

    genomes: Dict[str, Any] = {}
    for handle, record in genome_records.items():
        entry = _genome_config_from_record(record, handle)
        aliases: Dict[str, str] = {}
        for item in entries:
            aliases.update(item["sequence_aliases"].get(handle) or {})
        if aliases:
            entry["sequence_aliases"] = aliases
        hoisted = genome_tracks.get(handle) or []
        if hoisted:
            entry["tracks"] = _tracks_to_config(hoisted, base_dir)
        genomes[handle] = entry

    pairs_by_key: Dict[Tuple[str, ...], Dict[str, Any]] = {}
    for item in entries:
        pair = pairs_by_key.setdefault(item["pair_key"], {"genomes": list(item["pair_key"]), "alignments": []})
        alignment: Dict[str, Any] = {
            "label": item["label"],
            "reference": item["ref_handle"],
            "target": item["tgt_handle"],
            "chain": _relativize(item["chain"], base_dir),
        }
        # An id that is just the slug of the label is noise -- it is regenerated on
        # load. One that is not was assigned before labels were the identity, and
        # dropping it would orphan anything still referring to the alignment by id.
        if item["id"] and item["id"] != slugify_label(item["label"]):
            alignment["id"] = item["id"]
        if item["description"]:
            alignment["description"] = item["description"]
        if item["indexed_side"] != infer_indexed_side_from_filename(item["chain"]):
            alignment["indexed_side"] = item["indexed_side"]

        extra_tracks: Dict[str, Any] = {}
        for handle, tracks in ((item["ref_handle"], item["ref_tracks"]), (item["tgt_handle"], item["tgt_tracks"])):
            hoisted_keys = {(t.get("type"), t.get("path")) for t in genome_tracks.get(handle) or []}
            remaining = [t for t in tracks if (t.get("type"), t.get("path")) not in hoisted_keys]
            if remaining:
                extra_tracks[handle] = _tracks_to_config(remaining, base_dir)
        if extra_tracks:
            alignment["tracks"] = extra_tracks

        for field, key in (("ref_mapping_path", "reference_mapping"), ("tgt_mapping_path", "target_mapping")):
            if item[field]:
                alignment.setdefault("legacy_mappings", {})[key] = _relativize(item[field], base_dir)

        pair["alignments"].append(alignment)

    config: Dict[str, Any] = {CONFIG_VERSION_KEY: CONFIG_VERSION}
    if description:
        config["description"] = description
    config["genomes"] = genomes
    config["pairs"] = list(pairs_by_key.values())
    return config


def config_to_document(config: Dict[str, Any], base_dir: Optional[Path] = None) -> Dict[str, Any]:
    """Parsed config -> the shape that belongs on disk.

    Parsing fills in everything a caller might need: absolute paths, generated ids,
    an inferred indexed side, empty defaults for absent fields. Writing that back
    verbatim would put all of it in the user's file, which is the readability
    problem this format exists to solve. Round-tripping through the dataset shape
    strips it down to what was actually stated.
    """
    return datasets_to_config(
        config_to_datasets(config),
        base_dir=base_dir,
        description=str(config.get("description") or ""),
    )


def serialize_sv_config(config: Dict[str, Any]) -> str:
    """Config object -> the exact text written to disk and shown in the editor."""
    return json.dumps(config, indent=2, ensure_ascii=False) + "\n"


# ---------------------------------------------------------------------------
# Legacy migration
# ---------------------------------------------------------------------------


def migrate_legacy_registry(payload: Any, base_dir: Optional[Path] = None) -> Dict[str, Any]:
    """Old registry / sidecar-manifest records -> the current config shape.

    Existing ids are preserved so a migrated registry keeps pointing at the same
    alignments; only the way the file reads changes.
    """
    if isinstance(payload, list):
        raw_items = payload
    elif isinstance(payload, dict):
        raw_items = payload.get("alignments") or []
    else:
        raw_items = []

    datasets: List[Dict[str, Any]] = []
    for raw in raw_items:
        if not isinstance(raw, dict):
            continue
        chain = _resolve_path(raw.get("chain_path") or raw.get("bigchain_path") or raw.get("chain"), base_dir)
        indexed_side = str(raw.get("indexed_side") or "").strip().lower()
        if indexed_side not in INDEXED_SIDES:
            indexed_side = infer_indexed_side_from_filename(chain) or "target"
        datasets.append({
            "id": str(raw.get("id") or raw.get("alignment_id") or "").strip(),
            "label": str(raw.get("label") or raw.get("name") or "").strip(),
            "description": str(raw.get("description") or "").strip(),
            "chain_path": chain,
            "ref_mapping_path": _resolve_path(raw.get("ref_mapping_path") or raw.get("reference_mapping_path"), base_dir),
            "tgt_mapping_path": _resolve_path(raw.get("tgt_mapping_path") or raw.get("target_mapping_path"), base_dir),
            "indexed_side": indexed_side,
            "reference_genome": raw.get("reference_genome") or raw.get("reference") or {},
            "target_genome": raw.get("target_genome") or raw.get("target") or raw.get("alt_genome") or {},
            "tracks": _legacy_tracks(raw, base_dir),
        })

    config = datasets_to_config(datasets, base_dir=base_dir)
    # Ids are meaningful in a migrated file: dropping them would renumber every
    # entry and orphan anything that referenced an alignment by id.
    by_label = {str(d.get("label") or "").strip().lower(): str(d.get("id") or "") for d in datasets}
    for pair in config.get("pairs") or []:
        for alignment in pair.get("alignments") or []:
            existing = by_label.get(str(alignment.get("label") or "").strip().lower())
            if existing:
                alignment["id"] = existing
    return config


def _legacy_tracks(raw: Dict[str, Any], base_dir: Optional[Path]) -> Dict[str, List[Dict[str, Any]]]:
    out: Dict[str, List[Dict[str, Any]]] = {"reference": [], "target": []}

    def append(side: str, value: Any, label: Any = "") -> None:
        path = _resolve_path(value, base_dir)
        track_type = track_type_from_path(path)
        if not path or track_type not in {"bigwig", "bigbed"}:
            return
        out[side].append({
            "type": track_type,
            "path": path,
            "label": str(label or "").strip() or ("Signal" if track_type == "bigwig" else "SV intervals"),
        })

    append("reference", raw.get("reference_bigwig_path") or raw.get("ref_bigwig_path"))
    append("reference", raw.get("reference_bigbed_path") or raw.get("ref_bigbed_path"))
    append("target", raw.get("target_bigwig_path") or raw.get("tgt_bigwig_path"))
    append("target", raw.get("target_bigbed_path") or raw.get("tgt_bigbed_path"))

    grouped = raw.get("tracks")
    if isinstance(grouped, dict):
        for side in ("reference", "target"):
            for item in grouped.get(side) or []:
                if isinstance(item, dict):
                    append(side, item.get("path") or item.get("url"), item.get("label") or item.get("name"))

    deduped: Dict[str, List[Dict[str, Any]]] = {"reference": [], "target": []}
    for side, tracks in out.items():
        seen: Set[Tuple[str, str]] = set()
        for track in tracks:
            key = (track["type"], track["path"])
            if key in seen:
                continue
            seen.add(key)
            deduped[side].append(track)
    return deduped


# ---------------------------------------------------------------------------
# Merging
# ---------------------------------------------------------------------------


def merge_sv_config(existing: Dict[str, Any], incoming: Dict[str, Any], mode: str = "merge") -> Dict[str, Any]:
    """Fold ``incoming`` into ``existing``.

    ``mode="replace"`` discards ``existing`` entirely. ``mode="merge"`` -- what
    "amend an existing config" does -- keeps every record whose label is not in
    ``incoming``, and replaces the ones that are. Label is the identity, so
    re-registering an alignment under the same label updates it in place even if
    every path changed.
    """
    if str(mode).strip().lower() == "replace":
        return dict(incoming)

    incoming_labels = {
        str(alignment.get("label") or "").strip().lower()
        for pair in incoming.get("pairs") or []
        for alignment in pair.get("alignments") or []
    }

    merged_genomes: Dict[str, Any] = dict(existing.get("genomes") or {})
    handle_remap: Dict[str, str] = {}
    identity_to_handle = {
        genome_identity_key({**(value or {}), "handle": handle}): handle
        for handle, value in merged_genomes.items()
    }
    for handle, value in (incoming.get("genomes") or {}).items():
        identity = genome_identity_key({**(value or {}), "handle": handle})
        established = identity_to_handle.get(identity)
        if established and established != handle:
            # The same assembly already has a handle here; keep the existing name so
            # the file does not grow two aliases for one genome.
            handle_remap[handle] = established
            merged_genomes[established] = {**(merged_genomes.get(established) or {}), **(value or {})}
            continue
        if handle in merged_genomes and not established:
            merged_genomes[handle] = {**(merged_genomes.get(handle) or {}), **(value or {})}
        else:
            merged_genomes[handle] = dict(value or {})
        identity_to_handle[identity] = handle

    def remap(handle: Any) -> str:
        text = str(handle or "")
        return handle_remap.get(text, text)

    pairs_by_key: Dict[Tuple[str, ...], Dict[str, Any]] = {}

    def add_pair(pair: Dict[str, Any], alignments: List[Dict[str, Any]]) -> None:
        if not alignments:
            return
        handles = [remap(handle) for handle in (pair.get("genomes") or [])]
        if not handles:
            for alignment in alignments:
                for handle in (alignment.get("reference"), alignment.get("target")):
                    if handle and handle not in handles:
                        handles.append(handle)
        key = tuple(sorted(handles))
        slot = pairs_by_key.setdefault(key, {"genomes": list(key), "alignments": []})
        slot["alignments"].extend(alignments)

    for pair in existing.get("pairs") or []:
        kept = [
            {**alignment,
             "reference": remap(alignment.get("reference")),
             "target": remap(alignment.get("target"))}
            for alignment in pair.get("alignments") or []
            if str(alignment.get("label") or "").strip().lower() not in incoming_labels
        ]
        add_pair(pair, kept)

    for pair in incoming.get("pairs") or []:
        arrived = [
            {**alignment,
             "reference": remap(alignment.get("reference")),
             "target": remap(alignment.get("target"))}
            for alignment in pair.get("alignments") or []
        ]
        add_pair(pair, arrived)

    used_handles = {
        handle
        for pair in pairs_by_key.values()
        for alignment in pair["alignments"]
        for handle in (alignment.get("reference"), alignment.get("target"))
        if handle
    }

    return {
        CONFIG_VERSION_KEY: CONFIG_VERSION,
        "description": str(existing.get("description") or incoming.get("description") or ""),
        "genomes": {handle: value for handle, value in merged_genomes.items() if handle in used_handles},
        "pairs": list(pairs_by_key.values()),
    }


def remove_alignment(config: Dict[str, Any], alignment_id: str) -> Tuple[Dict[str, Any], bool]:
    """Drop one alignment by id or label; also drops any pair left empty."""
    wanted = str(alignment_id or "").strip().lower()
    if not wanted:
        return config, False
    removed = False
    pairs: List[Dict[str, Any]] = []
    for pair in config.get("pairs") or []:
        kept = []
        for alignment in pair.get("alignments") or []:
            identifiers = {
                str(alignment.get("id") or "").strip().lower(),
                slugify_label(alignment.get("label")).lower(),
                str(alignment.get("label") or "").strip().lower(),
            }
            if wanted in identifiers:
                removed = True
                continue
            kept.append(alignment)
        if kept:
            pairs.append({**pair, "alignments": kept})
    if not removed:
        return config, False

    used_handles = {
        handle
        for pair in pairs
        for alignment in pair["alignments"]
        for handle in (alignment.get("reference"), alignment.get("target"))
        if handle
    }
    return {
        **config,
        "genomes": {h: v for h, v in (config.get("genomes") or {}).items() if h in used_handles},
        "pairs": pairs,
    }, True
