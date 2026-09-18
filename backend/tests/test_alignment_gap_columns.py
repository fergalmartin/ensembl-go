import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from alignment_explorer.store import AlignmentStore, stable_id
from alignment_explorer.gaps import (intersect, merge_adjacent, fill_uncovered, runs_of_gap,
                                     gap_tally, tally_gaps, runs_at_least, rows_needed)

# Columns          0123456789012345
# human            ACGT------ACGTAC
# mouse            ACGT------AC----
# rat              ----------ACGTAC
# Columns 4-10 are gap in all three. Columns 12-16 are gap in mouse alone, and
# 0-4 in rat alone, so neither is common to the whole set - but each becomes
# common once the sequence that fills it is out of the cohort.
MAF = '''##maf version=1

a score=1
s human.chr1 10 10 + 1000 ACGT------ACGTAC
s mouse.chr1 20  6 + 1000 ACGT------AC----
s rat.chr1   30  6 + 1000 ----------ACGTAC
'''


class GapColumnTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.store = AlignmentStore(root / 'index')
        self.store.initialize()
        path = root / 'input.maf'
        path.write_text(MAF)
        self.store.import_file(path, 'maf')
        self.ids = {name: stable_id(f'{name}.chr1') for name in ('human', 'mouse', 'rat')}

    def tearDown(self):
        self.temp.cleanup()

    def columns(self, names, **kw):
        return self.store.gap_columns(1, 0, None, [self.ids[n] for n in names], **kw)

    def test_whole_cohort_keeps_only_the_shared_gap(self):
        self.assertEqual(self.columns(('human', 'mouse', 'rat'))['runs'], [[4, 10]])

    def test_hiding_a_sequence_can_empty_further_columns(self):
        # Without human and rat, mouse's own tail is uninformative too.
        self.assertEqual(self.columns(('mouse',))['runs'], [[4, 10], [12, 16]])
        # And without rat, the head it alone lacks is still filled by the others.
        self.assertEqual(self.columns(('human', 'mouse'))['runs'], [[4, 10]])
        # rat has bases at 12-16, so joining it to mouse fills that tail again.
        self.assertEqual(self.columns(('mouse', 'rat'))['runs'], [[4, 10]])
        # rat alone is a gap through its whole head.
        self.assertEqual(self.columns(('rat',))['runs'], [[0, 10]])

    def test_showing_a_sequence_again_puts_the_columns_back(self):
        narrow = self.columns(('rat',))['runs']
        wide = self.columns(('rat', 'human'))['runs']
        self.assertEqual(narrow, [[0, 10]])
        self.assertEqual(wide, [[4, 10]])

    def test_min_run_is_applied_to_the_intersection_not_to_each_row(self):
        # 4-10 is six columns; asking for seven leaves nothing, and asking for
        # six keeps it whole.
        self.assertEqual(self.columns(('human', 'mouse', 'rat'), min_run=6)['runs'], [[4, 10]])
        self.assertEqual(self.columns(('human', 'mouse', 'rat'), min_run=7)['runs'], [])

    def test_a_window_answers_about_its_own_columns(self):
        result = self.store.gap_columns(1, 6, 12, [self.ids[n] for n in ('human', 'mouse', 'rat')])
        self.assertEqual(result['runs'], [[6, 10]])

    def test_a_window_answers_about_its_own_columns_at_a_threshold_too(self):
        # The tally covers the window, not the block, so its answers have to come
        # back in the block's own columns: an answer in offsets into the window
        # would hide a stretch several columns to the left of the one asked about.
        ids = [self.ids[n] for n in ('human', 'mouse', 'rat')]
        self.assertEqual(self.store.gap_columns(1, 6, 16, ids, percent=33)['runs'], [[6, 10], [12, 16]])
        self.assertEqual(self.store.gap_columns(1, 6, 16, ids, percent=50)['runs'], [[6, 10]])

    def test_rows_the_block_does_not_hold_are_not_counted_as_gap(self):
        result = self.store.gap_columns(1, 0, None, [self.ids['human'], 'no-such-sequence'])
        self.assertEqual(result['present'], 1)
        self.assertEqual(result['cohort'], 2)
        self.assertEqual(result['runs'], [[4, 10]])

    def test_an_empty_cohort_collapses_nothing(self):
        result = self.store.gap_columns(1, 0, None, [])
        self.assertEqual(result['runs'], [])
        self.assertEqual(result['cohort'], 0)

    def test_a_threshold_hides_columns_enough_of_the_cohort_is_a_gap_in(self):
        # Gaps per column across the three: 0-4 is rat alone, 4-10 is all three,
        # 10-12 is nobody, 12-16 is mouse alone.
        names = ('human', 'mouse', 'rat')
        # Two rows of three, so only the stretch they all share crosses. Half of
        # three rows is two, because a threshold is met in whole sequences and
        # one and a half of them is not a thing a column can be.
        self.assertEqual(self.columns(names, percent=50)['runs'], [[4, 10]])
        self.assertEqual(self.columns(names, percent=67)['runs'], [[4, 10]])
        # One row of three, so a column any single sequence is a gap in counts:
        # rat's head and mouse's tail join the answer, and the head runs into
        # the shared stretch as one run rather than two.
        self.assertEqual(self.columns(names, percent=33)['runs'], [[0, 10], [12, 16]])
        # Bases are being hidden now, which is the whole difference between this
        # and the all-gap answer: 0-4 holds human's and mouse's ACGT.
        self.assertEqual(self.columns(names, percent=100)['runs'], [[4, 10]])

    def test_the_top_of_the_range_is_exactly_the_all_gap_answer(self):
        # The two paths through the store - the fold of intersections and the
        # sweep - have to agree where they meet, or a reader dragging a slider
        # to 100 would see a different sheet from the one the switch gives.
        for names in (('human',), ('mouse', 'rat'), ('human', 'mouse', 'rat')):
            self.assertEqual(self.columns(names, percent=100)['runs'], self.columns(names)['runs'])

    def test_a_threshold_says_how_many_rows_it_asked_for(self):
        result = self.columns(('human', 'mouse', 'rat'), percent=50)
        self.assertEqual((result['present'], result['percent'], result['needed']), (3, 50, 2))
        # Rows the block does not hold are out of the denominator, so a cohort
        # padded with absent sequences asks the same question of the same rows.
        padded = self.store.gap_columns(1, 0, None,
            [self.ids[n] for n in ('human', 'mouse', 'rat')] + ['no-such-sequence'], percent=50)
        self.assertEqual(padded['needed'], 2)
        self.assertEqual(padded['runs'], result['runs'])

    def test_the_row_count_survives_the_early_exit(self):
        # The all-gap fold stops the moment the intersection empties, which is
        # most of the work saved on a sheet with nothing closable in it. What it
        # must not do is report having looked at one row: how many rows the block
        # holds is part of the answer, and a threshold is a share of it.
        # rat's head and mouse's tail leave nothing shared by all three once a
        # window covering only 12-16 is asked about.
        result = self.store.gap_columns(1, 12, 16, [self.ids[n] for n in ('human', 'mouse', 'rat')])
        self.assertEqual(result['runs'], [])
        self.assertEqual(result['present'], 3)
        self.assertEqual(result['needed'], 3)

    def test_the_shortest_run_still_applies_after_a_threshold(self):
        # At one row of three the answer is 0-10 and 12-16; only the first is
        # five columns or more.
        self.assertEqual(self.columns(('human', 'mouse', 'rat'), percent=33, min_run=5)['runs'], [[0, 10]])

    def test_the_tally_counts_overlapping_runs(self):
        tally = gap_tally(12)
        for row in ([(0, 5)], [(3, 9)], [(4, 6)]):
            tally_gaps(tally, row, 0)
        self.assertEqual(runs_at_least(tally, 3, 0), [[4, 5]])
        self.assertEqual(runs_at_least(tally, 2, 0), [[3, 6]])
        # Stretches that meet are one run: the count never falls below the
        # threshold between them, so there is nothing there to tell a reader.
        self.assertEqual(runs_at_least(tally, 1, 0), [[0, 9]])
        # One row's own runs meeting end to end are one run too, and two rows
        # are still one row at any column of it.
        touching = gap_tally(10)
        tally_gaps(touching, [(100, 105), (105, 110)], 100)
        self.assertEqual(runs_at_least(touching, 1, 100), [[100, 110]])
        self.assertEqual(runs_at_least(touching, 2, 100), [])
        # A window answers in the window's own columns, not in offsets into it.
        self.assertEqual(runs_at_least(gap_tally(4), 1, 60), [])

    def test_rows_needed_rounds_up_and_meets_the_intersection_at_the_top(self):
        self.assertEqual(rows_needed(5, 100), 5)
        self.assertEqual(rows_needed(5, 50), 3)
        self.assertEqual(rows_needed(4, 50), 2)
        self.assertEqual(rows_needed(3, 1), 1)
        self.assertEqual(rows_needed(0, 50), 0)

    def test_range_algebra(self):
        self.assertEqual(intersect([(0, 10)], [(4, 6), (8, 20)]), [(4, 6), (8, 10)])
        self.assertEqual(intersect([(0, 4)], [(4, 8)]), [])
        self.assertEqual(merge_adjacent([(4, 6), (6, 9), (1, 2)]), [(1, 2), (4, 9)])
        self.assertEqual(runs_of_gap('A--CG-', 10), [(11, 13), (15, 16)])
        # A row whose bases stop early has no base in the columns after them.
        self.assertEqual(fill_uncovered([(2, 4)], [(0, 6)], 0, 10), [(2, 4), (6, 10)])


if __name__ == '__main__':
    unittest.main()
