"""Draft storage and portable packages for declarative Ensembl Go tutorials.

The package format contains JSON and optional generated dataset assets only.  Imports are
validated before extraction, every member is hashed, and archive paths are treated as
untrusted.  This module deliberately knows nothing about the tutorial runtime; the same
functions are usable by the API, tests and the source-checkout promotion script.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Dict, Iterable, List, Optional


FORMAT = "ensembl-go-tutorial"
SCHEMA_VERSION = 1
PACKAGE_EXTENSION = ".egtutorial"
MAX_PACKAGE_BYTES = 100 * 1024 * 1024
MAX_MEMBER_BYTES = 100 * 1024 * 1024
MAX_MEMBERS = 128
TUTORIALS_DIRNAME = "tutorials"
DRAFTS_DIRNAME = "drafts"
ALLOWED_DATA_SUFFIXES = {
    ".json", ".fa", ".fasta", ".fna", ".bgz", ".gz", ".gff", ".gff3", ".gtf",
    ".fai", ".gzi", ".tbi", ".txt", ".db",
}
FORBIDDEN_KEYS = {"selector", "selectorTemplate", "script", "javascript", "code", "url"}
RESERVED_TUTORIAL_IDS = {"getting-started", "browser-in-depth"}
SAFE_CAPABILITIES = {"spotlight", "activate", "input", "set-state", "scroll", "pan", "zoom", "set-locus", "read-state"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _slug(value: Any) -> str:
    text = re.sub(r"[^a-z0-9]+", "-", str(value or "").lower()).strip("-")
    return text or "tutorial"


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _atomic_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def tutorials_root(output_dir: Any) -> Path:
    text = str(output_dir or "").strip()
    if not text:
        raise ValueError("An output directory is required.")
    root = Path(text).expanduser().resolve()
    if root.exists() and not root.is_dir():
        raise ValueError("The output directory is not a directory.")
    return root / TUTORIALS_DIRNAME


def drafts_root(output_dir: Any) -> Path:
    return tutorials_root(output_dir) / DRAFTS_DIRNAME


def _draft_path(output_dir: Any, tutorial_id: Any) -> Path:
    identifier = str(tutorial_id or "").strip()
    if not identifier or _slug(identifier) != identifier:
        raise ValueError("Tutorial ids must contain lowercase letters, numbers and hyphens only.")
    directory = drafts_root(output_dir) / identifier
    if directory.is_symlink():
        raise ValueError("A tutorial draft directory may not be a symlink.")
    return directory / "tutorial.json"


def draft_directory(output_dir: Any, tutorial_id: Any) -> Path:
    """The validated directory owned by one draft (never a caller-composed path)."""
    return _draft_path(output_dir, tutorial_id).parent


def _portable_problems(value: Any, path: str = "tutorial") -> List[str]:
    problems: List[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}"
            if key in FORBIDDEN_KEYS:
                problems.append(f"{child_path} is not allowed in a portable tutorial.")
            if key == "capability" and isinstance(child, str) and child not in SAFE_CAPABILITIES:
                problems.append(f'{child_path} uses unsupported capability "{child}".')
            if key == "capabilities" and isinstance(child, list):
                for capability in child:
                    if not isinstance(capability, str) or capability not in SAFE_CAPABILITIES:
                        problems.append(f'{child_path} uses unsupported capability "{capability}".')
            problems.extend(_portable_problems(child, child_path))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            problems.extend(_portable_problems(child, f"{path}[{index}]"))
    elif isinstance(value, str):
        if value.startswith(("file://", "/Users/", "/home/")) or re.match(r"^[A-Za-z]:[\\/]", value):
            problems.append(f"{path} contains an absolute local path.")
    return problems


def validate_document(document: Any, *, portable: bool = True) -> List[str]:
    if not isinstance(document, dict):
        return ["The tutorial document must be an object."]
    problems: List[str] = []
    if document.get("format") != FORMAT:
        problems.append(f'Tutorial format must be "{FORMAT}".')
    if document.get("schemaVersion") != SCHEMA_VERSION:
        problems.append(f"Tutorial schema v{document.get('schemaVersion', '?')} is not supported.")
    identifier = str(document.get("id") or "").strip()
    if not identifier:
        problems.append("Tutorial has no id.")
    elif _slug(identifier) != identifier:
        problems.append("Tutorial ids must contain lowercase letters, numbers and hyphens only.")
    if not str(document.get("title") or "").strip():
        problems.append("Tutorial has no title.")
    steps = document.get("steps")
    if not isinstance(steps, list) or not steps:
        problems.append("Tutorial has no steps.")
    else:
        seen = set()
        for index, step in enumerate(steps, 1):
            if not isinstance(step, dict):
                problems.append(f"Step {index} must be an object.")
                continue
            identifier = str(step.get("id") or "").strip()
            if not identifier:
                problems.append(f"Step {index} has no id.")
            elif identifier in seen:
                problems.append(f'Step {index} duplicates step id "{identifier}".')
            seen.add(identifier)
            if not str(step.get("title") or "").strip():
                problems.append(f"Step {index} has no title.")
            if not str(step.get("body") or "").strip():
                problems.append(f"Step {index} has no body.")
    if portable:
        problems.extend(_portable_problems(document))
    return list(dict.fromkeys(problems))


def bundled_datasets(tutorial_id: Any) -> Path:
    return Path(__file__).resolve().parent / "data" / "tutorials" / _slug(tutorial_id) / "datasets"


def find_bundled_recipe(recipe_id: str) -> Optional[Path]:
    if not recipe_id or _slug(recipe_id) != recipe_id:
        return None
    root = Path(__file__).resolve().parent / "data" / "tutorials"
    return next((p for p in root.glob(f"*/datasets/{recipe_id}") if p.is_dir() and not p.is_symlink()), None)


def save_draft(output_dir: Any, document: Dict[str, Any]) -> Dict[str, Any]:
    problems = validate_document(document, portable=True)
    if problems:
        raise ValueError(" ".join(problems))
    if str(document.get("id") or "") in RESERVED_TUTORIAL_IDS:
        raise ValueError("Built-in tutorial ids are reserved; clone the tutorial to a draft first.")
    destination = draft_directory(output_dir, document["id"]) / "datasets"
    for dataset in document.get("datasets") or []:
        if not isinstance(dataset, dict) or not dataset.get("embedded"):
            continue
        recipe = find_bundled_recipe(str(dataset.get("recipeId") or ""))
        if recipe and not (destination / recipe.name).exists():
            shutil.copytree(recipe, destination / recipe.name)
    saved = json.loads(json.dumps(document))
    saved["updatedAt"] = _now()
    saved["revision"] = max(1, int(saved.get("revision") or 1))
    path = _draft_path(output_dir, saved["id"])
    _atomic_json(path, saved)
    return {"saved": True, "path": str(path), "tutorial": saved}


def load_draft(output_dir: Any, tutorial_id: Any) -> Dict[str, Any]:
    path = _draft_path(output_dir, tutorial_id)
    if not path.is_file():
        raise FileNotFoundError(f"Tutorial draft {tutorial_id} was not found.")
    return json.loads(path.read_text(encoding="utf-8"))


def list_drafts(output_dir: Any) -> List[Dict[str, Any]]:
    root = drafts_root(output_dir)
    if not root.is_dir():
        return []
    result = []
    for path in sorted(root.glob("*/tutorial.json")):
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
            problems = validate_document(document, portable=True)
            result.append({"tutorial": document, "problems": problems, "path": str(path)})
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            result.append({"tutorial": None, "problems": [str(exc)], "path": str(path)})
    return result


def save_checkpoint(output_dir: Any, tutorial_id: Any, name: Any, document: Dict[str, Any]) -> Dict[str, Any]:
    problems = validate_document(document, portable=True)
    if problems:
        raise ValueError(" ".join(problems))
    draft_path = _draft_path(output_dir, tutorial_id)
    label = str(name or "").strip() or "Checkpoint"
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    path = draft_path.parent / "checkpoints" / f"{stamp}-{_slug(label)}.json"
    payload = {"name": label, "at": _now(), "tutorial": json.loads(json.dumps(document))}
    _atomic_json(path, payload)
    return {"saved": True, "checkpoint": {**payload, "path": str(path)}}


def list_checkpoints(output_dir: Any, tutorial_id: Any) -> List[Dict[str, Any]]:
    root = _draft_path(output_dir, tutorial_id).parent / "checkpoints"
    if not root.is_dir() or root.is_symlink():
        return []
    result = []
    for path in sorted(root.glob("*.json")):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            if not validate_document(payload.get("tutorial"), portable=True):
                result.append({**payload, "path": str(path)})
        except (OSError, ValueError, json.JSONDecodeError):
            continue
    return result


def delete_draft(output_dir: Any, tutorial_id: Any) -> bool:
    path = _draft_path(output_dir, tutorial_id)
    if not path.exists():
        return False
    directory = path.parent
    # Draft directories are deliberately shallow and may contain generated assets.  Do
    # not follow symlinks when removing them.
    if directory.is_symlink():
        raise ValueError("A tutorial draft directory may not be a symlink.")
    import shutil
    shutil.rmtree(directory)
    return True


def _asset_paths(draft_path: Path, document: Dict[str, Any]) -> Iterable[Path]:
    assets = draft_path.parent / "datasets"
    if not assets.is_dir() or assets.is_symlink():
        return []
    paths: List[Path] = []
    for dataset in document.get("datasets") or []:
        if not isinstance(dataset, dict) or not dataset.get("embedded"):
            continue
        recipe_id = str(dataset.get("recipeId") or "").strip()
        if not recipe_id or _slug(recipe_id) != recipe_id:
            continue
        recipe_root = assets / recipe_id
        if not recipe_root.is_dir() or recipe_root.is_symlink():
            continue
        paths.extend(path for path in recipe_root.rglob("*") if path.is_file() and not path.is_symlink())
    return sorted(set(paths))


def export_package(output_dir: Any, tutorial_id: Any, destination: Any) -> Dict[str, Any]:
    document = load_draft(output_dir, tutorial_id)
    problems = validate_document(document, portable=True)
    if problems:
        raise ValueError(" ".join(problems))
    path = Path(str(destination or "").strip()).expanduser().resolve()
    if path.suffix.lower() != PACKAGE_EXTENSION:
        path = path.with_suffix(PACKAGE_EXTENSION)
    path.parent.mkdir(parents=True, exist_ok=True)
    draft_path = _draft_path(output_dir, tutorial_id)
    tutorial_bytes = (json.dumps(document, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    files = [{"path": "tutorial.json", "sha256": _sha256(tutorial_bytes), "size": len(tutorial_bytes)}]
    assets: List[tuple[str, bytes]] = []
    for asset in _asset_paths(draft_path, document):
        relative = PurePosixPath("datasets") / PurePosixPath(asset.relative_to(draft_path.parent / "datasets").as_posix())
        if asset.suffix.lower() not in ALLOWED_DATA_SUFFIXES:
            raise ValueError(f"Unsupported tutorial asset: {asset.name}")
        data = asset.read_bytes()
        if len(data) > MAX_MEMBER_BYTES:
            raise ValueError(f"Tutorial asset is too large: {asset.name}")
        files.append({"path": str(relative), "sha256": _sha256(data), "size": len(data)})
        assets.append((str(relative), data))
    if sum(entry["size"] for entry in files) > MAX_PACKAGE_BYTES:
        raise ValueError("The tutorial package exceeds the 100 MB uncompressed limit.")
    manifest = {
        "format": FORMAT,
        "schemaVersion": SCHEMA_VERSION,
        "tutorialId": document["id"],
        "createdAt": _now(),
        "files": files,
    }
    manifest_bytes = (json.dumps(manifest, indent=2) + "\n").encode("utf-8")
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        archive.writestr("manifest.json", manifest_bytes)
        archive.writestr("tutorial.json", tutorial_bytes)
        for name, data in assets:
            archive.writestr(name, data)
    if path.stat().st_size > MAX_PACKAGE_BYTES:
        path.unlink(missing_ok=True)
        raise ValueError("The tutorial package exceeds the 100 MB limit.")
    return {"exported": True, "path": str(path), "manifest": manifest}


def _safe_member(info: zipfile.ZipInfo) -> PurePosixPath:
    name = PurePosixPath(info.filename)
    if info.is_dir() or name.is_absolute() or ".." in name.parts or "\\" in info.filename:
        raise ValueError(f"Unsafe tutorial package member: {info.filename}")
    if info.file_size > MAX_MEMBER_BYTES:
        raise ValueError(f"Tutorial package member is too large: {info.filename}")
    # Unix symlink mode in the top file-type bits.
    if ((info.external_attr >> 16) & 0o170000) == 0o120000:
        raise ValueError(f"Tutorial packages may not contain symlinks: {info.filename}")
    return name


def scan_package(source: Any) -> Dict[str, Any]:
    path = Path(str(source or "").strip()).expanduser().resolve()
    if not path.is_file() or path.stat().st_size > MAX_PACKAGE_BYTES:
        raise ValueError("Tutorial package is missing or exceeds the 100 MB limit.")
    if not zipfile.is_zipfile(path):
        raise ValueError("The selected file is not a tutorial package.")
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        if len(infos) > MAX_MEMBERS:
            raise ValueError("The tutorial package contains too many files.")
        names = {_safe_member(info): info for info in infos if not info.is_dir()}
        if len(names) != len([info for info in infos if not info.is_dir()]):
            raise ValueError("The tutorial package contains duplicate file names.")
        if sum(info.file_size for info in names.values()) > MAX_PACKAGE_BYTES:
            raise ValueError("The tutorial package exceeds the 100 MB uncompressed limit.")
        if PurePosixPath("manifest.json") not in names or PurePosixPath("tutorial.json") not in names:
            raise ValueError("Tutorial packages need manifest.json and tutorial.json.")
        manifest = json.loads(archive.read("manifest.json"))
        document = json.loads(archive.read("tutorial.json"))
        if manifest.get("format") != FORMAT or manifest.get("schemaVersion") != SCHEMA_VERSION:
            raise ValueError("The tutorial package format is not supported.")
        problems = validate_document(document, portable=True)
        if str(manifest.get("tutorialId") or "") != str(document.get("id") or ""):
            problems.append("The package manifest tutorial id does not match tutorial.json.")
        listed = {str(entry.get("path") or ""): entry for entry in manifest.get("files") or []}
        for member, info in names.items():
            if str(member) == "manifest.json":
                continue
            if str(member) != "tutorial.json":
                if not member.parts or member.parts[0] != "datasets" or Path(member.name).suffix.lower() not in ALLOWED_DATA_SUFFIXES:
                    problems.append(f"Unsupported tutorial package member: {member}.")
            entry = listed.get(str(member))
            if not entry:
                problems.append(f"Package member {member} is not declared in the manifest.")
                continue
            data = archive.read(info)
            if len(data) != int(entry.get("size") or -1) or _sha256(data) != entry.get("sha256"):
                problems.append(f"Package member {member} does not match its manifest hash.")
        for declared in listed:
            if PurePosixPath(declared) not in names:
                problems.append(f"Manifest member {declared} is missing.")
        return {
            "path": str(path),
            "manifest": manifest,
            "tutorial": document,
            "problems": list(dict.fromkeys(problems)),
            "compatible": not problems,
            "packageBytes": path.stat().st_size,
        }


def import_package(source: Any, output_dir: Any) -> Dict[str, Any]:
    scan = scan_package(source)
    if scan["problems"]:
        raise ValueError(" ".join(scan["problems"]))
    document = scan["tutorial"]
    if str(document.get("id") or "") in RESERVED_TUTORIAL_IDS:
        raise ValueError("The package uses a reserved built-in tutorial id.")
    destination = _draft_path(output_dir, document["id"]).parent
    destination.mkdir(parents=True, exist_ok=True)
    source_path = Path(scan["path"])
    with zipfile.ZipFile(source_path) as archive:
        for info in archive.infolist():
            member = _safe_member(info)
            if info.is_dir() or str(member) == "manifest.json":
                continue
            target = destination / Path(*member.parts)
            resolved = target.resolve()
            if destination.resolve() not in resolved.parents and resolved != destination.resolve():
                raise ValueError(f"Unsafe tutorial package member: {member}")
            target.parent.mkdir(parents=True, exist_ok=True)
            data = archive.read(info)
            fd, temporary = tempfile.mkstemp(prefix=f".{target.name}.", dir=str(target.parent))
            try:
                with os.fdopen(fd, "wb") as handle:
                    handle.write(data)
                os.replace(temporary, target)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
    return {"imported": True, "tutorial": document, "path": str(destination)}


def promote_draft(output_dir: Any, tutorial_id: Any, repository_root: Any) -> Dict[str, Any]:
    document = load_draft(output_dir, tutorial_id)
    problems = validate_document(document, portable=True)
    if problems:
        raise ValueError(" ".join(problems))
    root = Path(repository_root).resolve()
    generated = root / "frontend" / "src" / "tutorials" / "generated"
    registry = root / "frontend" / "src" / "tutorials" / "generatedTutorials.js"
    if not (root / "frontend" / "src" / "tutorials").is_dir():
        raise ValueError("Promotion is only available in an Ensembl Go source checkout.")
    generated.mkdir(parents=True, exist_ok=True)
    identifier = _slug(document["id"])
    assets = draft_directory(output_dir, tutorial_id) / "datasets"
    if assets.is_dir():
        shutil.copytree(assets, root / "backend" / "data" / "tutorials" / identifier / "datasets", dirs_exist_ok=True)
    destination = generated / f"{identifier}.tutorial.json"
    _atomic_json(destination, document)
    modules = sorted(path for path in generated.glob("*.tutorial.json") if path.is_file())
    lines = ["// Generated tutorial registry. Rebuilt by the internal promotion command."]
    names = []
    for index, module in enumerate(modules):
        name = f"generatedTutorial{index + 1}"
        names.append(name)
        lines.append(f"import {name} from './generated/{module.name}' with {{ type: 'json' }}")
    lines.append("")
    lines.append(f"export const GENERATED_TUTORIALS = Object.freeze([{', '.join(names)}])")
    lines.append("")
    registry.write_text("\n".join(lines), encoding="utf-8")
    return {"promoted": True, "tutorial": str(destination), "registry": str(registry)}
