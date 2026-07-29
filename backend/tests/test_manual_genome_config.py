import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from annotation import prepare_annotation  # noqa: E402
from manual_genome_config import (  # noqa: E402
    FORMAT,
    LEGACY_FORMAT,
    VERSION,
    parse_manual_genome_config,
    save_manual_genome_config,
)
import main  # noqa: E402
from fastapi import HTTPException  # noqa: E402


FIXTURES = Path(__file__).resolve().parent / "fixtures" / "annotation"


class ManualGenomeConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.fasta = self.root / "genome.fa"
        self.annotation = self.root / "genes.gff3"
        self.homologies = self.root / "homologies.tsv"
        self.fasta.write_text(">chr1\nACGT\n", encoding="utf-8")
        self.annotation.write_text(
            "##gff-version 3\n"
            "chr1\ttest\tgene\t1\t4\t.\t+\t.\tID=gene:g1\n",
            encoding="utf-8",
        )
        self.homologies.write_text("gene1\tgene2\n", encoding="utf-8")

    def _write(self, payload):
        path = self.root / "manual-genomes.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def test_relative_paths_are_resolved_from_config_directory(self):
        path = self._write({
            "format": FORMAT,
            "version": VERSION,
            "genomes": [{
                "species": "Test species",
                "assembly": "test1",
                "playlists": [" Research ", "research", "Comparative set"],
                "files": {
                    "fasta": self.fasta.name,
                    "annotation": self.annotation.name,
                    "homologies": self.homologies.name,
                },
            }],
        })
        result = parse_manual_genome_config(str(path))
        self.assertTrue(result["ok"])
        self.assertEqual(result["valid_count"], 1)
        files = result["entries"][0]["genome"]["files"]
        # The legacy annotation/homologies keys alias onto the canonical ones.
        self.assertEqual(files["fasta"], str(self.fasta.resolve()))
        self.assertEqual(files["gff3"], str(self.annotation.resolve()))
        self.assertEqual(files["homology"], str(self.homologies.resolve()))
        self.assertEqual(
            result["entries"][0]["genome"]["playlists"],
            ["Research", "Comparative set"],
        )

    def test_invalid_entries_do_not_block_valid_entries(self):
        path = self._write({
            "format": FORMAT,
            "version": VERSION,
            "genomes": [
                {
                    "species": "Valid species",
                    "assembly": "v1",
                    "files": {"fasta": self.fasta.name},
                },
                {
                    "species": "Broken species",
                    "assembly": "b1",
                    "files": {"fasta": "missing.fa"},
                },
            ],
        })
        result = parse_manual_genome_config(str(path))
        self.assertTrue(result["ok"])
        self.assertEqual(result["total_count"], 2)
        self.assertEqual(result["valid_count"], 1)
        self.assertTrue(result["entries"][0]["valid"])
        self.assertFalse(result["entries"][1]["valid"])
        self.assertIn("not found", result["entries"][1]["diagnostics"][0]["message"].lower())

    def test_wrong_format_is_a_document_error(self):
        path = self._write({"format": "something-else", "version": VERSION, "genomes": []})
        result = parse_manual_genome_config(str(path))
        self.assertFalse(result["ok"])
        self.assertEqual(result["entries"], [])

    def test_invalid_playlist_names_invalidate_only_the_entry(self):
        path = self._write({
            "format": FORMAT,
            "version": VERSION,
            "genomes": [{
                "species": "Test species",
                "assembly": "test1",
                "playlists": ["Valid", ""],
                "files": {"fasta": self.fasta.name},
            }],
        })
        result = parse_manual_genome_config(str(path))
        self.assertTrue(result["ok"])
        self.assertFalse(result["entries"][0]["valid"])
        self.assertEqual(result["entries"][0]["diagnostics"][0]["field"], "playlists.1")

    def test_save_and_read_round_trip_uses_relative_paths(self):
        destination = self.root / "exports" / "manual-genomes.json"
        destination.parent.mkdir()
        saved = save_manual_genome_config(str(destination), [{
            "species": "Test species",
            "assembly": "test1",
            "accession": "GCA_000000001.1",
            "playlists": ["Research", "research", "QA"],
            "files": {
                "fasta": str(self.fasta),
                "annotation": str(self.annotation),
                "homologies": str(self.homologies),
            },
        }])
        self.assertEqual(saved["count"], 1)
        document = json.loads(destination.read_text(encoding="utf-8"))
        self.assertTrue(Path(document["genomes"][0]["files"]["fasta"]).is_absolute())
        self.assertEqual(document["genomes"][0]["playlists"], ["Research", "QA"])

        # Files inside the destination directory are written portably.
        local_fasta = destination.parent / "local.fa"
        local_fasta.write_text(">chr1\nA\n", encoding="utf-8")
        save_manual_genome_config(str(destination), [{
            "species": "Local species",
            "assembly": "local1",
            "files": {"fasta": str(local_fasta)},
        }])
        document = json.loads(destination.read_text(encoding="utf-8"))
        self.assertEqual(document["genomes"][0]["files"]["fasta"], "local.fa")
        self.assertEqual(parse_manual_genome_config(str(destination))["valid_count"], 1)

    def test_version_1_documents_are_still_accepted(self):
        path = self._write({
            "format": LEGACY_FORMAT,
            "version": 1,
            "genomes": [{
                "species": "Test species",
                "assembly": "test1",
                "files": {
                    "fasta": self.fasta.name,
                    "annotation": self.annotation.name,
                },
            }],
        })
        result = parse_manual_genome_config(str(path))
        self.assertTrue(result["ok"])
        genome = result["entries"][0]["genome"]
        self.assertEqual(genome["files"]["gff3"], str(self.annotation.resolve()))
        # Absent provider means the genome was hand-added, not downloaded.
        self.assertEqual(genome["provider"], "manual")
        self.assertEqual(genome["assembly_name"], "test1")

    def test_canonical_file_key_wins_over_its_legacy_alias(self):
        other = self.root / "other.gff3"
        other.write_text("##gff-version 3\n", encoding="utf-8")
        path = self._write({
            "format": FORMAT,
            "version": VERSION,
            "genomes": [{
                "species": "Test species",
                "assembly": "test1",
                "files": {
                    "fasta": self.fasta.name,
                    "gff3": other.name,
                    "annotation": self.annotation.name,
                },
            }],
        })
        result = parse_manual_genome_config(str(path))
        self.assertEqual(
            result["entries"][0]["genome"]["files"]["gff3"],
            str(other.resolve()),
        )

    def test_missing_optional_file_warns_but_keeps_the_entry(self):
        path = self._write({
            "format": FORMAT,
            "version": VERSION,
            "genomes": [{
                "species": "Test species",
                "assembly": "test1",
                "files": {
                    "fasta": self.fasta.name,
                    "gff3": "absent.gff3",
                    "homology": self.homologies.name,
                },
            }],
        })
        result = parse_manual_genome_config(str(path))
        entry = result["entries"][0]
        self.assertTrue(entry["valid"])
        self.assertNotIn("gff3", entry["genome"]["files"])
        self.assertIn("homology", entry["genome"]["files"])
        self.assertEqual(len(entry["missing_files"]), 1)
        self.assertEqual(entry["missing_files"][0]["field"], "files.gff3")
        self.assertEqual(entry["missing_files"][0]["reason"], "not_found")
        self.assertEqual(
            [item["severity"] for item in entry["diagnostics"]],
            ["warning"],
        )

    def test_missing_fasta_is_an_error_and_is_still_reported_as_missing(self):
        path = self._write({
            "format": FORMAT,
            "version": VERSION,
            "genomes": [{
                "species": "Test species",
                "assembly": "test1",
                "files": {"fasta": "absent.fa"},
            }],
        })
        entry = parse_manual_genome_config(str(path))["entries"][0]
        self.assertFalse(entry["valid"])
        self.assertEqual(entry["diagnostics"][0]["severity"], "error")
        self.assertEqual(entry["missing_files"][0]["field"], "files.fasta")

    def test_full_identity_round_trips_through_save_and_read(self):
        destination = self.root / "bundle.json"
        save_manual_genome_config(
            str(destination),
            [{
                "species": "Homo sapiens",
                "species_key": "Homo_sapiens",
                "common_name": "Human",
                "display_name": "Human",
                "display_name_reason": "common_name",
                "assembly": "GCA_000001405.29",
                "assembly_name": "GRCh38.p14",
                "accession": "GCA_000001405.29",
                "equivalent_accessions": ["gcf_000001405.40", "GCF_000001405.40"],
                "provider": "ensembl",
                "source_database": "Ensembl",
                "dataset_release": {
                    "key": "ensembl/2024_11",
                    "source": "ensembl",
                    "date": "2024_11",
                    "label": "Ensembl 2024_11",
                    "short_label": "E113",
                },
                "playlists": ["Primate references"],
                "files": {
                    "fasta": str(self.fasta),
                    "gff3": str(self.annotation),
                    "homology": str(self.homologies),
                },
            }],
            [{"name": "Primate references", "description": "Great apes"}],
        )
        document = json.loads(destination.read_text(encoding="utf-8"))
        self.assertEqual(document["format"], FORMAT)
        self.assertEqual(document["version"], VERSION)
        self.assertEqual(
            document["playlists"],
            [{"name": "Primate references", "description": "Great apes"}],
        )
        self.assertEqual(document["genomes"][0]["equivalent_accessions"], ["GCF_000001405.40"])

        result = parse_manual_genome_config(str(destination))
        genome = result["entries"][0]["genome"]
        self.assertTrue(result["ok"])
        self.assertEqual(genome["provider"], "ensembl")
        self.assertEqual(genome["source_database"], "Ensembl")
        self.assertEqual(genome["species_key"], "Homo_sapiens")
        self.assertEqual(genome["assembly_name"], "GRCh38.p14")
        self.assertEqual(genome["display_name_reason"], "common_name")
        self.assertEqual(genome["dataset_release"]["key"], "ensembl/2024_11")
        self.assertEqual(genome["dataset_release"]["short_label"], "E113")
        self.assertEqual(genome["playlists"], ["Primate references"])
        self.assertEqual(
            result["playlists"],
            [{"name": "Primate references", "description": "Great apes"}],
        )
        # Files inside the destination directory are written portably.
        self.assertEqual(document["genomes"][0]["files"]["fasta"], "genome.fa")
        self.assertEqual(genome["files"]["fasta"], str(self.fasta.resolve()))

    def test_every_canonical_file_type_survives_a_round_trip(self):
        extras = {}
        for file_type in ("index", "metadata", "cdna", "protein", "xref", "gff3_index"):
            target = self.root / f"{file_type}.dat"
            target.write_text("x\n", encoding="utf-8")
            extras[file_type] = str(target)
        destination = self.root / "bundle.json"
        save_manual_genome_config(str(destination), [{
            "species": "Test species",
            "assembly": "test1",
            "files": {"fasta": str(self.fasta), **extras},
        }])
        genome = parse_manual_genome_config(str(destination))["entries"][0]["genome"]
        for file_type, path in extras.items():
            self.assertEqual(genome["files"][file_type], str(Path(path).resolve()))

    def test_unrecognised_file_types_survive_a_round_trip(self):
        future = self.root / "future.dat"
        future.write_text("x\n", encoding="utf-8")
        destination = self.root / "bundle.json"
        save_manual_genome_config(str(destination), [{
            "species": "Test species",
            "assembly": "test1",
            "files": {
                "fasta": str(self.fasta),
                "some_future_type": str(future),
                "not a key": str(future),
            },
        }])
        document = json.loads(destination.read_text(encoding="utf-8"))
        # Known types stay canonical and lead; the plausible extra follows; a
        # key that cannot be a file type is dropped.
        self.assertEqual(list(document["genomes"][0]["files"]), ["fasta", "some_future_type"])
        genome = parse_manual_genome_config(str(destination))["entries"][0]["genome"]
        self.assertEqual(genome["files"]["some_future_type"], str(future.resolve()))

    def _bundle_genome(self, species, assembly, accession="", release=""):
        record = {
            "species": species,
            "assembly": assembly,
            "files": {"fasta": str(self.fasta)},
        }
        if accession:
            record["accession"] = accession
        if release:
            record["dataset_release"] = {"key": release}
        return record

    def test_create_mode_refuses_to_touch_an_existing_file(self):
        destination = self.root / "bundle.json"
        save_manual_genome_config(str(destination), [self._bundle_genome("One", "v1")])
        with self.assertRaises(FileExistsError):
            save_manual_genome_config(
                str(destination),
                [self._bundle_genome("Two", "v2")],
                mode="create",
            )
        # The original file is untouched.
        document = json.loads(destination.read_text(encoding="utf-8"))
        self.assertEqual([g["species"] for g in document["genomes"]], ["One"])

    def test_overwrite_mode_replaces_the_file(self):
        destination = self.root / "bundle.json"
        save_manual_genome_config(str(destination), [self._bundle_genome("One", "v1")])
        result = save_manual_genome_config(
            str(destination),
            [self._bundle_genome("Two", "v2")],
            mode="overwrite",
        )
        document = json.loads(destination.read_text(encoding="utf-8"))
        self.assertEqual([g["species"] for g in document["genomes"]], ["Two"])
        self.assertEqual((result["added"], result["updated"]), (1, 0))

    def test_merge_mode_appends_without_duplicating(self):
        destination = self.root / "bundle.json"
        save_manual_genome_config(
            str(destination),
            [self._bundle_genome("One", "v1", accession="GCA_1")],
            [{"name": "Existing", "description": "kept"}],
        )
        result = save_manual_genome_config(
            str(destination),
            [
                # Same accession — updates in place rather than duplicating.
                self._bundle_genome("One renamed", "v1", accession="GCA_1"),
                self._bundle_genome("Two", "v2", accession="GCA_2"),
            ],
            [{"name": "existing"}, {"name": "Added", "description": "new"}],
            mode="merge",
        )
        self.assertEqual((result["added"], result["updated"], result["count"]), (1, 1, 2))
        document = json.loads(destination.read_text(encoding="utf-8"))
        self.assertEqual(
            [g["species"] for g in document["genomes"]],
            ["One renamed", "Two"],
        )
        # Playlists union case-insensitively and keep the existing description.
        self.assertEqual(
            document["playlists"],
            [{"name": "Existing", "description": "kept"}, {"name": "Added", "description": "new"}],
        )

    def test_merge_keeps_dataset_releases_of_one_assembly_distinct(self):
        destination = self.root / "bundle.json"
        save_manual_genome_config(
            str(destination),
            [self._bundle_genome("One", "v1", accession="GCA_1", release="ensembl/2023_03")],
        )
        result = save_manual_genome_config(
            str(destination),
            [self._bundle_genome("One", "v1", accession="GCA_1", release="ensembl/2024_11")],
            mode="merge",
        )
        self.assertEqual((result["added"], result["updated"], result["count"]), (1, 0, 2))

    def test_merge_matches_on_labels_when_there_is_no_accession(self):
        destination = self.root / "bundle.json"
        save_manual_genome_config(str(destination), [self._bundle_genome("Test  species", "v1")])
        result = save_manual_genome_config(
            str(destination),
            [self._bundle_genome("test species", "v1")],
            mode="merge",
        )
        self.assertEqual((result["added"], result["updated"], result["count"]), (0, 1, 1))

    def test_merge_refuses_a_destination_that_is_not_a_bundle(self):
        destination = self.root / "bundle.json"
        destination.write_text("not json at all", encoding="utf-8")
        with self.assertRaises(ValueError):
            save_manual_genome_config(
                str(destination),
                [self._bundle_genome("One", "v1")],
                mode="merge",
            )

    def test_unknown_save_mode_is_rejected(self):
        with self.assertRaises(ValueError):
            save_manual_genome_config(
                str(self.root / "bundle.json"),
                [self._bundle_genome("One", "v1")],
                mode="append",
            )

    def test_non_json_destination_is_rejected(self):
        with self.assertRaises(ValueError):
            save_manual_genome_config(str(self.root / "bundle.txt"), [{
                "species": "Test species",
                "assembly": "test1",
                "files": {"fasta": str(self.fasta)},
            }])

    def test_suffixless_destination_becomes_json(self):
        saved = save_manual_genome_config(str(self.root / "bundle"), [{
            "species": "Test species",
            "assembly": "test1",
            "files": {"fasta": str(self.fasta)},
        }])
        self.assertTrue(saved["path"].endswith("bundle.json"))


