import sys
import unittest
import json
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from species_name_policy import (  # noqa: E402
    build_species_name_policy,
    normalize_common_name,
    preferred_species_display_name,
)
from download_manager import DownloadManager  # noqa: E402


class SpeciesNamePolicyTests(unittest.TestCase):
    def test_common_name_normalization_collapses_and_variants(self):
        self.assertEqual(
            normalize_common_name("Wasps, ants & bees"),
            normalize_common_name("Wasps, ants, and bees"),
        )

    def test_duplicate_common_name_prefers_scientific_name(self):
        records = [
            {
                "provider": "ensembl",
                "key": "Andrena_fulva",
                "scientific_name": "Andrena fulva",
                "common_name": "Bees",
                "group": "Insects",
            },
            {
                "provider": "ensembl",
                "key": "Bombus_terrestris",
                "scientific_name": "Bombus terrestris",
                "common_name": "Bees",
                "group": "Insects",
            },
        ]
        policy = build_species_name_policy(records)
        resolved = preferred_species_display_name(records[0], policy)

        self.assertIn("bees", policy["ambiguous_common_names"])
        self.assertEqual(resolved["display_name"], "Andrena fulva")
        self.assertEqual(resolved["display_name_reason"], "ambiguous_common")

    def test_prokaryote_prefers_scientific_name(self):
        record = {
            "provider": "ensembl",
            "key": "Escherichia_coli",
            "scientific_name": "Escherichia coli",
            "common_name": "E. coli",
            "group": "Microbes",
            "sub_group": "Bacteria",
        }
        policy = build_species_name_policy([record])
        resolved = preferred_species_display_name(record, policy)

        self.assertEqual(resolved["display_name"], "Escherichia coli")
        self.assertEqual(resolved["display_name_reason"], "prokaryote")

    def test_unique_common_name_prefers_common_name(self):
        record = {
            "provider": "ensembl",
            "key": "Homo_sapiens",
            "scientific_name": "Homo sapiens",
            "common_name": "Human",
            "group": "Mammals",
        }
        policy = build_species_name_policy([record])
        resolved = preferred_species_display_name(record, policy)

        self.assertEqual(resolved["display_name"], "Human")
        self.assertEqual(resolved["display_name_reason"], "unique_common")

    def test_download_manager_species_summary_includes_display_name(self):
        payload = {
            "last_updated": "2026-05-15T00:00:00Z",
            "species": {
                "Andrena_fulva": {
                    "taxid": 1,
                    "species_taxonomy_id": 1,
                    "scientific_name": "Andrena fulva",
                    "common_name": "Bees",
                    "assemblies": {"GCA_1": {"name": "iyAndFulv1.1", "level": "chromosome"}},
                },
                "Bombus_terrestris": {
                    "taxid": 2,
                    "species_taxonomy_id": 2,
                    "scientific_name": "Bombus terrestris",
                    "common_name": "Bees",
                    "assemblies": {"GCA_2": {"name": "iyBomTerr1.1", "level": "chromosome"}},
                },
                "Homo_sapiens": {
                    "taxid": 9606,
                    "species_taxonomy_id": 9606,
                    "scientific_name": "Homo sapiens",
                    "common_name": "Human",
                    "assemblies": {"GCA_3": {"name": "GRCh38.p14", "level": "chromosome"}},
                },
            },
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            catalog = root / "species.json"
            catalog.write_text(json.dumps(payload), encoding="utf-8")
            manager = DownloadManager(catalog, cache_dir=root / "cache")
            summaries = {item.key: item for item in manager.list_species()}

        self.assertEqual(summaries["Andrena_fulva"].display_name, "Andrena fulva")
        self.assertEqual(summaries["Andrena_fulva"].display_name_reason, "ambiguous_common")
        self.assertEqual(summaries["Homo_sapiens"].display_name, "Human")
        self.assertEqual(summaries["Homo_sapiens"].display_name_reason, "unique_common")


if __name__ == "__main__":
    unittest.main()
