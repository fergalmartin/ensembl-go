import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from alignment_explorer.store import AlignmentStore, stable_id, locate_column, source_span
from alignment_explorer.projection import row_segments, RowProjection, segment_pieces
from alignment_explorer.api import create_router
from fastapi import FastAPI
try:
    from fastapi.testclient import TestClient
except Exception:  # httpx is a test-only dependency; the projection tests need none of it.
    TestClient = None

# human runs forward from 10; mouse runs reverse over the same block, so the
# two exercise both directions of every conversion. `ancestor` has no aligned
# sequence at all and `orphan` is never linked to a genome.
MAF = '''##maf version=1

a score=1
s human.chr1 10 12 + 1000 --ACGT-TTGGCA-CG
s mouse.chr1 20 10 -   50 ACGTAC--GTAC----
s orphan.chr9  0 14 + 1000 ACGTACGTAC-GT-AC
e ancestor.chr1 0 16 + 1000 M
'''

class ProjectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.store = AlignmentStore(self.root / 'index')
        self.store.initialize()
        path = self.root / 'input.maf'
        path.write_text(MAF)
        self.store.import_file(path, 'maf')
        self.length = 16

    def tearDown(self):
        self.temp.cleanup()

    def projection(self, source, start=0, end=None):
        row_id = stable_id(source)
        end = self.length if end is None else end
        with self.store.connect() as db:
            record = dict(db.execute('SELECT * FROM rows WHERE block=1 AND id=?', (row_id,)).fetchone())
            segments = row_segments(db, 1, row_id, start, end)
        return RowProjection(record, segments, (start, end)), row_id

    def test_segments_are_the_runs_of_sequence_and_nothing_else(self):
        projection, _ = self.projection('human.chr1')
        # --ACGT-TTGGCA--CG : runs at columns 2-6, 7-13, 15-17
        self.assertEqual(projection.segments, [(2, 6, 0), (7, 13, 4), (14, 16, 10)])
        # Every segment's own count agrees with the store's independent one.
        from alignment_explorer.store import sequence_prefix
        with self.store.connect() as db:
            for column_start, _, before in projection.segments:
                self.assertEqual(sequence_prefix(db, 1, stable_id('human.chr1'), column_start), before)

    def test_a_window_reads_only_its_own_columns_and_keeps_whole_row_counts(self):
        whole, _ = self.projection('human.chr1')
        window, _ = self.projection('human.chr1', 7, 13)
        self.assertEqual(window.segments, [(7, 13, 4)])
        # The count is over the row, not over the window, so a segment means the
        # same thing whichever window produced it.
        self.assertEqual(window.segments[0][2], next(s[2] for s in whole.segments if s[0] == 7))

    def test_column_lookup_agrees_with_locate_column_on_both_strands(self):
        for source in ('human.chr1', 'mouse.chr1'):
            projection, row_id = self.projection(source)
            for coordinate in range(projection.start, projection.end):
                column = projection.column_of(coordinate)
                self.assertEqual(column, locate_column(self.store, 1, row_id, coordinate),
                                 f'{source} at {coordinate}')
                # And back again, exactly.
                self.assertEqual(projection.at_column(column)['coordinate'], coordinate)

    def test_a_gap_column_has_no_coordinate_but_names_its_neighbours(self):
        projection, _ = self.projection('human.chr1')
        leading = projection.at_column(0)
        self.assertTrue(leading['gap'])
        self.assertIsNone(leading['coordinate'])
        self.assertIsNone(leading['before'])
        self.assertEqual(leading['after'], 10)
        inner = projection.at_column(6)
        self.assertTrue(inner['gap'])
        self.assertIsNone(inner['coordinate'])
        self.assertEqual((inner['before'], inner['after']), (13, 14))
        trailing = projection.at_column(13)
        self.assertTrue(trailing['gap'])
        self.assertEqual((trailing['before'], trailing['after']), (19, 20))

    def test_a_reverse_row_reads_the_other_way_along_the_same_bases(self):
        projection, _ = self.projection('mouse.chr1')
        self.assertEqual(projection.strand, '-')
        # ACGTAC--GTAC---- : first column is the highest coordinate.
        self.assertEqual(projection.at_column(0)['coordinate'], projection.end - 1)
        self.assertEqual(projection.column_of(projection.end - 1), 0)
        self.assertGreater(projection.at_column(0)['coordinate'], projection.at_column(1)['coordinate'])

    def test_a_feature_becomes_an_envelope_and_its_base_bearing_pieces(self):
        projection, _ = self.projection('human.chr1')
        # Genomic 12..18 spans the row's internal gap at column 6.
        projected = projection.project(12, 18)
        self.assertEqual((projected['start'], projected['end']), (4, 11))
        self.assertEqual([(p['start'], p['end']) for p in projected['pieces']], [(4, 6), (7, 11)])
        self.assertFalse(projected['clipped_start'])
        self.assertFalse(projected['clipped_end'])
        # The envelope covers the gap; the pieces do not. Drawing only the
        # envelope would paint another row's insertion as exon body.
        self.assertGreater(projected['end'] - projected['start'],
                           sum(p['end'] - p['start'] for p in projected['pieces']))

    def test_a_feature_running_past_the_row_is_marked_clipped_on_the_right_end(self):
        forward, _ = self.projection('human.chr1')
        self.assertTrue(forward.project(0, 14)['clipped_start'])
        self.assertFalse(forward.project(0, 14)['clipped_end'])
        self.assertTrue(forward.project(18, 999)['clipped_end'])
        self.assertFalse(forward.project(18, 999)['clipped_start'])
        # On the reverse strand the clipped end swaps sides, because the columns
        # run the other way along the coordinates.
        reverse, _ = self.projection('mouse.chr1')
        self.assertTrue(reverse.project(0, 25)['clipped_end'])
        self.assertFalse(reverse.project(0, 25)['clipped_start'])
        self.assertTrue(reverse.project(25, 999)['clipped_start'])

    def test_a_feature_wholly_outside_the_row_projects_to_nothing(self):
        projection, _ = self.projection('human.chr1')
        self.assertIsNone(projection.project(0, 5))
        self.assertIsNone(projection.project(500, 600))

    def test_window_coordinates_bound_the_annotation_query(self):
        whole, _ = self.projection('human.chr1')
        self.assertEqual(whole.window_coordinates(), (10, 22))
        window, _ = self.projection('human.chr1', 7, 13)
        self.assertEqual(window.window_coordinates(), (14, 20))
        reverse, _ = self.projection('mouse.chr1', 0, 6)
        # Reverse rows still report a low-to-high interval: it is an interval,
        # not a direction.
        low, high = reverse.window_coordinates()
        self.assertLess(low, high)
        self.assertEqual(high, 30)

    def test_an_all_gap_window_has_no_segments_and_no_interval(self):
        projection, _ = self.projection('human.chr1', 0, 2)
        self.assertEqual(projection.segments, [])
        self.assertIsNone(projection.window_coordinates())
        self.assertIsNone(projection.project(10, 22))

    def test_segment_pieces_clip_to_the_offsets_asked_for(self):
        segments = [(0, 4, 0), (10, 14, 4)]
        self.assertEqual(segment_pieces(segments, 0, 8), [(0, 4), (10, 14)])
        self.assertEqual(segment_pieces(segments, 2, 6), [(2, 4), (10, 12)])
        self.assertEqual(segment_pieces(segments, 4, 4), [])


