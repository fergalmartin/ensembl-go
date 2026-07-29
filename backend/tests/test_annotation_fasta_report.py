import gzip
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from annotation.fasta_report import read_sequence_lengths, scan_fasta  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "annotation"
GENOME = FIXTURES / "genome.fa"


def _write_temp(testcase, text, suffix=".fa", compress=None):
    tmp = tempfile.NamedTemporaryFile("wb", suffix=suffix, delete=False)
    payload = text.encode("utf-8")
    if compress == "gzip":
        payload = gzip.compress(payload)
    tmp.write(payload)
    tmp.close()
    testcase.addCleanup(lambda: Path(tmp.name).unlink(missing_ok=True))
    return tmp.name


class GenomeFixtureTests(unittest.TestCase):
    """The fixture is built to exact known composition; assert on the numbers.

    chr1 = 120 x ACGT-cycle upper + 60 N + 60 x acgt-cycle lower + RYSW  = 244 bp
    chr2 = 120 bp of alternating GC                                      = 120 bp
    """

    @classmethod
    def setUpClass(cls):
        cls.report = scan_fasta(str(GENOME))

    def test_sequence_counts_and_lengths(self):
        self.assertEqual(self.report.sequence_count, 2)
        self.assertEqual(self.report.total_length, 364)
        self.assertEqual(self.report.longest_length, 244)
        self.assertEqual(self.report.shortest_length, 120)
        self.assertAlmostEqual(self.report.mean_length, 182.0)
        self.assertEqual(self.report.median_length, 182)

    def test_n50_and_n90(self):
        self.assertEqual(self.report.n50, 244)
        self.assertEqual(self.report.l50, 1)
        self.assertEqual(self.report.n90, 120)
        self.assertEqual(self.report.l90, 2)

    def test_base_counts_include_ambiguity_codes(self):
        counts = self.report.base_counts
        self.assertEqual(counts["A"], 45)
        self.assertEqual(counts["C"], 105)
        self.assertEqual(counts["G"], 105)
        self.assertEqual(counts["T"], 45)
        self.assertEqual(counts["N"], 60)
        for code in ("R", "Y", "S", "W"):
            self.assertEqual(counts[code], 1)
        self.assertEqual(sum(counts.values()), 364)

    def test_no_invalid_characters(self):
        self.assertEqual(self.report.invalid_counts, {})

    def test_gc_and_n_percentages(self):
        # GC is computed over unambiguous bases only: 210 / 300.
        self.assertAlmostEqual(self.report.gc_percent, 70.0)
        self.assertAlmostEqual(self.report.n_percent, 60 / 364 * 100.0)
        self.assertAlmostEqual(self.report.ambiguity_percent, 4 / 364 * 100.0)

    def test_softmasked_bases_counted(self):
        self.assertEqual(self.report.softmasked_bases, 60)
        self.assertAlmostEqual(self.report.softmasked_percent, 60 / 364 * 100.0)

    def test_sequence_names_and_descriptions(self):
        names = [s.name for s in self.report.longest_sequences]
        self.assertEqual(names, ["chr1", "chr2"])
        # chr1 has a trailing description after the name.
        self.assertEqual(self.report.names_with_whitespace, 1)

    def test_clean_file_has_no_errors(self):
        severities = {issue.severity for issue in self.report.issues}
        self.assertNotIn("error", severities)

    def test_report_serialises(self):
        payload = self.report.as_dict()
        self.assertEqual(payload["sequence_count"], 2)
        self.assertEqual(payload["base_counts"]["N"], 60)
        self.assertIsInstance(payload["issues"], list)


class FastaProblemTests(unittest.TestCase):
    def test_duplicate_sequence_names_are_errors(self):
        path = _write_temp(self, ">chr1\nACGT\n>chr1\nACGT\n")
        report = scan_fasta(path)
        self.assertIn("chr1", report.duplicate_names)
        codes = {i.code: i.severity for i in report.issues}
        self.assertEqual(codes.get("duplicate_sequence_name"), "error")
        self.assertFalse(report.fai_creatable)

    def test_inconsistent_line_length_blocks_faidx(self):
        # Only the final line of a record may be shorter than the others.
        path = _write_temp(self, ">chr1\nACGTACGTAC\nACGT\nACGTACGTAC\n")
        report = scan_fasta(path)
        codes = {i.code for i in report.issues}
        self.assertIn("inconsistent_line_length", codes)
        self.assertFalse(report.fai_creatable)

    def test_uniform_lines_with_short_tail_are_accepted(self):
        path = _write_temp(self, ">chr1\nACGTACGTAC\nACGTACGTAC\nACG\n")
        report = scan_fasta(path)
        codes = {i.code for i in report.issues}
        self.assertNotIn("inconsistent_line_length", codes)
        self.assertTrue(report.fai_creatable)

    def test_invalid_characters_are_reported(self):
        path = _write_temp(self, ">chr1\nACGT!!ZZ\n")
        report = scan_fasta(path)
        self.assertIn("!", report.invalid_counts)
        self.assertIn("Z", report.invalid_counts)
        codes = {i.code for i in report.issues}
        self.assertIn("invalid_base_characters", codes)

    def test_empty_sequence_is_reported(self):
        path = _write_temp(self, ">chr1\n>chr2\nACGT\n")
        report = scan_fasta(path)
        self.assertEqual(report.empty_sequences, 1)

    def test_all_n_sequence_is_counted(self):
        path = _write_temp(self, ">chr1\nNNNNNNNN\n>chr2\nACGTACGT\n")
        report = scan_fasta(path)
        self.assertEqual(report.all_n_sequences, 1)

    def test_no_records_reports_error(self):
        path = _write_temp(self, "\n")
        report = scan_fasta(path)
        codes = {i.code for i in report.issues}
        self.assertIn("no_sequences", codes)

    def test_plain_gzip_is_flagged_as_unusable(self):
        path = _write_temp(self, ">chr1\nACGTACGT\n", suffix=".fa.gz", compress="gzip")
        report = scan_fasta(path)
        self.assertEqual(report.compression, "gzip")
        self.assertFalse(report.usable_by_pysam)
        self.assertTrue(report.decompression_required)
        codes = {i.code for i in report.issues}
        self.assertIn("plain_gzip_fasta", codes)

    def test_gzip_content_is_still_counted(self):
        path = _write_temp(self, ">chr1\nACGTACGT\n", suffix=".fa.gz", compress="gzip")
        report = scan_fasta(path)
        self.assertEqual(report.sequence_count, 1)
        self.assertEqual(report.total_length, 8)


class SequenceLengthTests(unittest.TestCase):
    def test_read_sequence_lengths_streams_when_no_fai(self):
        lengths = read_sequence_lengths(str(GENOME))
        self.assertEqual(lengths, {"chr1": 244, "chr2": 120})

    def test_read_sequence_lengths_prefers_fai(self):
        path = _write_temp(self, ">chr1\nACGTACGT\n")
        Path(path + ".fai").write_text("chr1\t999\t7\t8\t9\n", encoding="utf-8")
        self.addCleanup(lambda: Path(path + ".fai").unlink(missing_ok=True))
        # The .fai is authoritative; a mismatch means the index is stale, which
        # is the caller's problem to surface, not something to silently re-derive.
        self.assertEqual(read_sequence_lengths(path), {"chr1": 999})

    def test_names_are_truncated_at_first_whitespace(self):
        path = _write_temp(self, ">chr1 some description here\nACGTACGT\n")
        self.assertEqual(read_sequence_lengths(path), {"chr1": 8})


if __name__ == "__main__":
    unittest.main()
