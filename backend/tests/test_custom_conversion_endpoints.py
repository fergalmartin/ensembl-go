import asyncio
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException  # noqa: E402

import main  # noqa: E402
from main import (  # noqa: E402
    ConvertAnnotationRequest,
    CustomAnnotationRequest,
    convert_custom_annotation,
    custom_conversion_status,
    import_custom_annotation,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "annotation"


def _await_task(task_id, timeout=20.0):
    deadline = time.time() + timeout
    payload = {}
    while time.time() < deadline:
        payload = custom_conversion_status(task_id)
        if payload.get("status") in {"success", "failed"}:
            return payload
        time.sleep(0.02)
    raise AssertionError("conversion task did not finish: {0}".format(payload))


def _tmpdir(testcase):
    tmp = tempfile.TemporaryDirectory()
    testcase.addCleanup(tmp.cleanup)
    return tmp.name


class ConvertEndpointTests(unittest.TestCase):
    def _convert(self, name, **kwargs):
        request = ConvertAnnotationRequest(
            annotation_path=str(FIXTURES / name),
            output_dir=kwargs.pop("output_dir", None) or _tmpdir(self),
            **kwargs,
        )
        started = asyncio.run(convert_custom_annotation(request))
        return _await_task(started["task_id"])

    def test_gtf_conversion_succeeds(self):
        task = self._convert("stringtie.gtf", compress=False)
        self.assertEqual(task["status"], "success", task.get("error"))
        result = task["report"]
        self.assertEqual(result["gene_count"], 2)
        self.assertEqual(result["transcript_count"], 3)
        self.assertTrue(Path(result["output_path"]).is_file())
        self.assertTrue(result["output_path"].endswith(".ensembl.gff3"))

    def test_conversion_result_embeds_the_source_report(self):
        task = self._convert("braker.gtf", compress=False)
        report = task["report"]["report"]
        self.assertEqual(report["detected"]["dialect"], "gtf")
        self.assertIn("inference", report["conversion_preview"])

    def test_generated_ids_are_returned(self):
        task = self._convert(
            "stringtie.gtf", compress=False, id_mode="generate", id_prefix="ENSXYZ"
        )
        result = task["report"]
        self.assertEqual(result["id_mode"], "generate")
        self.assertEqual(result["id_prefix"], "ENSXYZ")
        self.assertTrue(Path(result["id_map_path"]).is_file())

    def test_bad_prefix_is_rejected_before_queueing(self):
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(convert_custom_annotation(ConvertAnnotationRequest(
                annotation_path=str(FIXTURES / "stringtie.gtf"),
                output_dir=_tmpdir(self),
                id_mode="generate",
                id_prefix="x",
            )))
        self.assertEqual(ctx.exception.status_code, 400)

    def test_missing_annotation_is_404(self):
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(convert_custom_annotation(ConvertAnnotationRequest(
                annotation_path=str(FIXTURES / "nope.gff3"),
                output_dir=_tmpdir(self),
            )))
        self.assertEqual(ctx.exception.status_code, 404)

    def test_output_dir_pointing_at_a_file_is_400(self):
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(convert_custom_annotation(ConvertAnnotationRequest(
                annotation_path=str(FIXTURES / "stringtie.gtf"),
                output_dir=str(FIXTURES / "stringtie.gtf"),
            )))
        self.assertEqual(ctx.exception.status_code, 400)

    def test_duplicate_ids_surface_as_a_failed_task(self):
        source = Path(_tmpdir(self)) / "dup.gff3"
        source.write_text(
            "##gff-version 3\n"
            "chr1\tsrc\tgene\t100\t200\t.\t+\t.\tID=g1\n"
            "chr1\tsrc\tmRNA\t100\t200\t.\t+\t.\tID=t1;Parent=g1\n"
            "chr1\tsrc\texon\t100\t200\t.\t+\t.\tParent=t1\n"
            "chr2\tsrc\tgene\t100\t200\t.\t+\t.\tID=g1\n"
            "chr2\tsrc\tmRNA\t100\t200\t.\t+\t.\tID=t1;Parent=g1\n"
            "chr2\tsrc\texon\t100\t200\t.\t+\t.\tParent=t1\n",
            encoding="utf-8",
        )
        started = asyncio.run(convert_custom_annotation(ConvertAnnotationRequest(
            annotation_path=str(source),
            output_dir=_tmpdir(self),
            compress=False,
        )))
        task = _await_task(started["task_id"])
        self.assertEqual(task["status"], "failed")
        self.assertIn("duplicate", (task["error"] or "").lower())


class ImportWithConversionTests(unittest.TestCase):
    def _assembly(self):
        root = Path(_tmpdir(self))
        asm_dir = root / "local_data" / "Test_species" / "GCA_000005845.2"
        asm_dir.mkdir(parents=True)
        (asm_dir / "GCA_000005845.2.fa").write_text(">chr1\nACGT\n", encoding="utf-8")
        return root, asm_dir

    def test_gtf_import_requires_conversion(self):
        root, _ = self._assembly()
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(import_custom_annotation(CustomAnnotationRequest(
                output_dir=str(root),
                species_key="Test_species",
                assembly="GCA_000005845.2",
                gff3_path=str(FIXTURES / "stringtie.gtf"),
                convert=False,
            )))
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("conversion", ctx.exception.detail.lower())

    def test_gtf_import_with_conversion_registers_the_converted_file(self):
        root, asm_dir = self._assembly()
        result = asyncio.run(import_custom_annotation(CustomAnnotationRequest(
            output_dir=str(root),
            species_key="Test_species",
            assembly="GCA_000005845.2",
            gff3_path=str(FIXTURES / "stringtie.gtf"),
            label="custom converted",
            convert=True,
        )))
        self.assertEqual(result["status"], "created")
        self.assertTrue(result["conversion"]["converted"])
        self.assertEqual(result["conversion"]["gene_count"], 2)
        self.assertEqual(result["conversion"]["dialect"], "gtf")

        registered = Path(result["path"])
        self.assertTrue(registered.is_file())
        self.assertIn(".ensembl.gff3", registered.name)

    def test_original_is_kept_beside_the_converted_file(self):
        root, _ = self._assembly()
        result = asyncio.run(import_custom_annotation(CustomAnnotationRequest(
            output_dir=str(root),
            species_key="Test_species",
            assembly="GCA_000005845.2",
            gff3_path=str(FIXTURES / "braker.gtf"),
            convert=True,
        )))
        original = Path(result["conversion"]["original_path"])
        self.assertTrue(original.is_file())
        self.assertIn("braker.gtf", original.name)

    def test_conversion_summary_is_written_to_the_manifest(self):
        root, asm_dir = self._assembly()
        asyncio.run(import_custom_annotation(CustomAnnotationRequest(
            output_dir=str(root),
            species_key="Test_species",
            assembly="GCA_000005845.2",
            gff3_path=str(FIXTURES / "stringtie.gtf"),
            convert=True,
        )))
        manifest_path = asm_dir / "GCA_000005845.2.genome_manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        release = next(iter(manifest["dataset_releases"].values()))
        self.assertTrue(release["conversion"]["converted"])
        self.assertEqual(release["conversion"]["gene_count"], 2)
        # The full report is deliberately not persisted into the manifest.
        self.assertNotIn("report", release["conversion"])

    def test_gff3_import_without_conversion_still_copies_verbatim(self):
        root, _ = self._assembly()
        result = asyncio.run(import_custom_annotation(CustomAnnotationRequest(
            output_dir=str(root),
            species_key="Test_species",
            assembly="GCA_000005845.2",
            gff3_path=str(FIXTURES / "ensembl.gff3"),
            convert=False,
        )))
        self.assertEqual(result["conversion"], {})
        copied = Path(result["path"])
        self.assertEqual(
            copied.read_text(encoding="utf-8"),
            (FIXTURES / "ensembl.gff3").read_text(encoding="utf-8"),
        )

    def test_generated_ids_flow_through_the_import(self):
        root, _ = self._assembly()
        result = asyncio.run(import_custom_annotation(CustomAnnotationRequest(
            output_dir=str(root),
            species_key="Test_species",
            assembly="GCA_000005845.2",
            gff3_path=str(FIXTURES / "stringtie.gtf"),
            convert=True,
            id_mode="generate",
            id_prefix="ENSXYZ",
        )))
        self.assertEqual(result["conversion"]["id_mode"], "generate")
        self.assertTrue(Path(result["conversion"]["id_map_path"]).is_file())

    def test_duplicate_ids_are_a_400_not_a_partial_import(self):
        root, asm_dir = self._assembly()
        source = Path(_tmpdir(self)) / "dup.gff3"
        source.write_text(
            "##gff-version 3\n"
            "chr1\tsrc\tgene\t100\t200\t.\t+\t.\tID=g1\n"
            "chr1\tsrc\tmRNA\t100\t200\t.\t+\t.\tID=t1;Parent=g1\n"
            "chr1\tsrc\texon\t100\t200\t.\t+\t.\tParent=t1\n"
            "chr2\tsrc\tgene\t100\t200\t.\t+\t.\tID=g1\n"
            "chr2\tsrc\tmRNA\t100\t200\t.\t+\t.\tID=t1;Parent=g1\n"
            "chr2\tsrc\texon\t100\t200\t.\t+\t.\tParent=t1\n",
            encoding="utf-8",
        )
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(import_custom_annotation(CustomAnnotationRequest(
                output_dir=str(root),
                species_key="Test_species",
                assembly="GCA_000005845.2",
                gff3_path=str(source),
                convert=True,
            )))
        self.assertEqual(ctx.exception.status_code, 400)
        # The half-built release directory must not be left behind.
        self.assertEqual(list((asm_dir / "datasets" / "custom").glob("*")), [])

    def test_unsupported_extension_is_rejected(self):
        root, _ = self._assembly()
        bogus = Path(_tmpdir(self)) / "notes.txt"
        bogus.write_text("hello", encoding="utf-8")
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(import_custom_annotation(CustomAnnotationRequest(
                output_dir=str(root),
                species_key="Test_species",
                assembly="GCA_000005845.2",
                gff3_path=str(bogus),
            )))
        self.assertEqual(ctx.exception.status_code, 400)


class ConvertedFileIsIndexableTests(unittest.TestCase):
    def test_imported_conversion_builds_a_real_index(self):
        root = Path(_tmpdir(self))
        asm_dir = root / "local_data" / "Test_species" / "GCA_000005845.2"
        asm_dir.mkdir(parents=True)
        (asm_dir / "GCA_000005845.2.fa").write_text(">chr1\nACGT\n", encoding="utf-8")

        result = asyncio.run(import_custom_annotation(CustomAnnotationRequest(
            output_dir=str(root),
            species_key="Test_species",
            assembly="GCA_000005845.2",
            gff3_path=str(FIXTURES / "braker.gtf"),
            convert=True,
        )))

        db_path = str(Path(_tmpdir(self)) / "index.db")
        main.create_gff_index(result["path"], db_path)

        import sqlite3
        conn = sqlite3.connect(db_path)
        self.addCleanup(conn.close)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM genes").fetchone()[0], 2)
        self.assertEqual(
            conn.execute("SELECT COUNT(*) FROM transcripts").fetchone()[0], 2
        )


if __name__ == "__main__":
    unittest.main()
