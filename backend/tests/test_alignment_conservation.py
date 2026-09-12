import random
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from alignment_explorer.store import AlignmentStore, stable_id, CHUNK
from alignment_explorer import summary_cache
from alignment_explorer.summary_cache import cohort_hash, cohort_counts


def brute(sequences, start, end, step):
    """Independent column tally, deliberately written the slow obvious way."""
    fields = {name: [] for name in ('majority', 'canonical', 'comparable', 'occupied', 'columns')}
    for a in range(start, end, step):
        z = min(end, a + step)
        m = c = k = o = 0
        for i in range(a, z):
            column = [s[i] for s in sequences if i < len(s)]
            acgt = [column.count(base) for base in 'ACGT']
            o += sum(1 for ch in column if ch != '-')
            if sum(acgt) >= 2: m += max(acgt); c += sum(acgt); k += 1
        for name, value in zip(fields, (m, c, k, o, z - a)): fields[name].append(value)
    return fields


class ConservationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = AlignmentStore(Path(self.temp.name))
        self.store.initialize()
        rng = random.Random(7)
        self.sequences = [''.join(rng.choices('ACGTNRY-?', k=CHUNK + 199)) for _ in range(3)]
        self.store.add_block([{'source': str(i), 'sequence': seq} for i, seq in enumerate(self.sequences)]
                             + [{'source': 'absent', 'sequence': None, 'empty_status': 'C'}])
        self.ids = [stable_id(str(i)) for i in range(3)]

    def tearDown(self): self.temp.cleanup()

    def test_bins_and_chunk_edges_match_a_brute_force_column_tally(self):
        for start, end, bins in [(0, CHUNK + 199, 128), (13, CHUNK + 77, 777), (CHUNK - 37, CHUNK + 65, 16), (15, 53, 38)]:
            data = self.store.conservation(1, start, end, self.ids, bins=bins)
            expected = brute(self.sequences, start, end, data['bin_size'])
            self.assertEqual(data['bins'], expected, f'{start}-{end} in {bins} bins')

    def test_per_column_resolution_is_exact(self):
        data = self.store.conservation(1, 100, 1124, self.ids, bins=1024)
        self.assertEqual(data['bin_size'], 1)
        self.assertEqual(data['bins'], brute(self.sequences, 100, 1124, 1))

    def test_identity_is_a_ratio_of_sums_not_a_mean_of_ratios(self):
        # Two bins whose weighted identity differs from the average of their fractions.
        store = AlignmentStore(Path(tempfile.mkdtemp()))
        store.initialize()
        store.add_block([{'source': 'x', 'sequence': 'AAAAAA--'}, {'source': 'y', 'sequence': 'AAAATT--'}])
        data = store.conservation(1, 0, 8, [stable_id('x'), stable_id('y')], bins=2)
        self.assertEqual(data['bin_size'], 4)
        # Bin 0: four columns, both rows agree -> 8/8 identity. Bin 1: two columns
        # where the rows disagree -> 2/4, and two all-gap columns that enter
        # neither side of it. Averaging the two bins' fractions would give .75;
        # the ratio of sums gives 10/12, and the ratio of sums is the true one.
        self.assertEqual(data['bins']['majority'], [8, 2])
        self.assertEqual(data['bins']['canonical'], [8, 4])
        self.assertEqual(data['bins']['comparable'], [4, 2])
        self.assertEqual(data['bins']['occupied'], [8, 4])
        self.assertEqual(data['bins']['columns'], [4, 4])
        total = sum(data['bins']['majority']) / sum(data['bins']['canonical'])
        self.assertAlmostEqual(total, 10 / 12)
        self.assertNotAlmostEqual(total, (8 / 8 + 2 / 4) / 2)

    def test_cohort_is_the_denominator_not_the_blocks_membership(self):
        data = self.store.conservation(1, 0, 256, self.ids, bins=16)
        # The same block, the same columns, asked about a cohort twice the size:
        # every count is identical, and only the echoed cohort changes. The client
        # divides by that, so representation halves while identity is untouched.
        wider = self.store.conservation(1, 0, 256, self.ids + ['absent-elsewhere', 'another'], bins=16)
        self.assertEqual(data['bins'], wider['bins'])
        self.assertEqual(data['cohort'], 3)
        self.assertEqual(wider['cohort'], 5)

    def test_empty_components_contribute_nothing_but_still_count_in_the_cohort(self):
        with_empty = self.store.conservation(1, 0, 512, self.ids + [stable_id('absent')], bins=16)
        without = self.store.conservation(1, 0, 512, self.ids, bins=16)
        self.assertEqual(with_empty['bins'], without['bins'])
        self.assertEqual(with_empty['cohort'], 4)

    def test_cohort_order_shares_one_cache_entry(self):
        self.assertEqual(cohort_hash(['b', 'a']), cohort_hash(['a', 'b', 'a']))
        first = self.store.conservation(1, 0, 4096, self.ids, bins=64)
        with patch('alignment_explorer.summary_cache.build_cohort_prefix', side_effect=AssertionError('Rebuilt warm cohort')):
            again = self.store.conservation(1, 0, 4096, list(reversed(self.ids)), bins=64)
        self.assertEqual(first['bins'], again['bins'])

    def test_a_corrupt_sidecar_still_returns_exact_results(self):
        first = self.store.conservation(1, 0, 2048, self.ids, bins=64)
        with sqlite3.connect(Path(self.temp.name) / 'render-summaries.sqlite') as db:
            db.execute("UPDATE tiles SET data=X'00'")
        self.assertEqual(first['bins'], self.store.conservation(1, 0, 2048, self.ids, bins=64)['bins'])

    def test_a_lone_canonical_base_has_nothing_to_agree_with(self):
        store = AlignmentStore(Path(tempfile.mkdtemp()))
        store.initialize()
        # Every column holds exactly one canonical base. Counted naively that is
        # perfect agreement; counted honestly there is no comparison at all.
        store.add_block([{'source': 'x', 'sequence': 'AC-GT'}, {'source': 'y', 'sequence': '--A--'}])
        data = store.conservation(1, 0, 5, [stable_id('x'), stable_id('y')], bins=16)
        self.assertEqual(sum(data['bins']['canonical']), 0)
        self.assertEqual(sum(data['bins']['comparable']), 0)
        self.assertEqual(sum(data['bins']['occupied']), 5)

    def test_the_numpy_free_fallback_agrees_with_the_numpy_path(self):
        texts = [s[:300] for s in self.sequences]
        fast = cohort_counts(texts, 300)
        with patch.object(summary_cache, '_np', None):
            slow = cohort_counts(texts, 300)
        self.assertEqual(fast, slow)
        self.assertIsNotNone(summary_cache._np, 'numpy was expected to be importable here')


if __name__ == '__main__':
    unittest.main()
