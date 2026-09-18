import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sequence_view.windows import (  # noqa: E402
    apply_flank,
    clip_to_chromosome,
    fasta_header,
    soft_mask_runs,
    wrap_sequence,
)


class FlankTest(unittest.TestCase):
    def test_a_flank_is_added_to_both_ends(self):
        self.assertEqual(apply_flank(100, 200, 50), (50, 250))
        self.assertEqual(apply_flank(100, 200, 0), (100, 200))

    def test_a_flank_never_runs_off_the_start_of_a_contig(self):
        # A gene near the start of a chromosome with 100 bp of flank is ordinary,
        # not malformed, so this trims rather than refusing.
        self.assertEqual(apply_flank(10, 20, 50), (1, 70))

    def test_a_flank_never_runs_off_the_end_either(self):
        self.assertEqual(apply_flank(100, 200, 50, chrom_length=180), (50, 180))

    def test_a_window_entirely_off_the_contig_is_nothing(self):
        self.assertIsNone(clip_to_chromosome(500, 600, chrom_length=100))

    def test_coordinates_given_the_wrong_way_round_are_ordered(self):
        self.assertEqual(apply_flank(200, 100, 10), (90, 210))

    def test_a_single_base_survives(self):
        self.assertEqual(apply_flank(7, 7, 0), (7, 7))


class SoftMaskTest(unittest.TestCase):
    def test_lower_case_stretches_come_back_as_coordinate_runs(self):
        self.assertEqual(
            soft_mask_runs("ACGTaacgGGTTccc", 101),
            [{"s": 105, "e": 108}, {"s": 113, "e": 115}],
        )

    def test_a_run_reaching_the_end_is_closed(self):
        self.assertEqual(soft_mask_runs("ACgt", 1), [{"s": 3, "e": 4}])

    def test_a_fully_masked_or_fully_unmasked_read(self):
        self.assertEqual(soft_mask_runs("acgt", 10), [{"s": 10, "e": 13}])
        self.assertEqual(soft_mask_runs("ACGT", 10), [])
        self.assertEqual(soft_mask_runs("", 10), [])


class FastaTest(unittest.TestCase):
    def test_a_header_round_trips_into_the_search_box(self):
        # Same shape the location drawer writes, so the two are not told apart.
        self.assertEqual(fasta_header("17", 43044295, 43170245, "-", "GRCh38"),
                         ">17:43044295-43170245 strand:- genome:GRCh38")
        self.assertEqual(fasta_header("1", 1, 10), ">1:1-10 strand:+")

    def test_the_body_is_wrapped_at_sixty(self):
        wrapped = wrap_sequence("A" * 130)
        self.assertEqual([len(line) for line in wrapped.split("\n")], [60, 60, 10])


if __name__ == "__main__":
    unittest.main()
