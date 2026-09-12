import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from motif_engine import MotifCache, SearchCancelled, composition_key, search_spans
from alignment_explorer.store import AlignmentStore
from alignment_explorer.motif_jobs import MotifJobs


def motif(pattern, kind='literal'):
    return SimpleNamespace(pattern=pattern, kind=kind, id=pattern)


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.cache = MotifCache(Path(self.temp.name) / 'cache.sqlite')

    def tearDown(self):
        self.temp.cleanup()

    def test_exact_gaps_overlaps_and_regex(self):
        self.assertEqual(list(search_spans('aA-aA', 'AAA')), [0, 2, 3, 5])
        self.assertEqual(list(search_spans('C--ATG', '(?<=C)ATG$', 'regex')), [3, 6])
        self.assertEqual(list(search_spans('ATG', '(?=ATG)', 'regex')), [])

    def test_masks_match_column_oracle_at_multiple_zooms(self):
        import random
        rng = random.Random(8)
        seq = ''.join(rng.choice('ACGT-') for _ in range(35000))
        motifs = [motif('ATG'), motif('GC'), motif('T[AC]', 'regex')]
        self.cache.prepare('one', lambda: seq, motifs)
        expected = [0] * len(seq)
        for i, m in reversed(list(enumerate(motifs))):
            spans = search_spans(seq, m.pattern, m.kind)
            for a, z in zip(spans[::2], spans[1::2]):
                expected[a:z] = [i + 1] * (z - a)
        for step in (1, 2, 4, 16, 32, 256, 1024):
            start, end = step * 3, min(len(seq), step * 1027)
            runs = self.cache.region('one', composition_key(motifs), start, end, step)
            actual = [0] * ((end - start + step - 1) // step)
            for a, z, colour in runs:
                actual[(a - start) // step:(z - start + step - 1) // step] = [colour] * ((z - a + step - 1) // step)
            oracle = [min((c for c in expected[a:min(end, a + step)] if c), default=0) for a in range(start, end, step)]
            self.assertEqual(actual, oracle, f'bin width {step}')

    def test_warm_cache_recolour_reorder_add_and_revision(self):
        seq = 'ATGC' * 1000; original = [motif('ATG'), motif('GC')]
        cold = self.cache.prepare('one', lambda: seq, original)
        self.assertEqual(cold['searched'], 2)
        no_read = lambda: self.fail('Warm cache loaded the source sequence')
        warm = MotifCache(self.cache.path).prepare('one', no_read, original)
        self.assertEqual((warm['cached'], warm['prepared_cached']), (2, True))
        reordered = self.cache.prepare('one', no_read, list(reversed(original)))
        self.assertEqual((reordered['cached'], reordered['searched']), (2, 0))
        added = self.cache.prepare('one', lambda: seq, [*original, motif('TT')])
        self.assertEqual((added['cached'], added['searched']), (2, 1))
        changed = self.cache.prepare('new-revision', lambda: 'CCCC', original)
        self.assertEqual(changed['searched'], 2)
        self.assertFalse(changed['matched'])

    def test_cancel_discards_current_sequence_and_keeps_complete_sequences(self):
        motifs = [motif('ATG'), motif('GC')]
        self.cache.prepare('complete', lambda: 'ATGC' * 100, motifs)
        cancelled = False
        def progress(**value):
            nonlocal cancelled
            if value['phase'] == 'preparing': cancelled = True
        with self.assertRaises(SearchCancelled):
            self.cache.prepare('partial', lambda: 'ATGC' * 100, motifs, lambda: cancelled, progress)
        with self.cache.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM searches WHERE sequence="partial"').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT count(*) FROM prepared WHERE sequence="partial"').fetchone()[0], 0)
        warm = self.cache.prepare('complete', lambda: self.fail('lost completed cache'), motifs)
        self.assertTrue(warm['prepared_cached'])

    def test_dense_common_motifs_have_no_old_50000_match_limit(self):
        seq = 'ATGCGC' * 100000
        motifs = [motif('ATG'), motif('GC')]
        result = self.cache.prepare('dense', lambda: seq, motifs)
        self.assertTrue(result['matched'])
        # Millions of bases become at most 1,024 runs for a viewport request.
        runs = self.cache.region('dense', composition_key(motifs), 0, 1024 * 1024, 1024)
        self.assertLessEqual(len(runs), 1024)

    def test_tile_read_never_searches(self):
        motifs = [motif('ATG')]
        self.cache.prepare('one', lambda: 'ATGC' * 10000, motifs)
        with patch('motif_engine.engine.search_spans', side_effect=AssertionError('render searched')):
            self.assertIsNotNone(self.cache.region('one', composition_key(motifs), 1024, 2048))

    def test_adapter_prepares_all_rows_filters_and_reuses_cache(self):
        store = AlignmentStore(Path(self.temp.name) / 'alignment'); store.initialize()
        for seq in ['ATGC', 'CCCC', 'A-TG']:
            store.add_block([{'source': 'one', 'sequence': seq}])
        manager = MotifJobs()
        try:
            def wait(job):
                deadline = time.monotonic() + 10
                while manager.status(job['id'])['status'] in ('queued', 'running'):
                    self.assertLess(time.monotonic(), deadline)
                    time.sleep(.01)
                return manager.status(job['id'])
            cold = wait(manager.start('dataset', store, [motif('ATG')]))
            self.assertEqual(cold['status'], 'ready', cold)
            self.assertEqual((cold['completed'], cold['searched']), (3, 3))
            self.assertEqual([b['block'] for b in manager.blocks(cold['id'], 0)['blocks']], [1, 3])
            warm = wait(manager.start('dataset', store, [motif('ATG')]))
            self.assertEqual((warm['cached'], warm['searched'], warm['prepared_cached']), (3, 0, 3))
            with self.assertRaises(ValueError): manager.region(warm['id'], 1, [], 0, 100000, 1)
        finally:
            manager.pool.shutdown(wait=True)


if __name__ == '__main__': unittest.main()