@unittest.skipIf(TestClient is None, 'fastapi TestClient requires httpx')
class BlockContextApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.calls = []

        def genes(assembly, chrom, start, end, expand=(), gene_limit=200, transcript_limit=8, page=0):
            self.calls.append((assembly, chrom, start, end, tuple(expand), page))
            return {'complete': True, 'genes': [{
                'gene_id': 'G1', 'gene_name': 'GENE1', 'biotype': 'protein_coding', 'strand': '+',
                'genomic': {'start': 11, 'end': 22}, 'transcript_count': 2,
                'transcripts': [{
                    'transcript_id': 'T1', 'is_canonical': True, 'representative': False,
                    'biotype': 'protein_coding', 'strand': '+', 'genomic': {'start': 11, 'end': 22},
                    'features': [{'type': 'exon', 'start': 12, 'end': 18},
                                 {'type': 'cds', 'start': 12, 'end': 16},
                                 {'type': 'exon', 'start': 500, 'end': 520}],
                }]}]}

        app = FastAPI()
        app.include_router(create_router(cache_root=self.root / 'cache', gene_provider=genes,
                                         availability_provider=lambda assembly, region: 'ready'))
        self.client = TestClient(app)
        source = self.root / 'input.maf'
        source.write_text(MAF)
        response = self.client.post('/api/alignment-explorer/datasets', json={'path': str(source), 'format': 'maf'})
        self.assertEqual(response.status_code, 200, response.text)
        job = response.json()
        for _ in range(400):
            status = self.client.get('/api/alignment-explorer/jobs/' + job['id']).json()
            if status['status'] in ('failed', 'ready', 'cancelled'):
                break
            time.sleep(.01)
        self.assertEqual(status['status'], 'ready', status)
        self.dataset = status['dataset_id']
        linked = self.client.post(f'/api/alignment-explorer/datasets/{self.dataset}/metadata',
                                  json={'entries': [{'source': 'human.chr1', 'assembly': 'GCA_TEST.1', 'region': '1'}]})
        self.assertEqual(linked.status_code, 200, linked.text)

    def tearDown(self):
        self.temp.cleanup()

    def post(self, path, payload):
        return self.client.post(f'/api/alignment-explorer/datasets/{self.dataset}/{path}', json=payload)

    def test_block_context_distinguishes_every_reason_a_row_has_no_annotation(self):
        body = self.post('block-context', {'block': 1}).json()
        states = {row['source']: row['availability'] for row in body['rows']}
        self.assertEqual(states['human.chr1'], 'ready')
        self.assertEqual(states['orphan.chr9'], 'unresolved')
        self.assertEqual(states['ancestor.chr1'], 'no-coverage')
        human = next(row for row in body['rows'] if row['source'] == 'human.chr1')
        # Zero-based half-open, matching the store rather than the GFF3 index.
        self.assertEqual(human['genomic'], {'start': 10, 'end': 22})
        self.assertEqual(human['bases'], 12)
        self.assertEqual(body['length'], 16)
        self.assertIn('rows', body['limits'])

    def test_selected_columns_map_each_row_independently_on_both_strands(self):
        human, mouse = stable_id('human.chr1'), stable_id('mouse.chr1')
        result = self.post('block-context', {'block': 1, 'ids': [human, mouse], 'start': 4, 'end': 11})
        self.assertEqual(result.status_code, 200, result.text)
        rows = {row['id']: row for row in result.json()['rows']}
        self.assertEqual(rows[human]['selection'], {'start': 12, 'end': 18})
        self.assertEqual(rows[mouse]['selection'], {'start': 21, 'end': 26})
        self.assertEqual(rows[human]['genomic'], {'start': 10, 'end': 22})
        self.assertEqual(rows[human]['source_length'], 1000)
        gaps = self.post('block-context', {'block': 1, 'ids': [human, mouse], 'start': 6, 'end': 7}).json()
        self.assertTrue(all(row['selection'] is None for row in gaps['rows']))
        for payload in ({'start': 4}, {'start': 4, 'end': 17}, {'start': 8, 'end': 7}):
            self.assertEqual(self.post('block-context', {'block': 1, **payload}).status_code, 400)

    def test_block_features_project_into_columns_and_keep_the_genomic_truth(self):
        row_id = stable_id('human.chr1')
        body = self.post('block-features', {'block': 1, 'ids': [row_id]}).json()
        transcript = body['rows'][row_id]['genes'][0]['transcripts'][0]
        exon = transcript['features'][0]
        self.assertEqual(exon['genomic'], {'start': 12, 'end': 18})
        self.assertEqual([(p['start'], p['end']) for p in exon['pieces']], [(4, 6), (7, 11)])
        self.assertEqual((exon['start'], exon['end']), (4, 11))
        # A feature nowhere near the block contributes nothing rather than being
        # clamped onto its edge.
        self.assertEqual(len(transcript['features']), 2)
        self.assertEqual(body['rows'][row_id]['genes'][0]['gene_name'], 'GENE1')

    def test_the_annotation_query_is_bounded_by_the_window_actually_asked_for(self):
        row_id = stable_id('human.chr1')
        self.calls.clear()
        self.post('block-features', {'block': 1, 'ids': [row_id], 'start': 7, 'end': 13})
        assembly, chrom, start, end, _, _ = self.calls[-1]
        # One-based inclusive on the way in, over the window's own bases only.
        self.assertEqual((assembly, chrom, start, end), ('GCA_TEST.1', '1', 15, 20))

    def test_rows_without_a_usable_link_say_which_kind_of_nothing_they_are(self):
        body = self.post('block-features', {'block': 1, 'ids': [stable_id('orphan.chr9'), stable_id('ancestor.chr1')]}).json()
        self.assertEqual(body['rows'][stable_id('orphan.chr9')]['reason'], 'unresolved')
        self.assertEqual(body['rows'][stable_id('ancestor.chr1')]['reason'], 'no-coverage')
        for entry in body['rows'].values():
            self.assertEqual(entry['genes'], [])

    def test_block_comparison_measures_the_pairs_it_is_given(self):
        human, mouse = stable_id('human.chr1'), stable_id('mouse.chr1')
        body = self.post('block-comparison', {'block': 1, 'pairs': [[human, mouse]]}).json()
        pair = body['pairs'][0]
        self.assertEqual((pair['reference'], pair['target']), (human, mouse))
        # human --ACGT-TTGGCA-CG against mouse ACGTAC--GTAC----
        self.assertEqual(pair['totals']['reference_gap'], 2)
        self.assertGreater(pair['totals']['target_gap'], 0)
        self.assertEqual(pair['comparable'],
                         pair['totals']['match'] + pair['totals']['substitution'])
        # The rows are on opposite strands, which is reported as a fact and
        # never as an inversion.
        self.assertFalse(pair['same_orientation'])
        self.assertNotIn('inversion', pair['description'].lower())
        self.assertIn('mouse.chr1', pair['description'])

    def test_a_selected_feature_is_measured_against_every_target(self):
        human, mouse = stable_id('human.chr1'), stable_id('mouse.chr1')
        body = self.post('block-comparison', {
            'block': 1, 'pairs': [[human, mouse]],
            'feature': {'type': 'cds', 'pieces': [{'start': 4, 'end': 6}, {'start': 7, 'end': 11}]}}).json()
        measured = body['pairs'][0]['feature']
        self.assertEqual(measured['columns'], 6)
        self.assertEqual(measured['type'], 'cds')
        self.assertIn('cds bases', measured['description'])
        self.assertEqual(measured['comparable'],
                         measured['match'] + measured['substitution'])

    def test_comparison_refuses_an_unbounded_window_and_an_empty_pair_list(self):
        human = stable_id('human.chr1')
        self.assertEqual(self.post('block-comparison', {'block': 1, 'pairs': []}).status_code, 400)
        self.assertEqual(self.post('block-comparison',
                                   {'block': 1, 'pairs': [[human, human]], 'start': 5, 'end': 5}).status_code, 400)

    def test_row_and_column_bounds_are_enforced(self):
        self.assertEqual(self.post('block-features', {'block': 1, 'ids': []}).status_code, 400)
        self.assertEqual(self.post('block-features', {'block': 1, 'ids': [stable_id('human.chr1')], 'start': 9, 'end': 9}).status_code, 400)
        self.assertEqual(self.post('block-context', {'block': 99}).status_code, 404)


