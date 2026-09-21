import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sequence_view.find import (  # noqa: E402
    Pattern,
    compile_pattern,
    matches_in_region,
    scan_offsets,
)

_COMPLEMENT = str.maketrans("ACGTN", "TGCAN")


def revcomp(text: str) -> str:
    return text.translate(_COMPLEMENT)[::-1]


def pattern(pattern_id: str, text: str, kind: str = "literal") -> Pattern:
    return Pattern(pattern_id, compile_pattern(text, kind))


def reader(text: str):
    """A region as a string, read the way the scan reads a chromosome."""
    return lambda at, stop: text[at:stop]


def fetcher(text: str):
    """A FASTA-shaped reader: 0-based half-open over the forward strand."""
    return lambda begin, stop: text[begin:stop]


class ScanOffsetsTest(unittest.TestCase):
    def test_a_literal_is_found_everywhere_it_occurs(self):
        found, total, truncated, counts = scan_offsets(
            reader("ATGCCATGCC"), 10, [pattern("a", "ATG")],
        )
        self.assertEqual([(0, 3, "a"), (5, 8, "a")], found)
        self.assertEqual(2, total)
        self.assertFalse(truncated)
        self.assertEqual({"a": 2}, counts)

    def test_case_is_not_part_of_the_question(self):
        # Soft-masked repeats are written in lower case, and a reader looking
        # for ATG means the bases rather than the typography.
        found, total, _, _ = scan_offsets(
            reader("atgCCATG"), 8, [pattern("a", "ATG")],
        )
        self.assertEqual([(0, 3, "a"), (5, 8, "a")], found)
        self.assertEqual(2, total)

    def test_a_literal_is_not_read_as_a_pattern(self):
        # `.` and `[` are IUPAC characters as well as regex syntax, and a reader
        # who chose "String" has said which they meant.
        found, _, _, _ = scan_offsets(
            reader("A.GATGA"), 7, [pattern("a", "A.G")],
        )
        self.assertEqual([(0, 3, "a")], found, "the literal dot, not any base")

    def test_a_regex_is(self):
        found, _, _, _ = scan_offsets(
            reader("AAGATGACG"), 9, [pattern("a", "A[CT]G", kind="regex")],
        )
        self.assertEqual([(3, 6, "a"), (6, 9, "a")], found)

    def test_matches_do_not_overlap_each_other(self):
        # `AA` in `AAAA` is two matches, not three: the scan resumes where the
        # last one ended, which is what every find box does.
        found, total, _, _ = scan_offsets(reader("AAAA"), 4, [pattern("a", "AA")])
        self.assertEqual([(0, 2, "a"), (2, 4, "a")], found)
        self.assertEqual(2, total)

    def test_a_pattern_that_can_match_nothing_terminates(self):
        # `A*` matches the empty string at every position for ever unless the
        # scan is moved on by hand.
        found, total, _, _ = scan_offsets(
            reader("CCAACC"), 6, [pattern("a", "A*", kind="regex")],
        )
        self.assertEqual([(2, 4, "a")], found)
        self.assertEqual(1, total)

    def test_two_patterns_are_counted_apart_and_reported_together(self):
        found, total, _, counts = scan_offsets(
            reader("ATGCCCTAG"), 9, [pattern("a", "ATG"), pattern("b", "TAG")],
        )
        self.assertEqual([(0, 3, "a"), (6, 9, "b")], found)
        self.assertEqual(2, total)
        self.assertEqual({"a": 1, "b": 1}, counts)

    def test_the_list_is_in_reading_order_whatever_order_it_was_gathered_in(self):
        # Gathered a pattern at a time, so without the sort the answer comes
        # back grouped by pattern and a reader stepping through it jumps about.
        found, _, _, _ = scan_offsets(
            reader("TAGCCCATG"), 9, [pattern("a", "ATG"), pattern("b", "TAG")],
        )
        self.assertEqual([0, 6], [item[0] for item in found])

    # -- the seam ------------------------------------------------------
    #
    # The whole of the difficulty. Tested at sizes small enough to see rather
    # than at the megabases it ships with.

    def test_a_match_across_a_block_boundary_is_found(self):
        # Block one is [0,10), block two [8,18): the ATG at 9 is cut in half by
        # the first and whole in the second.
        text = "CCCCCCCCCATGCCCCCC"
        found, total, _, _ = scan_offsets(
            reader(text), len(text), [pattern("a", "ATG")], scan_bp=10, overlap_bp=2,
        )
        self.assertEqual([(9, 12, "a")], found)
        self.assertEqual(1, total)

    def test_a_match_inside_an_overlap_is_found_once_and_not_twice(self):
        # The ATG at 8 lies inside both blocks. The first block sees it and
        # declines it -- it begins in the second block's share -- so exactly one
        # of them reports it.
        text = "CCCCCCCCATGCCCCCCC"
        found, total, _, counts = scan_offsets(
            reader(text), len(text), [pattern("a", "ATG")], scan_bp=10, overlap_bp=2,
        )
        self.assertEqual([(8, 11, "a")], found)
        self.assertEqual(1, total, "counted once, not once per block that saw it")
        self.assertEqual({"a": 1}, counts)

    def test_every_match_in_a_region_of_many_blocks_is_found_exactly_once(self):
        # A hundred ATGs at known places, walked in blocks of nine with an
        # overlap of three, so almost every one of them lands in some overlap.
        text = list("C" * 1000)
        places = list(range(0, 960, 17))
        for at in places:
            text[at:at + 3] = "ATG"
        body = "".join(text)
        found, total, _, _ = scan_offsets(
            reader(body), len(body), [pattern("a", "ATG")], scan_bp=9, overlap_bp=3,
        )
        self.assertEqual(places, [item[0] for item in found])
        self.assertEqual(len(places), total)

    def test_the_seam_holds_for_a_region_that_ends_on_a_block_boundary(self):
        text = "ATGCCCATGC"
        found, total, _, _ = scan_offsets(
            reader(text), len(text), [pattern("a", "ATG")], scan_bp=5, overlap_bp=2,
        )
        self.assertEqual([(0, 3, "a"), (6, 9, "a")], found)
        self.assertEqual(2, total)

    # -- the limit -----------------------------------------------------

    def test_past_the_limit_the_count_is_still_exact(self):
        text = "ATG" * 50
        found, total, truncated, counts = scan_offsets(
            reader(text), len(text), [pattern("a", "ATG")], limit=10,
        )
        self.assertEqual(10, len(found), "the positions are a list, and lists end")
        self.assertEqual(50, total, "the count is what the scan saw, all of it")
        self.assertTrue(truncated)
        self.assertEqual({"a": 50}, counts)

    def test_nothing_to_look_for_is_no_work_and_no_matches(self):
        found, total, truncated, counts = scan_offsets(reader("ATG"), 3, [])
        self.assertEqual([], found)
        self.assertEqual(0, total)
        self.assertFalse(truncated)
        self.assertEqual({}, counts)

    def test_an_empty_region_is_answered_rather_than_scanned(self):
        found, total, _, _ = scan_offsets(reader(""), 0, [pattern("a", "ATG")])
        self.assertEqual([], found)
        self.assertEqual(0, total)


