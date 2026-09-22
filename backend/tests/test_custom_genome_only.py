import asyncio
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException  # noqa: E402

import main  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "annotation"


class FastaOnlyAssemblyTests(unittest.TestCase):
    """A genome with no annotation must still reach the Genome Selector."""

    def _assembly_root(self, with_gff=False):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        asm_dir = root / "local_data" / "Test_species" / "GCA_000005845.2"
        asm_dir.mkdir(parents=True)
        (asm_dir / "GCA_000005845.2.fa").write_text(
            ">chr1\nACGTACGTAC\n", encoding="utf-8"
        )
        if with_gff:
            (asm_dir / "GCA_000005845.2.gff3").write_text(
                "##gff-version 3\n"
                "chr1\tsrc\tgene\t1\t9\t.\t+\t.\tID=g1\n",
                encoding="utf-8",
            )
        return root

    def test_fasta_only_assembly_is_listed(self):
        root = self._assembly_root(with_gff=False)
        items = main.list_local_assemblies(str(root))
        item = next(
            (entry for entry in items if entry["assembly"] == "GCA_000005845.2"), None
        )
        self.assertIsNotNone(item, "fasta-only assembly was filtered out")
        self.assertIn("fasta", item["types"])
        self.assertFalse(item["has_annotation"])

    def test_annotated_assembly_reports_has_annotation(self):
        root = self._assembly_root(with_gff=True)
        items = main.list_local_assemblies(str(root))
        item = next(
            (entry for entry in items if entry["assembly"] == "GCA_000005845.2"), None
        )
        self.assertIsNotNone(item)
        self.assertTrue(item["has_annotation"])

    def test_assembly_with_neither_file_is_still_skipped(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        asm_dir = root / "local_data" / "Test_species" / "GCA_000005845.2"
        asm_dir.mkdir(parents=True)
        (asm_dir / "notes.txt").write_text("nothing useful", encoding="utf-8")

        items = main.list_local_assemblies(str(root))
        self.assertEqual(
            [e for e in items if e["assembly"] == "GCA_000005845.2"], []
        )


class OptionalIndexResolutionTests(unittest.TestCase):
    def test_missing_index_returns_empty_string(self):
        def _raise_404(_genome):
            raise HTTPException(status_code=404, detail="Index not found")

        with patch.object(main, "_get_browse_db", _raise_404):
            self.assertEqual(main._get_browse_db_optional("reference"), "")

    def test_non_404_errors_still_propagate(self):
        def _raise_500(_genome):
            raise HTTPException(status_code=500, detail="broken index")

        with patch.object(main, "_get_browse_db", _raise_500):
            with self.assertRaises(HTTPException) as ctx:
                main._get_browse_db_optional("reference")
            self.assertEqual(ctx.exception.status_code, 500)

    def test_existing_index_is_passed_through(self):
        with patch.object(main, "_get_browse_db", lambda _g: "/path/to.db"):
            self.assertEqual(main._get_browse_db_optional("reference"), "/path/to.db")


class GenomeOnlyBrowsingTests(unittest.TestCase):
    def test_genes_endpoint_returns_empty_without_an_annotation(self):
        with patch.object(main, "_get_browse_db_optional", lambda _g: ""):
            result = asyncio.run(main.browse_genes(genome="reference", chrom="chr1"))
        self.assertEqual(result, [])

    def test_genes_endpoint_still_requires_a_chrom(self):
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(main.browse_genes(genome="reference", chrom=""))
        self.assertEqual(ctx.exception.status_code, 400)

    def test_regions_come_from_the_fasta_alone(self):
        class _FakeFasta:
            references = ("chr1", "chr2")

            def get_reference_length(self, name):
                return {"chr1": 244, "chr2": 120}[name]

        with patch.object(main, "_get_browse_db_for_regions", lambda _g: ("", False)), \
                patch.object(main, "_get_browse_fasta", lambda _g: _FakeFasta()), \
                patch.object(main, "_build_genome_synonym_index", lambda _g, _r: {}), \
                patch.object(main, "_get_genome_metadata_path", lambda _g: ""):
            regions = asyncio.run(main.browse_regions(genome="reference"))

        by_name = {r.chrom: r for r in regions}
        self.assertEqual(set(by_name), {"chr1", "chr2"})
        self.assertEqual(by_name["chr1"].end, 244)
        # No annotation means no gene counts, not a failure.
        self.assertEqual(by_name["chr1"].gene_count, 0)

    def test_regions_404_when_neither_annotation_nor_fasta_exists(self):
        def _no_fasta(_genome):
            raise HTTPException(status_code=404, detail="FASTA not configured")

        with patch.object(main, "_get_browse_db_for_regions", lambda _g: ("", False)), \
                patch.object(main, "_get_browse_fasta", _no_fasta):
            with self.assertRaises(HTTPException) as ctx:
                asyncio.run(main.browse_regions(genome="reference"))
        self.assertEqual(ctx.exception.status_code, 404)

    def test_regions_keep_the_caller_polling_when_an_index_is_the_only_hope(self):
        # A genome with no FASTA has nothing to draw until its index lands, so
        # here — and only here — the region list still says "not yet" rather
        # than reporting a genome with nothing in it.
        def _no_fasta(_genome):
            raise HTTPException(status_code=404, detail="FASTA not configured")

        with patch.object(main, "_get_browse_db_for_regions", lambda _g: ("", True)), \
                patch.object(main, "_get_browse_fasta", _no_fasta):
            with self.assertRaises(HTTPException) as ctx:
                asyncio.run(main.browse_regions(genome="reference"))
        self.assertEqual(ctx.exception.status_code, main.INDEX_BUILDING_STATUS)

    def test_an_assembly_is_browsable_while_its_genes_are_still_indexing(self):
        # The whole point of the change: regions come from the FASTA, which is
        # ready immediately, so the panel opens instead of waiting out a build
        # that takes minutes. Only the gene counts are outstanding.
        class _FakeFasta:
            references = ("chr1",)

            def get_reference_length(self, name):
                return 1000

        with patch.object(main, "_get_browse_db_for_regions", lambda _g: ("", True)), \
                patch.object(main, "_get_browse_fasta", lambda _g: _FakeFasta()), \
                patch.object(main, "_build_genome_synonym_index", lambda _g, _r: {}), \
                patch.object(main, "_get_genome_metadata_path", lambda _g: ""):
            regions = asyncio.run(main.browse_regions(genome="reference"))

        self.assertEqual([r.chrom for r in regions], ["chr1"])
        self.assertEqual(regions[0].end, 1000)
        self.assertEqual(regions[0].gene_count, 0)


if __name__ == "__main__":
    unittest.main()
