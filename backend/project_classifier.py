from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import requests


DEFAULT_PROJECT_ARTIFACT_PATH = Path(__file__).resolve().parent / "data" / "project_classification.json"
PROJECTS_INDEX_URL = "https://projects.ensembl.org/"
GCA_RE = re.compile(r"\bGCA_\d{9}\.\d+\b")


@dataclass(frozen=True)
class ProjectPageSpec:
    code: str
    title: str
    urls: Tuple[str, ...]


PROJECT_PAGE_SPECS: Tuple[ProjectPageSpec, ...] = (
    ProjectPageSpec(
        "DToL",
        "Darwin Tree of Life",
        ("https://projects.ensembl.org/darwin-tree-of-life/",),
    ),
    ProjectPageSpec(
        "VGP",
        "Vertebrate Genomes Project",
        ("https://projects.ensembl.org/vgp/",),
    ),
    ProjectPageSpec(
        "HPRC",
        "Human Pangenome Reference Consortium",
        ("https://projects.ensembl.org/hprc/",),
    ),
    ProjectPageSpec(
        "ERGA",
        "European Reference Genome Atlas",
        (
            "https://projects.ensembl.org/erga-bge/",
            "https://projects.ensembl.org/erga-pilot/",
        ),
    ),
    ProjectPageSpec(
        "CEBP",
        "Canada BioGenome Project",
        ("https://projects.ensembl.org/cbp/",),
    ),
    ProjectPageSpec(
        "ASG",
        "Aquatic Symbiosis Genomics Project",
        ("https://projects.ensembl.org/asg/",),
    ),
)

PROJECT_ORDER: Tuple[str, ...] = tuple(spec.code for spec in PROJECT_PAGE_SPECS)


class ProjectMetadataRefreshError(RuntimeError):
    pass


def _now_iso_utc() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def extract_gca_accessions(html: str) -> List[str]:
    seen = set()
    out: List[str] = []
    for match in GCA_RE.finditer(str(html or "")):
        accession = match.group(0)
        if accession in seen:
            continue
        seen.add(accession)
        out.append(accession)
    return out


def _fetch_text(url: str, timeout: float = 20.0) -> str:
    response = requests.get(
        url,
        timeout=timeout,
        headers={"User-Agent": "ensembl-local-project-classifier/1.0"},
    )
    response.raise_for_status()
    return response.text


def build_project_artifact(
    fetcher: Optional[Any] = None,
    specs: Sequence[ProjectPageSpec] = PROJECT_PAGE_SPECS,
) -> Dict[str, Any]:
    fetch = fetcher or _fetch_text
    projects: Dict[str, Dict[str, Any]] = {}
    all_accessions = set()
    errors: List[Dict[str, str]] = []

    for spec in specs:
        seen = set()
        accessions: List[str] = []
        page_counts: Dict[str, int] = {}
        for url in spec.urls:
            try:
                page_accessions = extract_gca_accessions(fetch(url))
                page_counts[url] = len(page_accessions)
                for accession in page_accessions:
                    if accession in seen:
                        continue
                    seen.add(accession)
                    accessions.append(accession)
                    all_accessions.add(accession)
            except Exception as exc:
                page_counts[url] = 0
                errors.append({"project": spec.code, "url": url, "error": str(exc)})

        projects[spec.code] = {
            "code": spec.code,
            "title": spec.title,
            "urls": list(spec.urls),
            "accessions": accessions,
            "count": len(accessions),
            "page_counts": page_counts,
        }

    return {
        "schema_version": 1,
        "metadata": {
            "generated_at": _now_iso_utc(),
            "source_index": PROJECTS_INDEX_URL,
            "generator": "backend/project_classifier.py",
            "project_count": len(projects),
            "unique_accession_count": len(all_accessions),
            "errors": errors,
        },
        "project_order": list(PROJECT_ORDER),
        "projects": projects,
    }


def load_project_artifact(path: Path) -> Dict[str, Any]:
    try:
        if not path.exists():
            return {}
        with path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def save_project_artifact(path: Path, artifact: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(artifact, indent=2, sort_keys=True), encoding="utf-8")


class ProjectMembershipClassifier:
    def __init__(
        self,
        artifact_path: Optional[Path] = None,
        fallback_artifact_path: Optional[Path] = None,
        artifact: Optional[Dict[str, Any]] = None,
    ):
        self.artifact_path = Path(artifact_path or DEFAULT_PROJECT_ARTIFACT_PATH)
        self.fallback_artifact_path = Path(fallback_artifact_path) if fallback_artifact_path else None
        if isinstance(artifact, dict):
            self.artifact = artifact
        else:
            self.artifact = load_project_artifact(self.artifact_path)
            if not self.artifact and self.fallback_artifact_path:
                self.artifact = load_project_artifact(self.fallback_artifact_path)
        self._accession_to_projects = self._build_accession_lookup()

    def _build_accession_lookup(self) -> Dict[str, List[str]]:
        lookup: Dict[str, List[str]] = {}
        projects = self.artifact.get("projects") if isinstance(self.artifact, dict) else {}
        order = list(self.artifact.get("project_order") or PROJECT_ORDER)
        ordered_codes = [code for code in order if isinstance((projects or {}).get(code), dict)]
        ordered_codes.extend(code for code in (projects or {}) if code not in ordered_codes)
        for code in ordered_codes:
            project = (projects or {}).get(code) or {}
            for accession in project.get("accessions") or []:
                key = str(accession or "").strip().upper()
                if not key:
                    continue
                lookup.setdefault(key, [])
                if code not in lookup[key]:
                    lookup[key].append(code)
        return lookup

    def refresh(self, output_path: Optional[Path] = None) -> Dict[str, Any]:
        artifact = build_project_artifact()
        metadata = artifact.get("metadata") or {}
        if int(metadata.get("unique_accession_count") or 0) == 0 and metadata.get("errors"):
            raise ProjectMetadataRefreshError("No project accessions could be fetched; keeping existing project metadata")
        save_project_artifact(Path(output_path or self.artifact_path), artifact)
        self.artifact = artifact
        self._accession_to_projects = self._build_accession_lookup()
        return artifact

    def projects_for_accessions(self, accessions: Iterable[str]) -> List[str]:
        seen = set()
        out: List[str] = []
        for raw in accessions:
            accession = str(raw or "").strip().upper()
            if not accession:
                continue
            for code in self._accession_to_projects.get(accession, []):
                if code in seen:
                    continue
                seen.add(code)
                out.append(code)
        return out

    def status(self) -> Dict[str, Any]:
        projects = self.artifact.get("projects") if isinstance(self.artifact, dict) else {}
        metadata = self.artifact.get("metadata") if isinstance(self.artifact, dict) else {}
        return {
            "available": bool(projects),
            "path": str(self.artifact_path),
            "fallback_path": str(self.fallback_artifact_path or ""),
            "generated_at": str((metadata or {}).get("generated_at") or ""),
            "project_count": len(projects or {}),
            "unique_accession_count": int((metadata or {}).get("unique_accession_count") or 0),
            "errors": list((metadata or {}).get("errors") or []),
        }
