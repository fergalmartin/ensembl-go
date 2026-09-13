import json
import random
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from collections import Counter
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from alignment_explorer.store import AlignmentStore, stable_id, CHUNK
from alignment_explorer.summary_cache import counts


class SummaryCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = AlignmentStore(Path(self.temp.name))
        self.store.initialize()
        rng = random.Random(7)
        self.sequences = [''.join(rng.choices('ACGTNRY-?', k=CHUNK + 199)) for _ in range(3)]
        self.store.add_block([{'source': str(i), 'sequence': seq} for i, seq in enumerate(self.sequences)] + [{'source': 'absent', 'sequence': None, 'empty_status': 'C'}])

    def tearDown(self): self.temp.cleanup()

    def test_arbitrary_bins_and_chunk_edges_match_raw_counts(self):
        for start, end, bins, focus in [(0, CHUNK+199, 128, 0), (13, CHUNK+77, 777, 1), (CHUNK-37, CHUNK+65, 16, 2), (15, 53, 16, None)]:
            data = self.store.region(1, start, end, max_cells=0, bins=bins, focus_id=stable_id(str(focus)) if focus is not None else None)
            for row in data['rows']:
                if row['source'] == 'absent':
                    self.assertTrue(row['missing']); self.assertEqual(row['bins'], []); continue
                sequence = self.sequences[int(row['source'])]
                for i, a in enumerate(range(start, end, data['bin_size'])):
                    z = min(end, a + data['bin_size'])
                    self.assertEqual(row['bins'][i], dict(Counter(sequence[a:z])))
                    ref = self.sequences[focus][a:z] if focus is not None else ''
                    expected = counts(sequence[a:z], ref)
                    self.assertEqual(row['divergence_bins'][i]['comparable'], expected[-2])
                    self.assertEqual(row['divergence_bins'][i]['different'], expected[-1])
                self.assertEqual(row['offset_bases'], len(sequence[:start].replace('-', '')))

    def test_reopen_and_metadata_change_reuse_persisted_counts(self):
        expected = self.store.region(1, 0, CHUNK, max_cells=0, bins=128, focus_id=stable_id('0'))
        reopened = AlignmentStore(Path(self.temp.name))
        reopened.update_metadata([{'id':stable_id('0'), 'assembly':'GCA_123.1', 'region':'1', 'label':'Updated label'}])
        with patch('alignment_explorer.summary_cache.build_prefix', side_effect=AssertionError('Rebuilt warm summary')):
            actual = reopened.region(1, 0, CHUNK, max_cells=0, bins=256, focus_id=stable_id('0'))
        self.assertEqual(actual['rows'][0]['label'], 'Updated label')
        self.assertEqual(sum(sum(b.values()) for b in actual['rows'][0]['bins']), CHUNK)
        self.assertEqual(sum(sum(b.values()) for b in expected['rows'][0]['bins']), CHUNK)

    def test_corrupt_entry_rebuilds_and_focus_has_separate_identity(self):
        first = self.store.region(1, 0, 2048, max_cells=0, focus_id=stable_id('0'))
        cache_path = Path(self.temp.name) / 'render-summaries.sqlite'
        with sqlite3.connect(cache_path) as db: db.execute("UPDATE tiles SET data=X'00'")
        self.assertEqual(first, self.store.region(1, 0, 2048, max_cells=0, focus_id=stable_id('0')))
        changed = self.store.region(1, 0, 2048, max_cells=0, focus_id=stable_id('1'))
        self.assertNotEqual(first['rows'][0]['divergence_bins'], changed['rows'][0]['divergence_bins'])

    def test_individual_layout_pages_never_merge_or_skip_blocks(self):
        for _ in range(39): self.store.add_block([{'source':'short', 'sequence':'ACGT'}])
        end = self.store.layout_info()['layout_end']
        after = 0; blocks = []; boundaries=[]
        while True:
            result = self.store.individual_layout_region(0,end,limit=16,after=after)
            self.assertTrue(all(not b.get('aggregate') for b in result['blocks']))
            self.assertLessEqual(len(result['blocks']),16)
            blocks.extend(b['block'] for b in result['blocks']);boundaries.append((result['cover_start'],result['cover_end']))
            after = result['next']
            if not after: break
        self.assertEqual(blocks, list(range(1,41)))
        self.assertTrue(all(a[1]==b[0] for a,b in zip(boundaries,boundaries[1:])))
