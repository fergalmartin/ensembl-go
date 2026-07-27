#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
BACKEND_DIR = SCRIPT_DIR.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from project_classifier import build_project_artifact, save_project_artifact  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate compact Ensembl project accession metadata.")
    parser.add_argument("--output", type=Path, default=BACKEND_DIR / "data" / "project_classification.json")
    parser.add_argument("--audit-only", action="store_true", help="Fetch and report but do not write the artifact.")
    args = parser.parse_args()

    artifact = build_project_artifact()
    if not args.audit_only:
        save_project_artifact(args.output, artifact)

    summary = {
        "wrote": not args.audit_only,
        "output": str(args.output),
        "generated_at": artifact.get("metadata", {}).get("generated_at", ""),
        "unique_accession_count": artifact.get("metadata", {}).get("unique_accession_count", 0),
        "projects": {
            code: {
                "count": project.get("count", 0),
                "urls": project.get("urls", []),
            }
            for code, project in sorted((artifact.get("projects") or {}).items())
        },
        "errors": artifact.get("metadata", {}).get("errors", []),
    }
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