class AnnotationPreparationProgressTests(unittest.TestCase):
    def test_prepare_reports_monotonic_stages_and_counts(self):
        events = []
        with tempfile.TemporaryDirectory() as output_dir:
            prepare_annotation(
                str(FIXTURES / "stringtie.gtf"),
                output_dir=output_dir,
                compress=False,
                progress_callback=lambda stage, progress, message, counters: events.append(
                    (stage, progress, message, counters)
                ),
            )
        self.assertGreater(len(events), 3)
        self.assertEqual(
            [event[1] for event in events],
            sorted(event[1] for event in events),
        )
        stages = {event[0] for event in events}
        self.assertIn("parsing_annotation", stages)
        self.assertIn("building_gene_models", stages)
        self.assertIn("writing_annotation", stages)
        self.assertTrue(any(event[3].get("genes") for event in events))

    def test_task_status_exposes_the_latest_stage_and_counters(self):
        task_id = "manual-progress-test"
        with tempfile.TemporaryDirectory() as temp_dir:
            annotation = Path(temp_dir) / "genes.gtf"
            annotation.write_text(
                (FIXTURES / "stringtie.gtf").read_text(encoding="utf-8"),
                encoding="utf-8",
            )
            with main._validation_tasks_guard:
                main._validation_tasks[task_id] = {
                    "status": "running",
                    "progress": 0.0,
                    "stage": "starting",
                    "message": "Starting",
                    "counters": {},
                }
            try:
                report = main._run_validation_task(task_id, {
                    "kind": "prepare",
                    "annotation_path": str(annotation),
                })
                status = main.custom_validation_status(task_id)
                self.assertTrue(report["converted"])
                self.assertEqual(status["stage"], "registering")
                self.assertGreaterEqual(status["progress"], 98)
                self.assertGreater(status["counters"]["genes"], 0)
            finally:
                with main._validation_tasks_guard:
                    main._validation_tasks.pop(task_id, None)


