import sys
import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main  # noqa: E402
from download_manager import AssemblySummary  # noqa: E402


class GenomeDisplayLabelTests(unittest.TestCase):
    def test_enrich_config_prefers_catalog_assembly_name_over_accession(self):
        config = {
            **main.DEFAULT_CONFIG,
            "active_species": [
                {
                    "provider": "ensembl",
                    "species_key": "Homo_sapiens",
                    "assembly": "GCA_000001405.29",
                    "gca": "GCA_000001405.29",
                    "scientific_name": "Homo Sapiens",
                    "common_name": "Human",
                    "assembly_name": "GCA_000001405.29",
                }
            ],
        }
        species_data = {
            "Homo_sapiens": {
                "scientific_name": "Homo sapiens",
                "common_name": "Human",
                "assemblies": {
                    "GCA_000001405.29": {"name": "GRCh38.p14"},
                },
            }
        }

        with patch.object(main.download_manager, "species_data", species_data):
            enriched = main._enrich_config_genome_labels(config)

        self.assertEqual(enriched["active_species"][0]["scientific_name"], "Homo sapiens")
        self.assertEqual(enriched["active_species"][0]["assembly_name"], "GRCh38.p14")
        self.assertEqual(enriched["active_species"][0]["display_name"], "Human")
        self.assertEqual(enriched["active_species"][0]["display_name_reason"], "unique_common")

    def test_track_genome_label_resolves_legacy_key_from_catalog(self):
        species_data = {
            "Vulpes_vulpes": {
                "scientific_name": "Vulpes vulpes",
                "common_name": "Red fox",
                "assemblies": {
                    "GCA_964106925.2": {"name": "mVulVul1.hap2.2"},
                },
            }
        }
        track = {
            "id": "trk_fox",
            "type": "splice_junctions",
            "genome_key": "Vulpes_vulpes::GCA_964106925.2",
        }

        with patch.object(main.download_manager, "species_data", species_data):
            hydrated = main._hydrate_track_genome_label(track, main.DEFAULT_CONFIG)

        self.assertEqual(hydrated["genome_species_label"], "Red fox")
        self.assertEqual(hydrated["display_name"], "Red fox")
        self.assertEqual(hydrated["display_name_reason"], "unique_common")
        self.assertEqual(hydrated["genome_assembly_name"], "mVulVul1.hap2.2")
        self.assertEqual(hydrated["genome_assembly_accession"], "GCA_964106925.2")
        self.assertEqual(hydrated["genome_label"], "Red fox - mVulVul1.hap2.2 - GCA_964106925.2")

    def test_local_assemblies_include_policy_display_name(self):
        accession = "GCA_923061745.1"
        summary = main.SpeciesSummary(
            key="Acleris_sparsana",
            scientific_name="Acleris sparsana",
            common_name="Moths",
            display_name="Acleris sparsana",
            display_name_reason="ambiguous_common",
            taxid=758717,
            species_taxonomy_id=758717,
            group="Insects",
            sub_group="Moths",
            assemblies=[
                AssemblySummary(
                    accession=accession,
                    gca=accession,
                    name="ilAclSpar1.1",
                    level="chromosome",
                )
            ],
            provider="ensembl",
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            asm_dir = root / "local_data" / "Acleris_sparsana" / accession
            asm_dir.mkdir(parents=True)
            (asm_dir / f"{accession}.gff3").write_text("##gff-version 3\n", encoding="utf-8")
            (asm_dir / f"{accession}.genome_manifest.json").write_text(
                json.dumps({
                    "provider": "ensembl",
                    "species_key": "Acleris_sparsana",
                    "assembly": accession,
                    "assembly_name": accession,
                    "scientific_name": "Acleris sparsana",
                    "common_name": "Moths",
                }),
                encoding="utf-8",
            )

            with patch.object(main.download_manager, "_species_cache", [summary]):
                results = main.list_local_assemblies(str(root))

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["common_name"], "Moths")
        self.assertEqual(results[0]["display_name"], "Acleris sparsana")
        self.assertEqual(results[0]["display_name_reason"], "ambiguous_common")
        self.assertEqual(results[0]["assembly_name"], "ilAclSpar1.1_alternate_haplotype")

    def test_local_assemblies_replace_accession_assembly_name_from_catalog(self):
        accession = "GCA_000001405.29"
        summary = main.SpeciesSummary(
            key="Homo_sapiens",
            scientific_name="Homo sapiens",
            common_name="Human",
            display_name="Human",
            display_name_reason="unique_common",
            taxid=9606,
            species_taxonomy_id=9606,
            group="Mammals",
            sub_group="Primates",
            assemblies=[
                AssemblySummary(
                    accession=accession,
                    gca=accession,
                    name="GRCh38.p14",
                    level="chromosome",
                )
            ],
            provider="ensembl",
        )
        species_data = {
            "Homo_sapiens": {
                "scientific_name": "Homo sapiens",
                "common_name": "Human",
                "assemblies": {
                    accession: {"name": "GRCh38.p14"},
                },
            }
        }

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            asm_dir = root / "local_data" / "Homo_sapiens" / accession
            asm_dir.mkdir(parents=True)
            (asm_dir / f"{accession}.gff3").write_text("##gff-version 3\n", encoding="utf-8")
            (asm_dir / f"{accession}.genome_manifest.json").write_text(
                json.dumps({
                    "provider": "ensembl",
                    "species_key": "Homo_sapiens",
                    "assembly": accession,
                    "assembly_name": accession,
                    "scientific_name": "Homo sapiens",
                    "common_name": "Human",
                }),
                encoding="utf-8",
            )

            with (
                patch.object(main.download_manager, "_species_cache", [summary]),
                patch.object(main.download_manager, "species_data", species_data),
            ):
                results = main.list_local_assemblies(str(root))

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["assembly"], accession)
        self.assertEqual(results[0]["assembly_name"], "GRCh38.p14")
        self.assertEqual(results[0]["display_name"], "Human")


if __name__ == "__main__":
    unittest.main()
