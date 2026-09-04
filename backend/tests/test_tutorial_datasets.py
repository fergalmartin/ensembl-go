import sys
import tempfile
import unittest
import json
import gzip
import asyncio
from pathlib import Path

import pysam

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import demo_genome  # noqa: E402
import main  # noqa: E402
import tutorial_datasets  # noqa: E402
import tutorial_packages  # noqa: E402


class TutorialDatasetTests(unittest.TestCase):
    def sources(self, root: Path):
        fasta = root / "source.fa"
        fasta.write_text(">1\n" + ("ACGT" * 100) + "\n", encoding="utf-8")
        pysam.faidx(str(fasta))
        gff = root / "source.gff3"
        gff.write_text(
            "##gff-version 3\n"
            "1\ttest\tgene\t10\t80\t.\t+\t.\tID=gene:g1;Name=One\n"
            "1\ttest\tmRNA\t10\t80\t.\t+\t.\tID=transcript:t1;Parent=gene:g1\n"
            "1\ttest\texon\t10\t30\t.\t+\t.\tID=exon:e1;Parent=transcript:t1\n"
            "1\ttest\tcustom_part\t12\t18\t.\t+\t.\tID=part:p1;Parent=exon:e1\n"
            "1\ttest\texon\t50\t80\t.\t+\t.\tID=exon:e2;Parent=transcript:t1\n",
            encoding="utf-8",
        )
        return fasta, gff

    def test_generation_expands_partial_genes_and_installs_in_sandbox(self):
        with tempfile.TemporaryDirectory() as output:
            root = Path(output)
            fasta, gff = self.sources(root)
            result = tutorial_datasets.generate_recipe(
                output, "slice-tutorial", fasta, gff, "1", 20, 60, "expand",
                {"display_name": "Test genome", "scientific_name": "Testus example"},
            )
            recipe = result["recipe"]
            self.assertEqual(recipe["browsableRange"]["1"], [10, 80])
            self.assertEqual(recipe["genes"], ["gene:g1"])
            annotation = Path(result["directory"]) / recipe["files"]["gff3"]
            import gzip
            with gzip.open(annotation, "rt", encoding="utf-8") as handle:
                self.assertIn("ID=part:p1;Parent=exon:e1", handle.read())
            workspace = demo_genome.tutorial_workspace(output)
            workspace.mkdir()
            installed = tutorial_datasets.install_recipe(output, "slice-tutorial", recipe["id"], workspace)
            self.assertTrue(Path(installed["genome"]["files"]["fasta"]).is_file())
            demo_genome.set_tutorial_session_genome(installed["genome"])
            self.assertEqual(demo_genome.tutorial_session_species()[0]["tutorial_dataset_id"], recipe["id"])
            demo_genome.clear_tutorial_session_genome()

    def test_recipe_identity_depends_on_content_not_local_source_path(self):
        with tempfile.TemporaryDirectory() as first, tempfile.TemporaryDirectory() as second:
            fasta_a, gff_a = self.sources(Path(first))
            fasta_b, gff_b = self.sources(Path(second))
            result_a = tutorial_datasets.generate_recipe(first, "one", fasta_a, gff_a, "1", 10, 80)
            result_b = tutorial_datasets.generate_recipe(second, "two", fasta_b, gff_b, "1", 10, 80)
            self.assertEqual(result_a["recipe"]["id"], result_b["recipe"]["id"])

    def test_cancel_reports_partial_gene(self):
        with tempfile.TemporaryDirectory() as output:
            root = Path(output)
            fasta, gff = self.sources(root)
            with self.assertRaisesRegex(ValueError, "cuts through genes"):
                tutorial_datasets.generate_recipe(output, "slice-tutorial", fasta, gff, "1", 20, 60, "cancel")

    def test_dataset_and_tutorial_ids_cannot_escape_the_draft_directory(self):
        with tempfile.TemporaryDirectory() as output:
            root = Path(output)
            fasta, gff = self.sources(root)
            with self.assertRaisesRegex(ValueError, "Tutorial ids"):
                tutorial_datasets.generate_recipe(output, "../outside", fasta, gff, "1", 10, 80)
            with self.assertRaisesRegex(ValueError, "dataset ids"):
                tutorial_datasets.install_recipe(output, "slice-tutorial", "../outside", root / "workspace")

    def test_turtles_and_friends_fixture_builds_and_registers_eight_synthetic_genomes(self):
        with tempfile.TemporaryDirectory() as output:
            result = tutorial_datasets.generate_fixture_pack(
                output,
                "playlist-tutorial",
                tutorial_datasets.TURTLES_AND_FRIENDS_FIXTURE_ID,
            )
            self.assertEqual(result["genomeCount"], 8)
            self.assertEqual(len(result["datasets"]), 8)
            workspace = demo_genome.tutorial_workspace(output)
            workspace.mkdir()
            installed = []
            recipes = []
            for dataset in result["datasets"]:
                recipe_dir = Path(output) / "tutorials" / "drafts" / "playlist-tutorial" / "datasets" / dataset["recipeId"]
                recipe = json.loads((recipe_dir / "recipe.json").read_text(encoding="utf-8"))
                recipes.append(recipe)
                self.assertTrue(recipe["synthetic"])
                self.assertFalse(recipe["source"]["containsRealSequence"])
                with pysam.FastaFile(str(recipe_dir / recipe["files"]["fasta"])) as fasta:
                    self.assertEqual(fasta.get_reference_length("1"), 36_000)
                with gzip.open(recipe_dir / recipe["files"]["gff3"], "rt", encoding="utf-8") as annotation:
                    self.assertEqual(sum("\ttutorial\tgene\t" in line for line in annotation), 4)
                record = tutorial_datasets.install_recipe(
                    output,
                    "playlist-tutorial",
                    dataset["recipeId"],
                    workspace,
                )["genome"]
                installed.append(record)
                demo_genome.set_tutorial_session_genome(record)

            self.assertEqual([recipe["assemblyName"] for recipe in recipes], [
                "Leonardo_v1", "Michelangelo_v1", "Donatello_v1", "Raphael_v1",
                "Splinter_v1", "April_v1", "Rocksteady_v1", "Bebop_v1",
            ])
            self.assertEqual([recipe["commonName"] for recipe in recipes[4:]], [
                "Brown rat", "Human", "Black rhinoceros", "Common warthog",
            ])
            self.assertEqual(len(demo_genome.tutorial_session_species()), 8)
            self.assertTrue(all(record["provider"] == "demo" for record in installed))
            listed = asyncio.run(main.list_local_assemblies(output_dir=str(workspace)))
            self.assertEqual(len(listed), 8)
            self.assertTrue(all(record["provider"] == "demo" for record in listed))
            self.assertTrue(all(record["source_database"] == "demo" for record in listed))
            self.assertTrue(all(record["is_demo"] for record in listed))
            self.assertTrue(all(not record["retired_remote"] for record in listed))
            # A running tutorial holds the catalogue's records, not the ones the install
            # returned, and re-registers one on every step so a backend restart does not
            # leave the browser unable to resolve it. The catalogue therefore has to say
            # which generated dataset a genome is, or every one of those answers 400.
            self.assertEqual(
                sorted(record["tutorial_dataset_id"] for record in listed),
                sorted(recipe["id"] for recipe in recipes),
            )
            for record in listed:
                demo_genome.set_tutorial_session_genome(record)
            demo_genome.clear_tutorial_session_genome()

            document = {
                "format": tutorial_packages.FORMAT,
                "schemaVersion": tutorial_packages.SCHEMA_VERSION,
                "id": "playlist-tutorial",
                "title": "Genome playlists",
                "blurb": "Eight synthetic genomes",
                "datasets": result["datasets"],
                "steps": [{"id": "intro", "title": "Meet the team", "body": "Eight genomes are active."}],
            }
            tutorial_packages.save_draft(output, document)
            package = Path(output) / "playlist.egtutorial"
            tutorial_packages.export_package(output, "playlist-tutorial", package)
            scan = tutorial_packages.scan_package(package)
            self.assertTrue(scan["compatible"])
            self.assertLess(package.stat().st_size, 1_000_000)


if __name__ == "__main__":
    unittest.main()