class ManualGenomeConfigEndpointTests(unittest.TestCase):
    def test_save_then_read_endpoint_round_trip(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            fasta = root / "genome.fa"
            fasta.write_text(">chr1\nA\n", encoding="utf-8")
            destination = root / "manual-genomes.json"
            saved = asyncio.run(main.write_manual_genome_config(
                main.ManualGenomeConfigSaveRequest(
                    path=str(destination),
                    genomes=[{
                        "species": "Test species",
                        "assembly": "v1",
                        "files": {"fasta": str(fasta)},
                    }],
                )
            ))
            loaded = asyncio.run(main.read_manual_genome_config(
                main.ManualGenomeConfigReadRequest(path=str(destination))
            ))
            self.assertEqual(saved["count"], 1)
            self.assertTrue(loaded["ok"])
            self.assertEqual(loaded["valid_count"], 1)

    def test_save_rejects_a_path_that_is_not_a_configuration_file(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            fasta = Path(temp_dir) / "genome.fa"
            fasta.write_text(">chr1\nA\n", encoding="utf-8")
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(main.write_manual_genome_config(
                    main.ManualGenomeConfigSaveRequest(
                        path=str(Path(temp_dir) / "genomes.txt"),
                        genomes=[{
                            "species": "Test species",
                            "assembly": "v1",
                            "files": {"fasta": str(fasta)},
                        }],
                    )
                ))
            self.assertEqual(caught.exception.status_code, 400)

    def test_save_reports_an_existing_file_as_409(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            fasta = root / "genome.fa"
            fasta.write_text(">chr1\nA\n", encoding="utf-8")
            destination = root / "genomes.json"
            request = main.ManualGenomeConfigSaveRequest(
                path=str(destination),
                genomes=[{
                    "species": "Test species",
                    "assembly": "v1",
                    "files": {"fasta": str(fasta)},
                }],
            )
            asyncio.run(main.write_manual_genome_config(request))
            # The default mode never clobbers; the UI turns this into a choice.
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(main.write_manual_genome_config(request))
            self.assertEqual(caught.exception.status_code, 409)
            self.assertIn("genomes.json", caught.exception.detail)

    def test_read_reports_a_missing_file_as_404(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(main.read_manual_genome_config(
                    main.ManualGenomeConfigReadRequest(
                        path=str(Path(temp_dir) / "absent.json")
                    )
                ))
            self.assertEqual(caught.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
