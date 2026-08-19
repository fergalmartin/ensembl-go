"""Assembly metadata must be read, not recomputed.

Two things made the assembly view slow enough to look broken. It added up every
sequence length by reading the whole FASTA — 24 seconds on a human genome, to
re-derive what the FASTA index states outright — and it looked up registry
metadata under the genome's own accession, which for a RefSeq genome is a GCF
that ENA has never heard of, so it always came back empty.
"""

import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main  # noqa: E402
from stats_utils import compute_fasta_assembly_stats  # noqa: E402


FASTA = (
    ">chr1 first\n"
    "ACGTACGTAC\n"
    "GTACGTACGT\n"
    ">chr2 second\n"
    "ACGTACGT\n"
    ">chrM\n"
    "ACGT\n"
)


class AssemblySizeSourceTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.fasta = self.root / "genome.fa"
        self.fasta.write_text(FASTA)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def _write_fai(self):
        # name, length, offset, line bases, line width — only the length is read.
        (self.root / "genome.fa.fai").write_text(
            "chr1\t20\t13\t10\t11\n"
            "chr2\t8\t48\t8\t9\n"
            "chrM\t4\t64\t4\t5\n"
        )

    def test_lengths_come_from_the_fasta_index_when_there_is_one(self):
        self._write_fai()
        with patch.object(main, "open_maybe_gz", side_effect=AssertionError("scanned the FASTA")):
            stats = compute_fasta_assembly_stats(str(self.fasta))
        self.assertEqual(stats["source"], "fasta_index")
        self.assertEqual(stats["contig_count"], 3)
        self.assertEqual(stats["total_bases"], 32)
        self.assertEqual(stats["longest_sequence"], 20)

    def test_the_assembly_report_is_used_when_there_is_no_index(self):
        report = self.root / "GCA_1.assembly_report.txt"
        report.write_text(
            "# Assembly name: Test\n"
            "# Sequence-Name\tSequence-Role\tAssigned-Molecule\tType\tGenBank\tRelationship\tRefSeq\tUnit\tSequence-Length\tUCSC\n"
            "chr1\tassembled-molecule\t1\tChromosome\tCM1\t=\tNC_1\tPrimary\t20\tchr1\n"
            "chr2\tassembled-molecule\t2\tChromosome\tCM2\t=\tNC_2\tPrimary\t8\tchr2\n"
        )
        stats = compute_fasta_assembly_stats(str(self.fasta), str(report))
        self.assertEqual(stats["source"], "assembly_report")
        self.assertEqual(stats["contig_count"], 2)
        self.assertEqual(stats["total_bases"], 28)

    def test_an_ncbi_sequence_report_is_understood_too(self):
        report = self.root / "GCF_1.sequence_report.json"
        report.write_text(
            '[{"chr_name": "1", "length": 20}, {"chr_name": "2", "length": 8}, {"chr_name": "MT", "length": 4}]'
        )
        stats = compute_fasta_assembly_stats(str(self.fasta), str(report))
        self.assertEqual(stats["source"], "assembly_report")
        self.assertEqual(stats["contig_count"], 3)
        self.assertEqual(stats["total_bases"], 32)

    def test_a_genome_with_neither_still_reports_its_sizes(self):
        stats = compute_fasta_assembly_stats(str(self.fasta))
        self.assertEqual(stats["source"], "fasta_scan")
        self.assertEqual(stats["contig_count"], 3)
        self.assertEqual(stats["total_bases"], 32)
        self.assertEqual(stats["n50"], 20)
        self.assertEqual(stats["l50"], 1)

    def test_every_source_agrees(self):
        scanned = compute_fasta_assembly_stats(str(self.fasta))
        self._write_fai()
        indexed = compute_fasta_assembly_stats(str(self.fasta))
        for key in ("contig_count", "total_bases", "longest_sequence", "n50", "l50"):
            self.assertEqual(scanned[key], indexed[key], key)


class AssemblyAccessionFallbackTests(unittest.TestCase):
    def test_a_refseq_genome_is_looked_up_under_its_equivalent_gca(self):
        species = {
            "gca": "GCF_000001405.40",
            "assembly": "GCF_000001405.40",
            "equivalent_accessions": ["GCA_000001405.29"],
            "files": {},
        }
        seen = []

        def fake_fetch(accession, _cache_path):
            seen.append(accession)
            if accession.startswith("GCA_"):
                return {"status": "ready", "data": {"accession": accession}, "source": "ena"}
            return {"status": "error", "message": "not found", "data": None, "source": "none"}

        with patch.object(main, "fetch_ena_metadata", side_effect=fake_fetch):
            result = main._fetch_assembly_metadata_for_species(species)

        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["accession"], "GCA_000001405.29")
        self.assertEqual(seen, ["GCF_000001405.40", "GCA_000001405.29"])

    def test_the_genomes_own_accession_is_tried_first(self):
        species = {
            "gca": "GCA_000001405.29",
            "assembly": "GCA_000001405.29",
            "equivalent_accessions": ["GCF_000001405.40"],
            "files": {},
        }
        with patch.object(
            main,
            "fetch_ena_metadata",
            side_effect=lambda accession, _p: {"status": "ready", "data": {"accession": accession}, "source": "ena"},
        ):
            result = main._fetch_assembly_metadata_for_species(species)
        self.assertEqual(result["data"]["accession"], "GCA_000001405.29")
        self.assertIsNone(result.get("accession"), "no note needed when its own accession resolved")

    def test_equivalents_are_recovered_from_the_download_manifest(self):
        root = Path(tempfile.mkdtemp())
        try:
            asm_dir = root / "GCF_000001405.40"
            (asm_dir / "assembly").mkdir(parents=True)
            fasta = asm_dir / "assembly" / "genome.fna"
            fasta.write_text(">chr1\nACGT\n")
            (asm_dir / "GCF_000001405.40.genome_manifest.json").write_text(
                '{"assembly": "GCF_000001405.40", "equivalent_accessions": ["GCA_000001405.29"]}'
            )
            species = {
                "gca": "GCF_000001405.40",
                "assembly": "GCF_000001405.40",
                "files": {"fasta": str(fasta)},
            }
            self.assertEqual(
                main._manifest_equivalent_accessions(species),
                ["GCA_000001405.29"],
            )
        finally:
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
