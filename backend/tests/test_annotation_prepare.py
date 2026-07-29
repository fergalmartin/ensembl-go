import asyncio
import os
import shutil
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException  # noqa: E402

import main  # noqa: E402
from annotation.convert import conversion_required, prepare_annotation  # noqa: E402
from annotation.normalize import normalize_annotation  # noqa: E402
from main import (  # noqa: E402
    PrepareAnnotationRequest,
    custom_conversion_status,
    prepare_custom_annotation,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "annotation"


def _tmpdir(testcase):
    tmp = tempfile.TemporaryDirectory()
    testcase.addCleanup(tmp.cleanup)
    return tmp.name


def _staged(testcase, name):
    """Copy a fixture somewhere writable so conversion can sit beside it."""
    target = Path(_tmpdir(testcase)) / name
    shutil.copy2(FIXTURES / name, target)
    return str(target)


class ConversionRequiredTests(unittest.TestCase):
    def _required(self, name, id_mode="keep"):
        return conversion_required(normalize_annotation(str(FIXTURES / name)), id_mode)

    def test_gtf_always_requires_conversion(self):
        for name in ("stringtie.gtf", "scallop.gtf", "braker.gtf", "tiberius.gtf"):
            required, reason = self._required(name)
            self.assertTrue(required, name)
            self.assertIn("GTF", reason)

    def test_clean_gff3_passes_through(self):
        # Ensembl and RefSeq files the indexer already handles must not be
        # rewritten; that keeps existing behaviour intact. refseq.gff3 includes
        # a prokaryote-style gene-parented CDS, which the indexer models the
        # same way we do, so it must not trigger conversion either.
        for name in ("ensembl.gff3", "refseq.gff3", "helixer.gff3", "egapx.gff3"):
            required, reason = self._required(name)
            self.assertFalse(required, "{0}: {1}".format(name, reason))

    def test_single_block_cds_does_not_force_conversion(self):
        # One CDS block and no exon rows: the indexer's single-exon fallback
        # produces exactly the same model, so there is nothing to gain.
        path = Path(_tmpdir(self)) / "single.gff3"
        path.write_text(
            "##gff-version 3\n"
            "chr1\tsrc\tgene\t100\t399\t.\t+\t.\tID=g1;biotype=protein_coding\n"
            "chr1\tsrc\tmRNA\t100\t399\t.\t+\t.\tID=t1;Parent=g1\n"
            "chr1\tsrc\tCDS\t100\t399\t.\t+\t0\tParent=t1\n",
            encoding="utf-8",
        )
        required, reason = conversion_required(normalize_annotation(str(path)))
        self.assertFalse(required, reason)

    def test_multi_block_cds_forces_conversion(self):
        # Two CDS blocks and no exon rows: the indexer would draw one exon
        # straight across the intron.
        path = Path(_tmpdir(self)) / "multi.gff3"
        path.write_text(
            "##gff-version 3\n"
            "chr1\tsrc\tgene\t100\t999\t.\t+\t.\tID=g1;biotype=protein_coding\n"
            "chr1\tsrc\tmRNA\t100\t999\t.\t+\t.\tID=t1;Parent=g1\n"
            "chr1\tsrc\tCDS\t100\t399\t.\t+\t0\tParent=t1\n"
            "chr1\tsrc\tCDS\t700\t999\t.\t+\t0\tParent=t1\n",
            encoding="utf-8",
        )
        required, reason = conversion_required(normalize_annotation(str(path)))
        self.assertTrue(required)
        self.assertIn("exons_from_cds", reason)

    def test_gff3_needing_a_rebuilt_model_requires_conversion(self):
        # CDS-only GFF3: the indexer would draw one exon across the introns.
        required, reason = self._required("augustus.gff3")
        self.assertTrue(required)
        self.assertIn("exons_from_cds", reason)

    def test_generating_identifiers_forces_conversion(self):
        required, reason = self._required("ensembl.gff3", id_mode="generate")
        self.assertTrue(required)
        self.assertIn("identifiers", reason)

    def test_gene_synthesis_forces_conversion(self):
        path = Path(_tmpdir(self)) / "orphan.gff3"
        path.write_text(
            "##gff-version 3\n"
            "chr1\tsrc\tmRNA\t100\t900\t.\t+\t.\tID=t1\n"
            "chr1\tsrc\texon\t100\t900\t.\t+\t.\tParent=t1\n",
            encoding="utf-8",
        )
        required, reason = conversion_required(normalize_annotation(str(path)))
        self.assertTrue(required)
        self.assertIn("gene_synthesised", reason)


class PrepareAnnotationTests(unittest.TestCase):
    def test_gtf_is_converted_beside_the_source(self):
        source = _staged(self, "tiberius.gtf")
        result = prepare_annotation(source)

        self.assertTrue(result["converted"])
        self.assertEqual(result["gene_count"], 2)
        output = Path(result["annotation_path"])
        self.assertTrue(output.is_file())
        # Converted output lands next to the file the user picked, not in a
        # shared directory or the working-directory root.
        self.assertEqual(output.parent, Path(source).parent)
        self.assertIn(".ensembl.gff3", output.name)

    def test_clean_gff3_is_returned_untouched(self):
        source = _staged(self, "ensembl.gff3")
        before = sorted(os.listdir(Path(source).parent))

        result = prepare_annotation(source)

        self.assertFalse(result["converted"])
        self.assertEqual(result["annotation_path"], source)
        self.assertEqual(sorted(os.listdir(Path(source).parent)), before)

    def test_source_file_is_left_in_place(self):
        source = _staged(self, "braker.gtf")
        result = prepare_annotation(source)
        self.assertTrue(Path(source).is_file())
        self.assertNotEqual(result["annotation_path"], source)

    def test_unwritable_directory_is_reported(self):
        directory = Path(_tmpdir(self))
        source = directory / "tiberius.gtf"
        shutil.copy2(FIXTURES / "tiberius.gtf", source)
        os.chmod(directory, 0o500)
        self.addCleanup(os.chmod, directory, 0o700)

        with self.assertRaises(ValueError) as ctx:
            prepare_annotation(str(source))
        self.assertIn("writable", str(ctx.exception))

    def test_prepared_output_indexes_with_the_existing_parser(self):
        source = _staged(self, "tiberius.gtf")
        result = prepare_annotation(source)

        db_path = str(Path(_tmpdir(self)) / "index.db")
        main.create_gff_index(result["annotation_path"], db_path)
        conn = sqlite3.connect(db_path)
        self.addCleanup(conn.close)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM genes").fetchone()[0], 2)


class PrepareEndpointTests(unittest.TestCase):
    def _await(self, task_id, timeout=20.0):
        deadline = time.time() + timeout
        payload = {}
        while time.time() < deadline:
            payload = custom_conversion_status(task_id)
            if payload.get("status") in {"success", "failed"}:
                return payload
            time.sleep(0.02)
        raise AssertionError("prepare task did not finish: {0}".format(payload))

    def test_endpoint_converts_a_gtf(self):
        source = _staged(self, "tiberius.gtf")
        started = asyncio.run(prepare_custom_annotation(
            PrepareAnnotationRequest(annotation_path=source)
        ))
        task = self._await(started["task_id"])
        self.assertEqual(task["status"], "success", task.get("error"))
        self.assertTrue(task["report"]["converted"])
        self.assertEqual(task["report"]["gene_count"], 2)

    def test_endpoint_passes_clean_gff3_through(self):
        source = _staged(self, "ensembl.gff3")
        started = asyncio.run(prepare_custom_annotation(
            PrepareAnnotationRequest(annotation_path=source)
        ))
        task = self._await(started["task_id"])
        self.assertFalse(task["report"]["converted"])
        self.assertEqual(
            Path(task["report"]["annotation_path"]).resolve(),
            Path(source).resolve(),
        )

    def test_missing_file_is_404(self):
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(prepare_custom_annotation(
                PrepareAnnotationRequest(annotation_path="/nope/missing.gtf")
            ))
        self.assertEqual(ctx.exception.status_code, 404)

    def test_bad_prefix_is_rejected(self):
        source = _staged(self, "tiberius.gtf")
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(prepare_custom_annotation(PrepareAnnotationRequest(
                annotation_path=source, id_mode="generate", id_prefix="x",
            )))
        self.assertEqual(ctx.exception.status_code, 400)


class IndexPathPlacementTests(unittest.TestCase):
    def test_index_sits_beside_the_annotation(self):
        directory = Path(_tmpdir(self))
        gff = directory / "genes.gff3"
        gff.write_text("##gff-version 3\n", encoding="utf-8")
        output_dir = _tmpdir(self)

        resolved = main._resolve_index_path(str(gff), output_dir, "genes.gff3.index.db")
        self.assertEqual(resolved.parent, directory.resolve())

    def test_index_never_lands_in_the_output_dir_root(self):
        # Regression: a custom annotation outside local_data used to drop its
        # index into the bare working directory.
        directory = Path(_tmpdir(self))
        gff = directory / "custom.gtf.gz"
        gff.write_text("x", encoding="utf-8")
        output_dir = Path(_tmpdir(self))

        resolved = main._resolve_index_path(
            str(gff), str(output_dir), "custom.gff3.index.db"
        )
        self.assertNotEqual(resolved.parent, output_dir)

    def test_unwritable_annotation_dir_uses_a_managed_folder(self):
        directory = Path(_tmpdir(self))
        gff = directory / "genes.gff3"
        gff.write_text("##gff-version 3\n", encoding="utf-8")
        os.chmod(directory, 0o500)
        self.addCleanup(os.chmod, directory, 0o700)
        output_dir = Path(_tmpdir(self))

        resolved = main._resolve_index_path(
            str(gff), str(output_dir), "genes.gff3.index.db"
        )
        self.assertEqual(resolved.parent, output_dir / "indexes")

    def test_local_data_layout_is_unchanged(self):
        output_dir = Path(_tmpdir(self))
        asm_dir = output_dir / "local_data" / "Test_species" / "GCA_000005845.2"
        asm_dir.mkdir(parents=True)
        gff = asm_dir / "GCA_000005845.2.gff3"
        gff.write_text("##gff-version 3\n", encoding="utf-8")

        resolved = main._resolve_index_path(str(gff), str(output_dir), "fallback.db")
        self.assertEqual(
            resolved.resolve(),
            (asm_dir / "GCA_000005845.2.gff3.index.db").resolve(),
        )

    def test_index_basename_strips_annotation_extensions(self):
        self.assertEqual(
            main._index_basename_for_annotation("GCA_004027535.1.gtf.gz"),
            "GCA_004027535.1.gff3.index.db",
        )
        self.assertEqual(
            main._index_basename_for_annotation("/a/b/genes.gff3.gz"),
            "genes.gff3.index.db",
        )
        self.assertEqual(
            main._index_basename_for_annotation("genes.ensembl.gff3.gz"),
            "genes.gff3.index.db",
        )
        self.assertEqual(
            main._index_basename_for_annotation("annotation.gff"),
            "annotation.gff3.index.db",
        )


if __name__ == "__main__":
    unittest.main()