if __name__ == '__main__':
    unittest.main()


class ComparisonTests(unittest.TestCase):
    """What two rows differ by, and what must never be said about it."""

    def kinds(self, reference, target):
        from alignment_explorer.comparison import compare_columns
        return compare_columns(reference, target)

    def test_every_column_is_named_for_what_is_there(self):
        kinds, totals = self.kinds('ACGT-AN', 'ACTT A-'.replace(' ', '-'))
        #               A/A match, C/C match, G/T substitution, T/T match,
        #               -/- double gap, A/A match, N/- target gap
        self.assertEqual(kinds, ['match', 'match', 'substitution', 'match', None, 'match', 'target_gap'])
        self.assertEqual(totals['match'], 4)
        self.assertEqual(totals['substitution'], 1)
        self.assertEqual(totals['target_gap'], 1)

    def test_a_double_gap_is_counted_as_nothing_at_all(self):
        from alignment_explorer.comparison import comparable
        kinds, totals = self.kinds('A--T', 'A--T')
        # The two middle columns belong to other rows in the block and say
        # nothing whatever about this pair.
        self.assertEqual(kinds, ['match', None, None, 'match'])
        self.assertEqual(comparable(totals), 2)
        self.assertEqual(sum(totals.values()), 2)

    def test_unknown_sequence_is_never_counted_as_difference(self):
        from alignment_explorer.comparison import comparable
        _, totals = self.kinds('ANNA', 'ANTA')
        self.assertEqual(totals['unknown'], 2)
        self.assertEqual(totals['substitution'], 0)
        # And it is not agreement either: it is outside the denominator.
        self.assertEqual(comparable(totals), 2)

    def test_absent_coverage_is_not_a_gap(self):
        _, totals = self.kinds('ACGT', None)
        self.assertEqual(totals['unavailable'], 4)
        self.assertEqual(totals['target_gap'], 0)

    def test_the_direction_of_a_gap_is_part_of_what_is_measured(self):
        _, forward = self.kinds('ACGT', 'A--T')
        _, backward = self.kinds('A--T', 'ACGT')
        self.assertEqual(forward['target_gap'], 2)
        self.assertEqual(forward['reference_gap'], 0)
        self.assertEqual(backward['reference_gap'], 2)
        self.assertEqual(backward['target_gap'], 0)

    def test_a_feature_is_measured_over_its_own_columns_only(self):
        from alignment_explorer.comparison import measure_feature
        kinds, _ = self.kinds('ACGTACGTAC', 'AC--ACGTAC')
        measured = measure_feature(kinds, [{'start': 0, 'end': 4}])
        self.assertEqual(measured['columns'], 4)
        self.assertEqual(measured['target_gap'], 2)
        self.assertEqual(measured['comparable'], 2)
        self.assertFalse(measured['entirely_gapped'])
        # Columns outside the feature are not "nearby", they are not counted.
        self.assertEqual(measure_feature(kinds, [{'start': 4, 'end': 10}])['target_gap'], 0)

    def test_an_entirely_gapped_target_is_said_plainly_and_nothing_more(self):
        from alignment_explorer.comparison import measure_feature, describe
        kinds, _ = self.kinds('ACGT', '----')
        measured = measure_feature(kinds, [{'start': 0, 'end': 4}])
        self.assertTrue(measured['entirely_gapped'])
        sentence = describe(measured, 'Mouse', 'Human', 'CDS')
        self.assertIn('4 Mouse gap columns opposite Human CDS bases', sentence)
        # Never a verdict on what happened, to whom, or whether an exon is gone.
        for forbidden in ('deletion', 'insertion', 'loss', 'lost', 'inversion'):
            self.assertNotIn(forbidden, sentence.lower())

    def test_descriptions_always_carry_the_direction(self):
        from alignment_explorer.comparison import describe
        _, totals = self.kinds('ACGTACGT', 'A--TACGA')
        sentence = describe(totals, 'Mouse', 'Human')
        self.assertIn('against Human', sentence)
        self.assertIn('Mouse gap columns', sentence)
        self.assertIn('substituted column', sentence)
        # Singular reads as singular; the numbers are the point and bad grammar
        # around them reads as carelessness about them.
        from alignment_explorer.comparison import compare_columns
        _, one = compare_columns('AC', 'AG')
        self.assertIn('1 substituted column against Human.', describe(one, 'Mouse', 'Human'))
        for forbidden in ('deletion', 'insertion', 'inversion'):
            self.assertNotIn(forbidden, sentence.lower())

    def test_bins_keep_every_kind_rather_than_a_winner(self):
        from alignment_explorer.comparison import bin_kinds
        kinds, _ = self.kinds('A' * 99 + 'C', 'A' * 99 + 'G')
        bins = bin_kinds(kinds, 4)
        self.assertLessEqual(len(bins), 4)
        # The single substitution survives 25 matches sharing its bucket.
        self.assertEqual(sum(b['substitution'] for b in bins), 1)
        self.assertEqual(sum(b['match'] for b in bins), 99)
        self.assertEqual(bin_kinds([], 4), [])
