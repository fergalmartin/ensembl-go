import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from project_classifier import (  # noqa: E402
    ProjectMembershipClassifier,
    ProjectMetadataRefreshError,
    ProjectPageSpec,
    build_project_artifact,
    extract_gca_accessions,
    save_project_artifact,
)


class ProjectClassifierTests(unittest.TestCase):
    def test_extract_gca_accessions_deduplicates_in_order(self):
        html = "A GCA_000000001.1 B GCA_000000002.3 C GCA_000000001.1"
        self.assertEqual(extract_gca_accessions(html), ["GCA_000000001.1", "GCA_000000002.3"])

    def test_combined_project_pages_deduplicate_versioned_accessions(self):
        pages = {
            "https://example.test/main/": "GCA_000000001.1 GCA_000000002.1",
            "https://example.test/pilot/": "GCA_000000002.1 GCA_000000002.2",
        }
        artifact = build_project_artifact(
            fetcher=lambda url: pages[url],
            specs=(
                ProjectPageSpec(
                    "ERGA",
                    "European Reference Genome Atlas",
                    ("https://example.test/main/", "https://example.test/pilot/"),
                ),
            ),
        )

        self.assertEqual(
            artifact["projects"]["ERGA"]["accessions"],
            ["GCA_000000001.1", "GCA_000000002.1", "GCA_000000002.2"],
        )
        self.assertEqual(artifact["metadata"]["unique_accession_count"], 3)

    def test_membership_classifier_preserves_project_order(self):
        artifact = build_project_artifact(
            fetcher=lambda url: {
                "https://example.test/dtol/": "GCA_000000001.1",
                "https://example.test/vgp/": "GCA_000000001.1 GCA_000000002.1",
            }[url],
            specs=(
                ProjectPageSpec("DToL", "Darwin Tree of Life", ("https://example.test/dtol/",)),
                ProjectPageSpec("VGP", "Vertebrate Genomes Project", ("https://example.test/vgp/",)),
            ),
        )
        classifier = ProjectMembershipClassifier(artifact=artifact)

        self.assertEqual(classifier.projects_for_accessions(["GCA_000000001.1"]), ["DToL", "VGP"])
        self.assertEqual(classifier.projects_for_accessions(["GCA_000000002.1"]), ["VGP"])

    def test_loads_cached_artifact_before_bundled_fallback(self):
        bundled = {
            "schema_version": 1,
            "project_order": ["DToL"],
            "projects": {"DToL": {"accessions": ["GCA_000000001.1"]}},
        }
        cached = {
            "schema_version": 1,
            "project_order": ["VGP"],
            "projects": {"VGP": {"accessions": ["GCA_000000002.1"]}},
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            bundled_path = root / "bundled.json"
            cached_path = root / "cached.json"
            save_project_artifact(bundled_path, bundled)
            save_project_artifact(cached_path, cached)

            classifier = ProjectMembershipClassifier(
                artifact_path=cached_path,
                fallback_artifact_path=bundled_path,
            )

        self.assertEqual(classifier.projects_for_accessions(["GCA_000000001.1"]), [])
        self.assertEqual(classifier.projects_for_accessions(["GCA_000000002.1"]), ["VGP"])

    def test_refresh_rejects_all_failed_empty_artifact(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            output = Path(tmpdir) / "projects.json"
            classifier = ProjectMembershipClassifier(artifact_path=output, artifact={})
            original_build = __import__("project_classifier").build_project_artifact
            try:
                __import__("project_classifier").build_project_artifact = lambda: {
                    "schema_version": 1,
                    "metadata": {
                        "unique_accession_count": 0,
                        "errors": [{"project": "DToL", "error": "network"}],
                    },
                    "projects": {"DToL": {"accessions": []}},
                }
                with self.assertRaises(ProjectMetadataRefreshError):
                    classifier.refresh(output)
            finally:
                __import__("project_classifier").build_project_artifact = original_build

        self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
