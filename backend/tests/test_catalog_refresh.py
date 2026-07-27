import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from download_manager import DownloadManager, _write_json_atomic  # noqa: E402
from project_classifier import ProjectMembershipClassifier  # noqa: E402
from taxonomy_classifier import TaxonomyLineageClassifier  # noqa: E402


def _catalog_payload(species_map, last_updated="2026-03-23T10:00:00Z"):
    return {
        "last_updated": last_updated,
        "species": species_map,
    }


def _species_entry(name, assemblies, taxid=1, common_name=""):
    return {
        "taxid": taxid,
        "species_taxonomy_id": taxid,
        "scientific_name": name,
        "common_name": common_name,
        "assemblies": assemblies,
    }


def _assembly_entry(name="Assembly 1"):
    return {
        "name": name,
        "level": "chromosome",
        "genebuild_providers": {},
        "assembly": {"files": {"genome_sequences": {}}},
    }


def _taxonomy_artifact(lineages):
    return {
        "schema_version": 1,
        "taxids": {
            str(taxid): {
                "resolved_taxid": taxid,
                "lineage": lineage,
                "rank": "species",
                "scientific_name": f"Species {taxid}",
            }
            for taxid, lineage in lineages.items()
        },
        "merged_taxids": {},
    }


class CatalogRefreshTests(unittest.TestCase):
    def test_refresh_catalog_tracks_added_and_retired_genomes(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            species_json = root / "species.json"
            cache_dir = root / "cache"

            initial = _catalog_payload({
                "Species_a": _species_entry("Species a", {
                    "GCA_000001.1": _assembly_entry("Asm A1"),
                }),
                "Species_b": _species_entry("Species b", {
                    "GCA_000002.1": _assembly_entry("Asm B1"),
                }),
            })
            species_json.write_text(json.dumps(initial), encoding="utf-8")

            manager = DownloadManager(species_json, cache_dir=cache_dir)
            manager.catalog_source_urls = []
            status = manager.get_catalog_status()
            self.assertEqual(status["current_catalog_genome_count"], 2)
            self.assertEqual(status["latest_change"]["added_count"], 0)
            self.assertEqual(status["latest_change"]["retired_count"], 0)

            updated = _catalog_payload({
                "Species_a": _species_entry("Species a", {
                    "GCA_000001.1": _assembly_entry("Asm A1"),
                    "GCA_000003.1": _assembly_entry("Asm A2"),
                }),
            }, last_updated="2026-03-24T09:15:00Z")
            species_json.write_text(json.dumps(updated), encoding="utf-8")

            with patch.object(manager, "refresh_species_name_policy", return_value={"metadata": {}}) as refresh_policy:
                refreshed = manager.refresh_catalog(force=True)
            latest_change = refreshed["latest_change"]

            self.assertEqual(refreshed["current_catalog_last_updated"], "2026-03-24T09:15:00Z")
            self.assertEqual(refreshed["current_catalog_genome_count"], 2)
            self.assertEqual(latest_change["added_count"], 1)
            self.assertEqual(latest_change["retired_count"], 1)
            self.assertFalse(latest_change["seen"])
            self.assertEqual(latest_change["added_preview"][0]["assembly"], "GCA_000003.1")
            self.assertEqual(latest_change["retired_preview"][0]["assembly"], "GCA_000002.1")
            refresh_policy.assert_called_once()

            acknowledged = manager.acknowledge_catalog_change(latest_change["token"])
            self.assertTrue(acknowledged["latest_change"]["seen"])

    def test_lineage_classification_changes_group_counts_and_filters(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            species_json = root / "species.json"
            payload = _catalog_payload({
                "Ground_beetle": _species_entry("Abax parallelepipedus", {
                    "GCA_000001.1": _assembly_entry("Beetle Asm"),
                }, taxid=1001),
                "Mystery_species": _species_entry("Mystery species", {
                    "GCA_000002.1": _assembly_entry("Mystery Asm"),
                }, taxid=9999),
            })
            species_json.write_text(json.dumps(payload), encoding="utf-8")

            manager = DownloadManager(species_json, cache_dir=root / "cache")
            manager.taxonomy_classifier = TaxonomyLineageClassifier(artifact=_taxonomy_artifact({
                1001: [1, 131567, 2759, 33208, 6656, 50557, 7041, 1001],
            }))

            groups = manager.list_groups()
            insects = next(group for group in groups if group.name == "Insects")
            other = next(group for group in groups if group.name == "Other")
            species = manager.list_species(group="Insects", sub_group="Beetles")
            diagnostics = manager.get_catalog_status()["taxonomy_classification"]

        self.assertEqual(insects.count, 1)
        self.assertEqual(other.count, 1)
        self.assertEqual([item.key for item in species], ["Ground_beetle"])
        self.assertEqual(diagnostics["lineage_classified_count"], 1)
        self.assertEqual(diagnostics["heuristic_classified_count"], 1)
        self.assertEqual(diagnostics["other_count"], 1)
        self.assertIn(9999, diagnostics["missing_taxids"])

    def test_other_mammals_is_last_subgroup(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            species_json = root / "species.json"
            payload = _catalog_payload({
                "Dog": _species_entry("Canis lupus familiaris", {
                    "GCA_000001.1": _assembly_entry("Dog Asm"),
                }, taxid=1001),
                "Cow": _species_entry("Bos taurus", {
                    "GCA_000002.1": _assembly_entry("Cow Asm"),
                }, taxid=1002),
                "Mystery_mammal_a": _species_entry("Mystery mammal a", {
                    "GCA_000003.1": _assembly_entry("Mystery Asm A"),
                }, taxid=1003),
                "Mystery_mammal_b": _species_entry("Mystery mammal b", {
                    "GCA_000004.1": _assembly_entry("Mystery Asm B"),
                }, taxid=1004),
            })
            species_json.write_text(json.dumps(payload), encoding="utf-8")

            manager = DownloadManager(species_json, cache_dir=root / "cache")
            manager.taxonomy_classifier = TaxonomyLineageClassifier(artifact=_taxonomy_artifact({
                1001: [1, 131567, 2759, 33208, 40674, 33554, 1001],
                1002: [1, 131567, 2759, 33208, 40674, 91561, 1002],
                1003: [1, 131567, 2759, 33208, 40674, 1003],
                1004: [1, 131567, 2759, 33208, 40674, 1004],
            }))

            mammals = next(group for group in manager.list_groups() if group.name == "Mammals")

        self.assertEqual([item["name"] for item in mammals.sub_groups], [
            "Carnivores",
            "Even-toed ungulates & whales",
            "Other Mammals",
        ])

    def test_project_group_counts_and_filters_assemblies(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            species_json = root / "species.json"
            payload = _catalog_payload({
                "Species_a": _species_entry("Species a", {
                    "GCA_000000001.1": _assembly_entry("Asm A1"),
                    "GCA_000000002.1": _assembly_entry("Asm A2"),
                }, taxid=1001),
                "Species_b": _species_entry("Species b", {
                    "GCA_000000003.1": _assembly_entry("Asm B1"),
                }, taxid=1002),
            })
            species_json.write_text(json.dumps(payload), encoding="utf-8")

            manager = DownloadManager(species_json, cache_dir=root / "cache")
            manager.project_classifier = ProjectMembershipClassifier(artifact={
                "schema_version": 1,
                "project_order": ["DToL", "VGP"],
                "projects": {
                    "DToL": {"accessions": ["GCA_000000001.1", "GCA_000000003.1"]},
                    "VGP": {"accessions": ["GCA_000000001.1", "GCA_000000002.1"]},
                },
            })

            groups = manager.list_groups()
            projects = next(group for group in groups if group.name == "Projects")
            dtol_species = manager.list_species(group="Projects", sub_group="DToL")
            all_project_species = manager.list_species(group="Projects")

        self.assertEqual(projects.count, 3)
        self.assertEqual(projects.sub_groups, [
            {"name": "DToL", "count": 2},
            {"name": "VGP", "count": 2},
        ])
        self.assertEqual(
            [(item.key, [assembly.accession for assembly in item.assemblies]) for item in dtol_species],
            [("Species_a", ["GCA_000000001.1"]), ("Species_b", ["GCA_000000003.1"])],
        )
        self.assertEqual(
            [(item.key, [assembly.accession for assembly in item.assemblies]) for item in all_project_species],
            [
                ("Species_a", ["GCA_000000001.1", "GCA_000000002.1"]),
                ("Species_b", ["GCA_000000003.1"]),
            ],
        )

    def test_refresh_catalog_records_taxonomy_diagnostics(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            species_json = root / "species.json"
            cache_dir = root / "cache"
            species_json.write_text(json.dumps(_catalog_payload({})), encoding="utf-8")

            manager = DownloadManager(species_json, cache_dir=cache_dir)
            manager.catalog_source_urls = []
            manager.taxonomy_classifier = TaxonomyLineageClassifier(artifact=_taxonomy_artifact({
                1001: [1, 131567, 2759, 33208, 6656, 50557, 7041, 1001],
            }))

            updated = _catalog_payload({
                "Ground_beetle": _species_entry("Abax parallelepipedus", {
                    "GCA_000001.1": _assembly_entry("Beetle Asm"),
                }, taxid=1001),
            }, last_updated="2026-03-25T09:15:00Z")
            species_json.write_text(json.dumps(updated), encoding="utf-8")

            with patch.object(manager, "refresh_species_name_policy", return_value={"metadata": {}}):
                refreshed = manager.refresh_catalog(force=True)
            diagnostics = refreshed["taxonomy_classification"]

        self.assertEqual(diagnostics["total_species"], 1)
        self.assertEqual(diagnostics["lineage_classified_count"], 1)
        self.assertEqual(diagnostics["group_counts"], {"Insects": 1})


class CatalogCompletenessTests(unittest.TestCase):
    """A catalogue file existing on disk is not proof its download finished."""

    def _build(self, tmpdir, cached=None, raw_cached=None, state=None, bundled=None):
        root = Path(tmpdir)
        cache_dir = root / "cache"
        cache_dir.mkdir(parents=True, exist_ok=True)
        species_json = root / "species.json"

        if bundled is not None:
            species_json.write_text(json.dumps(bundled), encoding="utf-8")
        if raw_cached is not None:
            (cache_dir / "remote_species_catalog.json").write_text(raw_cached, encoding="utf-8")
        elif cached is not None:
            (cache_dir / "remote_species_catalog.json").write_text(json.dumps(cached), encoding="utf-8")
        if state is not None:
            (cache_dir / "remote_species_catalog_state.json").write_text(json.dumps(state), encoding="utf-8")

        manager = DownloadManager(species_json, cache_dir=cache_dir)
        manager.catalog_source_urls = []
        return manager, cache_dir / "remote_species_catalog.json"

    def _payload(self, count=2):
        return _catalog_payload({
            f"Species_{index}": _species_entry(f"Species {index}", {
                f"GCA_00000{index}.1": _assembly_entry(f"Asm {index}"),
            })
            for index in range(count)
        })

    def test_cached_catalogue_without_species_is_rejected_and_removed(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            manager, cache_path = self._build(tmpdir, cached=_catalog_payload({}))
            self.assertFalse(manager.has_usable_catalog())
            self.assertFalse(cache_path.exists(), "an empty cache should be discarded, not reused")

    def test_truncated_cached_catalogue_is_rejected_and_removed(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            manager, cache_path = self._build(tmpdir, raw_cached='{"species": {"Species_0"')
            self.assertFalse(manager.has_usable_catalog())
            self.assertFalse(cache_path.exists())

    def test_cached_catalogue_with_unexpected_species_count_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            manager, cache_path = self._build(
                tmpdir,
                cached=self._payload(count=2),
                state={"current_catalog_species_count": 5000},
            )
            self.assertFalse(manager.has_usable_catalog())
            self.assertFalse(cache_path.exists())

    def test_complete_cached_catalogue_is_used(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            manager, cache_path = self._build(
                tmpdir,
                cached=self._payload(count=2),
                state={"current_catalog_species_count": 2},
            )
            self.assertTrue(manager.has_usable_catalog())
            self.assertEqual(len(manager.species_data), 2)
            self.assertTrue(cache_path.exists(), "a complete cache must be kept")

    def test_empty_bundled_placeholder_does_not_count_as_a_catalogue(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            manager, cache_path = self._build(tmpdir, bundled={"last_updated": "", "species": {}})
            self.assertFalse(manager.has_usable_catalog())
            self.assertFalse(cache_path.exists(), "an unusable catalogue must not be cached")

    def test_status_distinguishes_a_running_first_fetch_from_an_empty_catalogue(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            manager, _ = self._build(tmpdir)

            idle = manager.get_catalog_status()
            self.assertFalse(idle["catalog_available"])
            self.assertEqual(idle["species_count"], 0)
            self.assertFalse(idle["initial_fetch_in_progress"])

            manager._catalog_refresh_pending = True
            fetching = manager.get_catalog_status()
            self.assertTrue(fetching["initial_fetch_in_progress"])
            self.assertTrue(fetching["refresh_in_progress"])

    def test_ensure_catalog_available_only_fetches_when_nothing_is_loaded(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            manager, _ = self._build(tmpdir)
            manager.catalog_source_urls = ["https://example.invalid/species.json"]
            with patch.object(manager, "schedule_catalog_refresh_if_stale", return_value=True) as scheduled:
                self.assertTrue(manager.ensure_catalog_available())
            scheduled.assert_called_once_with(force=True)

        with tempfile.TemporaryDirectory() as tmpdir:
            manager, _ = self._build(
                tmpdir,
                cached=self._payload(count=2),
                state={"current_catalog_species_count": 2},
            )
            manager.catalog_source_urls = ["https://example.invalid/species.json"]
            with patch.object(manager, "schedule_catalog_refresh_if_stale") as scheduled:
                self.assertFalse(manager.ensure_catalog_available())
            scheduled.assert_not_called()

    def test_atomic_write_replaces_cleanly_and_leaves_no_temporary_file(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            target = Path(tmpdir) / "nested" / "catalogue.json"
            payload = self._payload(count=3)

            _write_json_atomic(target, payload)
            self.assertEqual(json.loads(target.read_text(encoding="utf-8")), payload)

            replacement = self._payload(count=1)
            _write_json_atomic(target, replacement)
            self.assertEqual(json.loads(target.read_text(encoding="utf-8")), replacement)

            leftovers = [path.name for path in target.parent.iterdir() if path.name != target.name]
            self.assertEqual(leftovers, [], "temporary files must not be left behind")


if __name__ == "__main__":
    unittest.main()