class MatchesInRegionTest(unittest.TestCase):
    #    1234567890
    GENOME = "CCATGCCTAG"

    def test_offsets_become_genomic_coordinates(self):
        result = matches_in_region(
            fetcher(self.GENOME), 1, 10, [pattern("a", "ATG")],
        )
        # ATG is at offset 2, which is base 3, and it is three bases long.
        self.assertEqual([[3, 5, "a"]], result.matches)
        self.assertEqual(1, result.total)

    def test_a_region_that_is_part_of_the_chromosome_counts_from_its_own_start(self):
        result = matches_in_region(
            fetcher(self.GENOME), 3, 10, [pattern("a", "ATG")],
        )
        self.assertEqual([[3, 5, "a"]], result.matches, "the same base, named the same")

    def test_reversed_the_search_is_on_what_the_reader_can_see(self):
        # Displayed, the region reads CTAGGCATGG. A reader looking for ATG
        # means the one they can see, at display offset 6 -- which is bases 2-4
        # on the forward strand, counted back from the far end.
        self.assertEqual("CTAGGCATGG", revcomp(self.GENOME))
        result = matches_in_region(
            fetcher(self.GENOME), 1, 10, [pattern("a", "ATG")],
            reverse=True, complement=revcomp,
        )
        self.assertEqual([[2, 4, "a"]], result.matches)
        self.assertEqual(1, result.total)

    def test_reversed_matches_still_come_back_in_ascending_coordinates(self):
        # Ascending along the display is descending along the chromosome, so
        # without the second sort a reader stepping through them walks backwards.
        result = matches_in_region(
            fetcher("ATGCCCATGCCCATG"), 1, 15, [pattern("a", "CAT", )],
            reverse=True, complement=revcomp,
        )
        starts = [item[0] for item in result.matches]
        self.assertEqual(sorted(starts), starts)
        self.assertEqual(3, result.total)

    def test_which_strand_is_being_read_decides_what_is_there_to_find(self):
        # GGCA is in the reverse reading and nowhere in the forward one, so the
        # same region answers differently depending on which way it is turned.
        forward = matches_in_region(fetcher(self.GENOME), 1, 10, [pattern("a", "GGCA")])
        backward = matches_in_region(
            fetcher(self.GENOME), 1, 10, [pattern("a", "GGCA")],
            reverse=True, complement=revcomp,
        )
        self.assertEqual(0, forward.total, "GGCA is not on the forward strand here")
        self.assertEqual(1, backward.total, "but it is what the reverse reads")
        self.assertEqual([[4, 7, "a"]], backward.matches)

    def test_an_inverted_region_is_no_region(self):
        result = matches_in_region(fetcher(self.GENOME), 10, 1, [pattern("a", "A")])
        self.assertEqual([], result.matches)
        self.assertEqual(0, result.total)


if __name__ == "__main__":
    unittest.main()
