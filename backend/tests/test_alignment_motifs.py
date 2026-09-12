import sys
import random
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from alignment_explorer.motifs import motif_spans, search_row, matching_blocks_page
from alignment_explorer.store import AlignmentStore, stable_id, CHUNK


class MotifTests(unittest.TestCase):
    def test_gap_mapping_agrees_with_independent_base_coordinate_oracle(self):
        rng = random.Random(42)
        for _ in range(100):
            sequence = ''.join(rng.choice('ACGT--') for _ in range(150))
            coordinates = [i for i, base in enumerate(sequence) if base != '-']
            text = sequence.replace('-', '')
            pattern = ''.join(rng.choice('ACGT') for _ in range(2))
            expected = set()
            for i in range(len(text) - len(pattern) + 1):
                if text[i:i + len(pattern)] == pattern:
                    expected.update(coordinates[i:i + len(pattern)])
            actual = {i for a, z in motif_spans(sequence, pattern) for i in range(a, z)}
            self.assertEqual(actual, expected)

    def test_case_gaps_and_overlapping_occurrences(self):
        self.assertEqual(motif_spans('aA-aA', 'AAA'), [[0, 2], [3, 5]])
        self.assertEqual(motif_spans('--AT--G--', 'atg'), [[2, 4], [6, 7]])
        self.assertEqual(motif_spans('ATGC', 'ATG.'), [])
        self.assertEqual(motif_spans('ATGC', 'ATG.', 'regex'), [[0, 4]])

    def test_regex_anchors_lookarounds_and_empty_matches(self):
        self.assertEqual(motif_spans('A--TGATG', '^ATG', 'regex'), [[0, 1], [3, 5]])
        self.assertEqual(motif_spans('CATGATGA', '(?<=C)ATG', 'regex'), [[1, 4]])
        self.assertEqual(motif_spans('ATGATG', '(?=ATG)', 'regex'), [])
        self.assertEqual(motif_spans('ATGATG', 'ATG$', 'regex'), [[3, 6]])

    def test_timeouts_and_match_limits_are_explicit(self):
        with self.assertRaises(TimeoutError):
            motif_spans('A' * 10000 + 'C', '(A+)+$', 'regex', timeout=.001)
        with patch('alignment_explorer.motifs.MAX_RUNS', 2):
            with self.assertRaisesRegex(ValueError, 'Too many'):
                motif_spans('ACACAC', 'A')

    def test_complete_source_rows_cross_chunk_edges_and_isolate_bad_patterns(self):
        with tempfile.TemporaryDirectory() as directory:
            store = AlignmentStore(Path(directory)); store.initialize()
            store.add_block([{'source': 'row', 'sequence': 'C' * (CHUNK - 1) + 'AT--GCCC'}])
            store.add_block([{'source': 'row', 'sequence': 'ATG'}])
            motifs = [SimpleNamespace(id='good', pattern='ATG', kind='literal'),
                      SimpleNamespace(id='bad', pattern='[', kind='regex')]
            result = search_row(store, 1, stable_id('row'), motifs)
            self.assertEqual(result['spans']['good'], [[CHUNK - 1, CHUNK + 1], [CHUNK + 3, CHUNK + 4]])
            self.assertIn('Invalid regular expression', result['errors']['bad'])
            self.assertEqual(search_row(store, 2, stable_id('row'), motifs)['spans']['good'], [[0, 3]])
            self.assertEqual(search_row(store, 2, 'missing', motifs)['spans']['good'], [])

    def test_endpoint_validates_requests_and_returns_match_errors(self):
        from pydantic import ValidationError
        from alignment_explorer.api import create_router, MotifRequest
        with tempfile.TemporaryDirectory() as directory:
            dataset = 'a' * 32
            store = AlignmentStore(Path(directory) / dataset); store.initialize()
            store.add_block([{'source': 'row', 'sequence': 'AT--G'}])
            store.set_meta('status', 'ready')
            endpoint = next(route.endpoint for route in create_router(directory).routes if route.path.endswith('/motifs'))
            body = {'block': 1, 'row': stable_id('row'), 'motifs': [{'id': 'x', 'pattern': 'ATG', 'kind': 'literal'}]}
            response = endpoint(dataset, MotifRequest(**body))
            self.assertEqual(response['spans']['x'], [[0, 2], [4, 5]])
            body['motifs'][0]['kind'] = 'unknown'
            with self.assertRaises(ValidationError):
                MotifRequest(**body)

    def test_block_filter_searches_all_rows_and_pages_without_joining_blocks(self):
        with tempfile.TemporaryDirectory() as directory:
            store = AlignmentStore(Path(directory)); store.initialize()
            for sequences in [('CCC', 'A-T-G'), ('CCCC', 'TTTT'), ('AT',), ('G',), ('CATG',)]:
                width = max(map(len, sequences))
                store.add_block([{'source': str(i), 'sequence': seq.ljust(width, '-')} for i, seq in enumerate(sequences)])
            motifs = [SimpleNamespace(id='a', pattern='ATG', kind='literal')]
            first = matching_blocks_page(store, motifs, limit=2)
            self.assertEqual([b['block'] for b in first['blocks']], [1])
            self.assertEqual(first['next'], 2)
            second = matching_blocks_page(store, motifs, after=2, limit=2)
            self.assertEqual(second['blocks'], [])
            last = matching_blocks_page(store, motifs, after=second['next'], limit=2)
            self.assertEqual([b['block'] for b in last['blocks']], [5])
            self.assertIsNone(last['next'])
            with self.assertRaisesRegex(ValueError, 'invalid motif'):
                matching_blocks_page(store, [SimpleNamespace(pattern='[', kind='regex')])


if __name__ == '__main__':
    unittest.main()
