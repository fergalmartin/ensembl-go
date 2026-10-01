"""Startup settings must not construct the full downloadable species catalogue."""

import json
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main
from download_manager import DownloadManager
from species_name_policy import build_species_name_policy


class ConfigStartupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.species = {
            "Test_moth": {
                "scientific_name": "Test moth",
                "common_name": "Moths",
                "assemblies": {"GCA_123456789.1": {"name": "testAssembly"}},
            },
            "Other_moth": {
                "scientific_name": "Other moth",
                "common_name": "Moths",
                "assemblies": {},
            },
        }
        catalog = self.root / "species.json"
        catalog.write_text(json.dumps({"species": self.species}), encoding="utf-8")
        self.manager = DownloadManager(catalog, cache_dir=self.root / "cache")
        self.manager.species_name_policy = build_species_name_policy([
            {**info, "key": key, "provider": "ensembl"}
            for key, info in self.species.items()
        ])

    def test_cold_config_and_sidecars_load_labels_without_building_catalogue(self):
        genome = {
            "provider": "ensembl", "species_key": "Test_moth",
            "assembly": "GCA_123456789.1",
        }
        config = {
            **main.DEFAULT_CONFIG,
            "output_dir": str(self.root / "output"),
            "active_species": [genome],
            "genome_playlists": [{"id": "saved", "name": "Saved", "genomes": [genome]}],
        }
        with patch.object(main, "download_manager", self.manager), \
                patch.object(main, "CONFIG_FILE", self.root / "config.json"), \
                patch.object(self.manager, "_build_cache", wraps=self.manager._build_cache) as build:
            main.save_config(config)
            self.addCleanup(main.invalidate_config_cache)
            loaded = main.get_config()
            sidecar = main.get_output_dir_config(config["output_dir"])
            playlists = main.get_config_playlists(config["output_dir"])

            build.assert_not_called()
            self.assertIsNone(self.manager._species_cache)
            self.assertEqual(loaded["output_dir"], config["output_dir"])
            self.assertEqual(loaded["active_species"][0]["display_name"], "Test moth")
            self.assertEqual(loaded["active_species"][0]["display_name_reason"], "ambiguous_common")
            self.assertEqual(loaded["active_species"][0]["assembly_name"], "testAssembly")
            self.assertTrue(sidecar["found"])
            self.assertEqual(sidecar["config"]["genome_playlists"][0]["genomes"][0]["display_name"], "Test moth")
            self.assertEqual(playlists["genome_playlists"][0]["id"], "saved")

    def test_concurrent_catalogue_requests_share_one_build(self):
        callers = threading.Barrier(8)
        started = threading.Event()
        release = threading.Event()
        original = self.manager._build_app_species_summaries

        def slow_build():
            started.set()
            if not release.wait(5):
                raise AssertionError("Catalogue build was not released")
            return original()

        def request():
            callers.wait(timeout=5)
            self.manager._build_cache()
            return self.manager._species_cache

        with patch.object(self.manager, "_build_app_species_summaries", side_effect=slow_build) as build, \
                patch.object(self.manager, "_policy_matches_current_catalog", return_value=True):
            with ThreadPoolExecutor(max_workers=8) as pool:
                futures = [pool.submit(request) for _ in range(8)]
                try:
                    self.assertTrue(started.wait(5))
                finally:
                    release.set()
                results = [future.result(timeout=5) for future in futures]
            self.assertEqual(build.call_count, 1)
            self.assertEqual(len(results[0]), 2)
            self.assertTrue(all(result is results[0] for result in results))

    def test_taxonomy_diagnostics_remain_sorted_unique_and_json_serializable(self):
        classifications = [
            SimpleNamespace(source="heuristic", group="Other", sub_group=None, missing_taxids=(3, "1", 0)),
            SimpleNamespace(source="lineage", group="Insects", sub_group=None, missing_taxids=(3, 2, "invalid")),
        ]
        with patch.object(self.manager, "_classify_species_for_download", side_effect=classifications):
            self.manager._build_app_species_summaries()
        diagnostics = self.manager._taxonomy_classification_status()
        self.assertEqual(diagnostics["missing_taxids"], [1, 2, 3])
        self.assertEqual(diagnostics["missing_taxid_count"], 3)
        self.assertEqual(diagnostics["total_species"], 2)
        self.assertEqual(diagnostics["heuristic_classified_count"], 1)
        self.assertEqual(diagnostics["lineage_classified_count"], 1)
        json.dumps(diagnostics)


if __name__ == "__main__":
    unittest.main()
