import asyncio
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException  # noqa: E402

from main import (  # noqa: E402
    ValidateAnnotationRequest,
    ValidateGenomeRequest,
    custom_sniff_annotation,
    custom_validation_status,
    validate_custom_annotation,
    validate_custom_genome,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "annotation"


def _await_task(task_id, timeout=15.0):
    """Poll a queued validation task until it reaches a terminal state."""
    deadline = time.time() + timeout
    payload = {}
    while time.time() < deadline:
        payload = custom_validation_status(task_id)
        if payload.get("status") in {"success", "failed"}:
            return payload
        time.sleep(0.02)
    raise AssertionError("validation task did not finish: {0}".format(payload))


def _validate_genome(path):
    started = asyncio.run(validate_custom_genome(ValidateGenomeRequest(fasta_path=str(path))))
    return _await_task(started["task_id"])


def _validate_annotation(path, fasta_path=None):
    request = ValidateAnnotationRequest(
        annotation_path=str(path),
        fasta_path=str(fasta_path) if fasta_path else None,
    )
    started = asyncio.run(validate_custom_annotation(request))
    return _await_task(started["task_id"])


class ValidateGenomeEndpointTests(unittest.TestCase):
    def test_scan_returns_report(self):
        task = _validate_genome(FIXTURES / "genome.fa")
        self.assertEqual(task["status"], "success", task.get("error"))

        report = task["report"]
        self.assertEqual(report["sequence_count"], 2)
        self.assertEqual(report["total_length"], 364)
        self.assertEqual(report["longest_length"], 244)
        self.assertEqual(report["shortest_length"], 120)
        self.assertEqual(report["base_counts"]["N"], 60)
        self.assertAlmostEqual(report["gc_percent"], 70.0, places=3)
        self.assertEqual(report["n50"], 244)

    def test_progress_reaches_complete(self):
        task = _validate_genome(FIXTURES / "genome.fa")
        self.assertEqual(task["progress"], 100.0)
        self.assertEqual(task["kind"], "genome")

    def test_missing_file_is_404(self):
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(
                validate_custom_genome(
                    ValidateGenomeRequest(fasta_path=str(FIXTURES / "does_not_exist.fa"))
                )
            )
        self.assertEqual(ctx.exception.status_code, 404)

    def test_empty_path_is_400(self):
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(validate_custom_genome(ValidateGenomeRequest(fasta_path="   ")))
        self.assertEqual(ctx.exception.status_code, 400)

    def test_directory_is_rejected(self):
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(
                validate_custom_genome(ValidateGenomeRequest(fasta_path=str(FIXTURES)))
            )
        self.assertEqual(ctx.exception.status_code, 404)


class ValidateAnnotationEndpointTests(unittest.TestCase):
    def test_gtf_reports_genes_and_transcripts(self):
        report = _validate_annotation(FIXTURES / "stringtie.gtf")["report"]
        self.assertEqual(report["detected"]["dialect"], "gtf")
        self.assertEqual(report["detected"]["producer_guess"], "StringTie")
        self.assertEqual(report["counts"]["genes"], 2)
        self.assertEqual(report["counts"]["transcripts"], 3)
        self.assertEqual(report["counts"]["exons"], 6)

    def test_biotype_classification_is_reported(self):
        report = _validate_annotation(FIXTURES / "stringtie.gtf")["report"]
        biotypes = report["classification"]["transcript_biotypes"]
        self.assertEqual(biotypes.get("lncRNA"), 2)
        self.assertEqual(biotypes.get("sncRNA"), 1)

    def test_conversion_preview_is_reported(self):
        report = _validate_annotation(FIXTURES / "braker.gtf")["report"]
        self.assertIn("exons_from_cds", report["conversion_preview"]["inference"])

    def test_ensembl_file_reports_no_errors(self):
        report = _validate_annotation(FIXTURES / "ensembl.gff3")["report"]
        self.assertEqual(report["error_count"], 0)
        self.assertEqual(report["counts"]["genes"], 3)

    def test_fasta_cross_check_runs_when_supplied(self):
        report = _validate_annotation(
            FIXTURES / "ensembl.gff3", fasta_path=FIXTURES / "genome.fa"
        )["report"]
        regions = report["sequence_regions"]
        self.assertTrue(regions["fasta_checked"])
        # The fixture annotation is on chr1 only; chr2 carries no features.
        self.assertEqual(regions["fasta_regions_without_annotation"], 1)

    def test_cross_check_is_skipped_without_a_fasta(self):
        report = _validate_annotation(FIXTURES / "ensembl.gff3")["report"]
        self.assertFalse(report["sequence_regions"]["fasta_checked"])

    def test_missing_annotation_is_404(self):
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(
                validate_custom_annotation(
                    ValidateAnnotationRequest(annotation_path=str(FIXTURES / "nope.gff3"))
                )
            )
        self.assertEqual(ctx.exception.status_code, 404)

    def test_bad_fasta_path_is_rejected_before_queueing(self):
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(
                validate_custom_annotation(
                    ValidateAnnotationRequest(
                        annotation_path=str(FIXTURES / "ensembl.gff3"),
                        fasta_path=str(FIXTURES / "nope.fa"),
                    )
                )
            )
        self.assertEqual(ctx.exception.status_code, 404)


class SniffEndpointTests(unittest.TestCase):
    def test_sniff_reports_dialect_without_full_parse(self):
        payload = custom_sniff_annotation(str(FIXTURES / "braker.gtf"))
        self.assertEqual(payload["dialect"], "gtf")
        self.assertEqual(payload["producer_guess"], "AUGUSTUS")
        self.assertGreater(payload["bare_lines"], 0)

    def test_sniff_gff3(self):
        payload = custom_sniff_annotation(str(FIXTURES / "ensembl.gff3"))
        self.assertEqual(payload["dialect"], "gff3")
        self.assertEqual(payload["gff_version"], "3")

    def test_sniff_missing_file(self):
        with self.assertRaises(HTTPException) as ctx:
            custom_sniff_annotation("/nope/missing.gff3")
        self.assertEqual(ctx.exception.status_code, 404)


class ValidationTaskRegistryTests(unittest.TestCase):
    def test_unknown_task_id_is_404(self):
        with self.assertRaises(HTTPException) as ctx:
            custom_validation_status("not-a-real-task")
        self.assertEqual(ctx.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
