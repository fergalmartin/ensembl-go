import asyncio
import json
import sqlite3
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main  # noqa: E402


async def _noop_download(url, destination, task_id):
    del url, destination, task_id
    return None


def _write_usable_index(db_path: Path, gff_path: Path, version: str = "") -> None:
    stat = gff_path.stat()
    conn = sqlite3.connect(db_path)
    try:
        c = conn.cursor()
        c.execute("CREATE TABLE genes (id TEXT PRIMARY KEY)")
        c.execute("CREATE TABLE transcripts (id TEXT PRIMARY KEY)")
        c.execute("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT)")
        c.executemany(
            "INSERT INTO metadata (key, value) VALUES (?, ?)",
            [
                ("source_gff", str(gff_path.resolve())),
                ("source_mtime_ns", str(stat.st_mtime_ns)),
                ("source_size", str(stat.st_size)),
                ("index_format_version", version or main.GFF_INDEX_FORMAT_VERSION),
            ],
        )
        conn.commit()
    finally:
        conn.close()


class LocalAssembliesTests(unittest.TestCase):
    def test_version_five_index_remains_usable_without_rebuild(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            gff_path = root / "test.gff3"
            db_path = root / "test.gff3.index.db"
            gff_path.write_text("##gff-version 3\n", encoding="utf-8")
            _write_usable_index(db_path, gff_path, version="5")

            with patch.object(main, "create_gff_index") as create_mock:
                result = main.ensure_gff_index(str(gff_path), str(db_path))

            self.assertEqual(result, str(db_path.resolve()))
            create_mock.assert_not_called()
            self.assertFalse(Path(f"{db_path.resolve()}.build.lock").exists())

    def test_failed_rebuild_preserves_existing_index_file(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            gff_path = root / "test.gff3"
            db_path = root / "test.gff3.index.db"
            gff_path.write_text("##gff-version 3\n", encoding="utf-8")
            original = b"existing index must survive"
            db_path.write_bytes(original)

            with patch.object(main, "create_gff_index", side_effect=RuntimeError("build failed")):
                with self.assertRaisesRegex(RuntimeError, "build failed"):
                    main.ensure_gff_index(str(gff_path), str(db_path))

            self.assertEqual(db_path.read_bytes(), original)

    def test_concurrent_ensure_builds_index_once_and_swaps_atomically(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            gff_path = root / "test.gff3"
            db_path = root / "test.gff3.index.db"
            gff_path.write_text("##gff-version 3\n", encoding="utf-8")
            db_path.write_bytes(b"old invalid index")
            build_paths = []
            build_started = threading.Event()
            allow_build_to_finish = threading.Event()

            def fake_create(gff, target):
                self.assertEqual(gff, str(gff_path.resolve()))
                build_paths.append(target)
                build_started.set()
                self.assertTrue(allow_build_to_finish.wait(timeout=2))
                _write_usable_index(Path(target), gff_path)

            results = []

            def ensure():
                results.append(main.ensure_gff_index(str(gff_path), str(db_path)))

            with patch.object(main, "create_gff_index", side_effect=fake_create):
                first = threading.Thread(target=ensure)
                second = threading.Thread(target=ensure)
                first.start()
                self.assertTrue(build_started.wait(timeout=2))
                second.start()
                allow_build_to_finish.set()
                first.join(timeout=3)
                second.join(timeout=3)

            self.assertFalse(first.is_alive())
            self.assertFalse(second.is_alive())
            self.assertEqual(len(build_paths), 1)
            self.assertNotEqual(build_paths[0], str(db_path))
            self.assertEqual(results, [str(db_path.resolve()), str(db_path.resolve())])
            self.assertTrue(main._is_existing_index_usable(str(db_path), str(gff_path)))

    def test_check_local_files_accepts_bgz_fasta_and_gff3(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            asm_dir = root / "local_data" / "Test_species" / "GCA_000005845.2"
            asm_dir.mkdir(parents=True)
            (asm_dir / "GCA_000005845.2.softmasked.fa.bgz").write_bytes(b"\x1f\x8bFAKE")
            (asm_dir / "GCA_000005845.2.gff3.bgz").write_bytes(b"\x1f\x8bFAKE")

            result = asyncio.run(main.check_local_files(str(root), "Test_species", "GCA_000005845.2"))

        self.assertIn("fasta", result["types"])
        self.assertIn("gff3", result["types"])

    def test_local_assemblies_reports_bgz_files(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            asm_dir = root / "local_data" / "Test_species" / "GCA_000005845.2"
            asm_dir.mkdir(parents=True)
            fasta_path = asm_dir / "GCA_000005845.2.softmasked.fa.bgz"
            gff_path = asm_dir / "GCA_000005845.2.gff3.bgz"
            fasta_path.write_bytes(b"\x1f\x8bFAKE")
            gff_path.write_bytes(b"\x1f\x8bFAKE")

            items = asyncio.run(main.list_local_assemblies(str(root)))
            item = next((entry for entry in items if entry["assembly"] == "GCA_000005845.2"), None)

        self.assertIsNotNone(item)
        self.assertIn("fasta", item["types"])
        self.assertIn("gff3", item["types"])
        self.assertEqual(item["files"]["fasta"], str(fasta_path.resolve()))
        self.assertEqual(item["files"]["gff3"], str(gff_path.resolve()))

    def test_local_assemblies_reports_existing_ncbi_index(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            asm_dir = root / "local_data" / "ncbi" / "Ailuropoda_melanoleuca" / "GCF_002007445.2"
            asm_dir.mkdir(parents=True)

            gff_path = asm_dir / "GCF_002007445.2.genomic.gff"
            gff_path.write_text("##gff-version 3\nchr1\tRefSeq\tgene\t1\t10\t.\t+\t.\tID=gene1\n", encoding="utf-8")
            fasta_path = asm_dir / "GCF_002007445.2_ASM200744v3_genomic.fna"
            fasta_path.write_text(">chr1\nACGTACGTAC\n", encoding="utf-8")
            (asm_dir / "GCF_002007445.2.metadata.json").write_text(
                json.dumps({
                    "scientific_name": "Ailuropoda melanoleuca",
                    "common_name": "giant panda",
                    "source_database": "RefSeq",
                }),
                encoding="utf-8",
            )

            invalid_index = asm_dir / "GCF_002007445.2.legacy.index.db"
            invalid_index.write_text("not sqlite", encoding="utf-8")
            canonical_index = asm_dir / "GCF_002007445.2.gff3.index.db"
            _write_usable_index(canonical_index, gff_path)

            items = asyncio.run(main.list_local_assemblies(str(root)))
            item = next((entry for entry in items if entry["assembly"] == "GCF_002007445.2"), None)

            self.assertIsNotNone(item)
            self.assertIn("fasta", item["types"])
            self.assertIn("gff3", item["types"])
            self.assertEqual(item["files"]["gff3"], str(gff_path.resolve()))
            self.assertEqual(item["files"]["index"], str(canonical_index.resolve()))

    def test_release_aware_local_assemblies_exposes_active_release_and_legacy(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            asm_dir = root / "local_data" / "Test_species" / "GCA_000005845.2"
            assembly_dir = asm_dir / "assembly"
            release_dir = asm_dir / "datasets" / "ensembl" / "2025_12"
            older_release_dir = asm_dir / "datasets" / "ensembl" / "2024_01"
            legacy_gff = asm_dir / "GCA_000005845.2.legacy.gff3.gz"
            assembly_dir.mkdir(parents=True)
            release_dir.mkdir(parents=True)
            older_release_dir.mkdir(parents=True)

            fasta_path = assembly_dir / "GCA_000005845.2.softmasked.fa.bgz"
            gff_path = release_dir / "GCA_000005845.2.gff3.gz"
            homology_path = release_dir / "GCA_000005845.2.homology.tsv.gz"
            older_gff_path = older_release_dir / "GCA_000005845.2.gff3.gz"
            fasta_path.write_bytes(b"\x1f\x8bFAKE")
            gff_path.write_bytes(b"\x1f\x8bFAKE")
            homology_path.write_bytes(b"\x1f\x8bFAKE")
            older_gff_path.write_bytes(b"\x1f\x8bFAKE")
            legacy_gff.write_bytes(b"\x1f\x8bFAKE")
            (asm_dir / "GCA_000005845.2.genome_manifest.json").write_text(
                json.dumps({
                    "manifest_version": 2,
                    "species_key": "Test_species",
                    "assembly": "GCA_000005845.2",
                    "scientific_name": "Test species",
                    "active_dataset_release_key": "ensembl/2025_12",
                    "dataset_releases": {
                        "ensembl/2025_12": {
                            "source": "ensembl",
                            "date": "2025_12",
                            "label": "ensembl 2025_12",
                            "files": {},
                        }
                    },
                }),
                encoding="utf-8",
            )

            items = asyncio.run(main.list_local_assemblies(str(root)))
            item = next((entry for entry in items if entry["assembly"] == "GCA_000005845.2"), None)

        self.assertIsNotNone(item)
        self.assertEqual(item["files"]["fasta"], str(fasta_path.resolve()))
        self.assertEqual(item["files"]["gff3"], str(gff_path.resolve()))
        self.assertEqual(item["files"]["homology"], str(homology_path.resolve()))
        self.assertEqual(item["active_dataset_release_key"], "ensembl/2025_12")
        self.assertEqual(item["default_dataset_release_key"], "ensembl/2025_12")
        self.assertEqual(item["dataset_release_key"], "ensembl/2025_12")
        self.assertTrue(item["selection_key"].endswith("::dataset::ensembl/2025_12"))
        release_keys = {entry["key"] for entry in item["dataset_releases"]}
        self.assertIn("ensembl/2025_12", release_keys)
        self.assertIn("ensembl/2024_01", release_keys)
        self.assertIn("legacy/unknown", release_keys)
        instances = {entry["dataset_release_key"]: entry for entry in item["dataset_instances"]}
        self.assertEqual(instances["ensembl/2025_12"]["files"]["gff3"], str(gff_path.resolve()))
        self.assertEqual(instances["ensembl/2024_01"]["files"]["gff3"], str(older_gff_path.resolve()))
        self.assertEqual(instances["ensembl/2024_01"]["files"]["fasta"], str(fasta_path.resolve()))
        self.assertNotEqual(instances["ensembl/2025_12"]["selection_key"], instances["ensembl/2024_01"]["selection_key"])

    def test_local_assemblies_prefers_saved_default_dataset_release(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            asm_dir = root / "local_data" / "Test_species" / "GCA_000005845.2"
            assembly_dir = asm_dir / "assembly"
            latest_release_dir = asm_dir / "datasets" / "ensembl" / "2025_12"
            older_release_dir = asm_dir / "datasets" / "ensembl" / "2024_01"
            assembly_dir.mkdir(parents=True)
            latest_release_dir.mkdir(parents=True)
            older_release_dir.mkdir(parents=True)

            fasta_path = assembly_dir / "GCA_000005845.2.softmasked.fa.bgz"
            latest_gff_path = latest_release_dir / "GCA_000005845.2.gff3.gz"
            older_gff_path = older_release_dir / "GCA_000005845.2.gff3.gz"
            fasta_path.write_bytes(b"\x1f\x8bFAKE")
            latest_gff_path.write_bytes(b"\x1f\x8bFAKE")
            older_gff_path.write_bytes(b"\x1f\x8bFAKE")
            (asm_dir / "GCA_000005845.2.genome_manifest.json").write_text(
                json.dumps({
                    "manifest_version": 2,
                    "species_key": "Test_species",
                    "assembly": "GCA_000005845.2",
                    "scientific_name": "Test species",
                    "default_dataset_release_key": "ensembl/2024_01",
                    "dataset_releases": {
                        "ensembl/2024_01": {
                            "source": "ensembl",
                            "date": "2024_01",
                            "label": "ensembl 2024_01",
                            "files": {},
                        },
                    },
                }),
                encoding="utf-8",
            )

            items = asyncio.run(main.list_local_assemblies(str(root)))
            item = next((entry for entry in items if entry["assembly"] == "GCA_000005845.2"), None)

        self.assertIsNotNone(item)
        self.assertEqual(item["default_dataset_release_key"], "ensembl/2024_01")
        self.assertEqual(item["dataset_release_key"], "ensembl/2024_01")
        self.assertEqual(item["files"]["gff3"], str(older_gff_path.resolve()))
        instances = {entry["dataset_release_key"]: entry for entry in item["dataset_instances"]}
        self.assertTrue(instances["ensembl/2024_01"]["is_default_dataset"])
        self.assertFalse(instances["ensembl/2025_12"]["is_default_dataset"])

    def test_custom_annotation_import_adds_managed_dataset_release(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            asm_dir = root / "local_data" / "Test_species" / "GCA_000005845.2"
            assembly_dir = asm_dir / "assembly"
            assembly_dir.mkdir(parents=True)
            fasta_path = assembly_dir / "GCA_000005845.2.softmasked.fa.bgz"
            fasta_path.write_bytes(b"\x1f\x8bFAKE")
            (asm_dir / "GCA_000005845.2.genome_manifest.json").write_text(
                json.dumps({
                    "manifest_version": 2,
                    "species_key": "Test_species",
                    "assembly": "GCA_000005845.2",
                    "scientific_name": "Test species",
                    "assembly_name": "ASM584v2",
                    "dataset_releases": {},
                }),
                encoding="utf-8",
            )
            source_gff = root / "custom_source.gff3"
            source_gff.write_text("##gff-version 3\nchr1\tcustom\tgene\t1\t10\t.\t+\t.\tID=gene1\n", encoding="utf-8")

            result = asyncio.run(main.import_custom_annotation(main.CustomAnnotationRequest(
                output_dir=str(root),
                provider="ensembl",
                species_key="Test_species",
                assembly="GCA_000005845.2",
                gff3_path=str(source_gff),
                label="custom review",
            )))

            duplicate = asyncio.run(main.import_custom_annotation(main.CustomAnnotationRequest(
                output_dir=str(root),
                provider="ensembl",
                species_key="Test_species",
                assembly="GCA_000005845.2",
                gff3_path=str(source_gff),
                label="custom review",
            )))

            manifest = json.loads((asm_dir / "GCA_000005845.2.genome_manifest.json").read_text(encoding="utf-8"))

            self.assertEqual(result["status"], "created")
            self.assertEqual(result["dataset_release_key"], "custom/custom_review")
            self.assertEqual(duplicate["dataset_release_key"], "custom/custom_review_2")
            self.assertTrue(source_gff.exists())
            copied_path = Path(result["path"])
            self.assertTrue(copied_path.exists())
            self.assertIn("datasets/custom/custom_review", str(copied_path))
            release = manifest["dataset_releases"]["custom/custom_review"]
            self.assertEqual(release["source"], "custom")
            self.assertEqual(release["label"], "custom review")
            self.assertEqual(release["files"]["gff3"]["source_path"], str(source_gff.resolve()))
            instances = {entry["dataset_release_key"]: entry for entry in result["assembly"]["dataset_instances"]}
            self.assertEqual(instances["custom/custom_review"]["files"]["gff3"], str(copied_path.resolve()))
            self.assertEqual(instances["custom/custom_review"]["files"]["fasta"], str(fasta_path.resolve()))

    def test_start_download_places_dataset_files_under_release_directory(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            main.download_manager.tasks = {}
            request = main.DownloadRequest(
                url="https://ftp.ebi.ac.uk/pub/ensemblorganisms/GCA/000/005/845/2/ensembl/2025_12/geneset/genes.gff3.gz",
                filename="genes.gff3.gz",
                species_key="Test_species",
                assembly="GCA_000005845.2",
                provider="ensembl",
                file_type="gff3",
                output_dir=str(root),
                scientific_name="Test species",
                assembly_name="ASM584v2",
                dataset_release_key="ensembl/2025_12",
                dataset_release_source="ensembl",
                dataset_release_date="2025_12",
                dataset_release_label="ensembl 2025_12",
            )
            with patch.object(main.download_manager, "download_file", side_effect=_noop_download), \
                    patch.object(main.download_manager, "get_download_urls", return_value=[]):
                result = asyncio.run(main.start_download(request))

            self.assertEqual(result["status"], "started")
            task = next(iter(main.download_manager.tasks.values()))
            expected = (root / "local_data" / "Test_species" / "GCA_000005845.2" / "datasets" / "ensembl" / "2025_12" / "GCA_000005845.2.gff3.gz").resolve()
            self.assertEqual(Path(task.destination), expected)
            manifest = json.loads((root / "local_data" / "Test_species" / "GCA_000005845.2" / "GCA_000005845.2.genome_manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["active_dataset_release_key"], "ensembl/2025_12")
            self.assertIn("ensembl/2025_12", manifest["dataset_releases"])

    def test_start_download_infers_release_from_ensembl_url_when_client_omits_it(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            main.download_manager.tasks = {}
            request = main.DownloadRequest(
                url="https://ftp.ebi.ac.uk/pub/ensemblorganisms/GCA/018/472/595/2/ensembl/2024_10/geneset/genes.gff3.gz",
                filename="genes.gff3.gz",
                species_key="Homo_sapiens",
                assembly="GCA_018472595.2",
                provider="ensembl",
                file_type="gff3",
                output_dir=str(root),
                scientific_name="Homo sapiens",
                assembly_name="HG00438_pat_hprc_f2",
            )
            with patch.object(main.download_manager, "download_file", side_effect=_noop_download), \
                    patch.object(main.download_manager, "get_download_urls", return_value=[]):
                result = asyncio.run(main.start_download(request))

            self.assertEqual(result["status"], "started")
            task = next(iter(main.download_manager.tasks.values()))
            self.assertEqual(task.dataset_release_key, "ensembl/2024_10")
            self.assertIn("datasets/ensembl/2024_10", task.destination)
            manifest_path = root / "local_data" / "Homo_sapiens" / "GCA_018472595.2" / "GCA_018472595.2.genome_manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(manifest["active_dataset_release_key"], "ensembl/2024_10")
            self.assertNotIn("legacy/unknown", manifest["dataset_releases"])

    def test_index_only_directory_is_not_exposed_as_legacy_dataset(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            asm_dir = Path(tmpdir) / "GCA_018472595.2"
            legacy_dir = asm_dir / "datasets" / "legacy" / "unknown"
            legacy_dir.mkdir(parents=True)
            (legacy_dir / "GCA_018472595.2.gff3.index.db").write_bytes(b"orphaned index")

            scanned = main._scan_local_assembly(asm_dir, "GCA_018472595.2")

        self.assertEqual(scanned["dataset_releases"], [])
        self.assertEqual(scanned["active_dataset_release_key"], "")


if __name__ == "__main__":
    unittest.main()
