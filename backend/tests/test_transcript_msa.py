"""The shared transcript-alignment core: regions, features, projection, the store."""
import random
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from transcript_msa import AlignmentStore, align, estimate, map_features, plan_region, prepare_row, project, settings_params
from transcript_msa.regions import (
    fetch_sequence, genomic_range_to_ungapped, genomic_to_ungapped, reverse_complement, ungapped_to_genomic,
)

random.seed(7)
CHROM = list(random.choice('ACGT') for _ in range(4000))
# The plus-strand fixture transcript's splice sites: GT after each exon, AG before the next.
for at, bases in ((1101, 'GT'), (1298, 'AG'), (1401, 'GT'), (1403, 'AG'), (1501, 'GT'), (1998, 'AG')):
    CHROM[at - 1:at + 1] = list(bases)
CHROM = ''.join(CHROM)


def fetch(chrom, start, end):
    """Forward-strand sequence of the fake chromosome, clipped to its ends like a FASTA."""
    lo, hi = max(1, start), min(len(CHROM), end)
    return CHROM[lo - 1:hi], lo, hi


def transcript(strand='+', exons=((1000, 1100), (1300, 1400), (1405, 1500), (2000, 2150))):
    cds = ((1050, 1100), (1300, 1400), (1405, 1500), (2000, 2090))
    utrs = (('five_prime_UTR', 1000, 1049), ('three_prime_UTR', 2091, 2150))
    if strand == '-':
        utrs = (('three_prime_UTR', 1000, 1049), ('five_prime_UTR', 2091, 2150))
    return {'id': 'tx1', 'chrom': '1', 'strand': strand, 'start': exons[0][0], 'end': exons[-1][1],
            'exons': [{'start': s, 'end': e} for s, e in exons], 'cds': [{'start': s, 'end': e} for s, e in cds],
            'utrs': [{'feature_type': k, 'start': s, 'end': e} for k, s, e in utrs]}


def gapped(seq, every=17):
    """A plausible aligned row: gaps sprinkled through the sequence and at both ends."""
    out = ['--']
    for i, c in enumerate(seq):
        out.append(c)
        if i % every == every - 1:
            out.append('-' * (1 + i % 3))
    out.append('---')
    return ''.join(out)


class RegionTests(unittest.TestCase):
    def test_exon_mode_keeps_exons_intron_edges_and_flanks(self):
        region = plan_region(transcript('+'), 'exons', 100, 50, 10)
        kinds = [(s['kind'], s['start'], s['end']) for s in region['segments']]
        self.assertEqual(kinds[0], ('flank5', 900, 999))
        self.assertEqual(kinds[-1], ('flank3', 2151, 2200))
        # A 4 bp intron (1401-1404) is shorter than two edges: kept whole.
        self.assertIn(('intron', 1401, 1404), kinds)
        self.assertIn(('intron_edge', 1101, 1110), kinds)
        self.assertIn(('intron_edge', 1290, 1299), kinds)
        self.assertEqual([(c['start'], c['end'], c['removed']) for c in region['cuts']], [(1111, 1289, 179), (1511, 1989, 479)])

    def test_minus_strand_runs_five_to_three(self):
        region = plan_region(transcript('-'), 'exons', 100, 50, 10)
        self.assertEqual(region['segments'][0]['kind'], 'flank5')
        self.assertEqual((region['segments'][0]['start'], region['segments'][0]['end']), (2151, 2250))
        self.assertEqual(region['segments'][-1]['kind'], 'flank3')
        starts = [s['start'] for s in region['segments']]
        self.assertEqual(starts, sorted(starts, reverse=True))

    def test_sequence_and_coordinates_agree_on_both_strands(self):
        for strand in '+-':
            with self.subTest(strand=strand):
                region, seq = fetch_sequence(plan_region(transcript(strand), 'exons', 100, 100, 10), fetch)
                self.assertEqual(len(seq), region['length'])
                for i in (0, 5, 150, len(seq) // 2, len(seq) - 1):
                    pos = ungapped_to_genomic(region, i)
                    base = CHROM[pos - 1]
                    self.assertEqual(seq[i], base if strand == '+' else reverse_complement(base))
                    self.assertEqual(genomic_to_ungapped(region, pos), i)
                self.assertIsNone(genomic_to_ungapped(region, 1200))  # inside a cut

    def test_flank_off_the_contig_end_is_clipped(self):
        tx = transcript('+', exons=((20, 80), (200, 3990)))
        region, seq = fetch_sequence(plan_region(tx, 'genomic', 100, 100), fetch)
        self.assertEqual((region['segments'][0]['start'], region['segments'][0]['end']), (1, 4000))
        self.assertEqual(len(seq), 4000)

    def test_intron_edges_meet_across_a_cut(self):
        region = plan_region(transcript('+'), 'exons', 0, 0, 10)
        runs = genomic_range_to_ungapped(region, 1101, 1299)
        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0][1] - runs[0][0] + 1, 20)


class FeatureTests(unittest.TestCase):
    def test_matches_the_msa_views_mapper_for_one_genomic_window(self):
        import main
        for strand in '+-':
            with self.subTest(strand=strand):
                t = transcript(strand)
                region, seq = fetch_sequence(plan_region(t, 'genomic', 100, 100), fetch)
                aligned = gapped(seq)
                ours = map_features(t, region, aligned, seq)
                simple = main.SimpleTranscript(
                    't', '1', t['start'], t['end'], strand,
                    [main.SimpleFeature('exon', e['start'], e['end'], strand) for e in t['exons']],
                    [main.SimpleFeature('CDS', c['start'], c['end'], strand) for c in t['cds']],
                    [main.SimpleFeature(u['feature_type'], u['start'], u['end'], strand) for u in t['utrs']])
                seg = region['segments'][0]
                theirs = [f.model_dump(exclude={'codon_phase'}) for f in
                          main.map_features_to_alignment(simple, seg['start'], seg['end'], aligned, strand, seq)]
                self.assertEqual(ours, theirs)

    def test_trimmed_introns_map_and_leave_cut_marks(self):
        for strand in '+-':
            with self.subTest(strand=strand):
                t = transcript(strand)
                region, seq = fetch_sequence(plan_region(t, 'exons', 100, 100, 10), fetch)
                aligned = gapped(seq)
                features = map_features(t, region, aligned, seq)
                columns = [i for i, c in enumerate(aligned) if c != '-']
                exons = sorted((f for f in features if f['type'] == 'exon'), key=lambda f: f['start'])
                self.assertEqual(len(exons), 4)
                first_exon = exons[0]
                self.assertEqual(first_exon['end'] - first_exon['start'] + 1 - aligned[first_exon['start']:first_exon['end'] + 1].count('-'),
                                 first_exon['original_end'] - first_exon['original_start'] + 1)
                cuts = [f for f in features if f['type'] == 'intron_cut']
                self.assertEqual(sorted(c['removed_bp'] for c in cuts), [179, 479])
                for cut in cuts:
                    # The bases either side of a cut are the last of one intron edge and the first of the next.
                    before = columns.index(cut['start'])
                    self.assertEqual(columns[before + 1], cut['end'])
                sites = [f for f in features if f['type'] in ('donor', 'acceptor')]
                if strand == '+':
                    self.assertEqual(len(sites), 6)
                for site in sites:
                    bases = CHROM[site['original_start'] - 1:site['original_end']]
                    read = bases if strand == '+' else reverse_complement(bases)
                    self.assertEqual(read, 'GT' if site['type'] == 'donor' else 'AG')


class ProjectionTests(unittest.TestCase):
    def test_dropping_rows_drops_their_only_columns_and_moves_features(self):
        alignment = {'alignment_length': 8, 'rows': [
            {'row_key': 'a', 'aligned': 'AC--GT-A', 'features': [{'type': 'exon', 'start': 4, 'end': 7}]},
            {'row_key': 'b', 'aligned': 'ACTTGT--', 'features': []},
            {'row_key': 'c', 'aligned': 'A---GTTA', 'features': [{'type': 'exon', 'start': 0, 'end': 7}]},
        ]}
        out = project(alignment, ['c', 'a', 'zz'])
        self.assertEqual([r['row_key'] for r in out['rows']], ['c', 'a'])
        self.assertEqual([r['aligned'] for r in out['rows']], ['A-GTTA', 'ACGT-A'])
        self.assertEqual(out['rows'][1]['features'], [{'type': 'exon', 'start': 2, 'end': 5}])
        self.assertEqual(out['rows'][0]['features'], [{'type': 'exon', 'start': 0, 'end': 5}])
        self.assertEqual(out['missing'], ['zz'])
        self.assertEqual(out['alignment_length'], 6)


class StoreTests(unittest.TestCase):
    def _alignment(self, prepared, name_hint='x'):
        def fake_align(ordered, on_progress, cancelled):
            width = max(len(s) for _, s in ordered)
            return {k: s + '-' * (width - len(s)) for k, s in ordered}, 'test'
        return align(prepared, prepared[0]['_params'], fake_align)

    def _rows(self, keys, params):
        rows = []
        for i, key in enumerate(keys):
            t = transcript('+' if i % 2 == 0 else '-')
            row = prepare_row(key, t, fetch, params, {'assembly': 'GCA_1'})
            row['_params'] = params
            rows.append(row)
        return rows

    def test_find_covering_prefers_the_smallest_superset_and_projection_serves_subsets(self):
        params = settings_params({'region': 'exons'})
        with tempfile.TemporaryDirectory() as root:
            store = AlignmentStore(Path(root))
            big = self._rows(['A:t1', 'B:t2', 'C:t3', 'D:t4'], params)
            small = big[:3]
            big_stem = store.save(self._alignment(big), 'tree big', source='gene_trees', auto=True)
            small_stem = store.save(self._alignment(small), 'tree small', source='gene_trees', auto=True)
            self.assertEqual(store.find_covering([r['signature'] for r in big[:2]]), small_stem)
            self.assertEqual(store.find_covering([r['signature'] for r in big]), big_stem)
            loaded = store.load(big_stem)
            sub = project(loaded, ['D:t4', 'A:t1'])
            self.assertEqual([r['row_key'] for r in sub['rows']], ['D:t4', 'A:t1'])
            # Saving the same rows again lands in the same file.
            self.assertEqual(store.save(self._alignment(big), 'tree big', source='gene_trees', auto=True), big_stem)

    def test_changed_sequence_or_settings_never_match(self):
        with tempfile.TemporaryDirectory() as root:
            store = AlignmentStore(Path(root))
            params = settings_params({'region': 'exons'})
            rows = self._rows(['A:t1', 'B:t2'], params)
            store.save(self._alignment(rows), 'pair', source='gene_trees', auto=True)
            other = self._rows(['A:t1', 'B:t2'], settings_params({'region': 'exons', 'intron_edge': 20}))
            self.assertIsNone(store.find_covering([r['signature'] for r in other]))
            genomic = self._rows(['A:t1', 'B:t2'], settings_params({'region': 'genomic'}))
            self.assertIsNone(store.find_covering([r['signature'] for r in genomic]))

    def test_version_one_files_are_ignored(self):
        with tempfile.TemporaryDirectory() as root:
            (Path(root) / 'old.json').write_text('{"version": "1", "genomes": [{"genome_key": "g"}]}')
            (Path(root) / 'old.fasta').write_text('>g\nACGT\n')
            store = AlignmentStore(Path(root))
            self.assertIsNone(store.find_covering(['anything']))

    def test_estimate_levels(self):
        self.assertEqual(estimate([{'raw_length': 3000}] * 20)['level'], 'ok')
        self.assertEqual(estimate([{'raw_length': 3000}] * 100)['level'], 'large')
        self.assertEqual(estimate([{'raw_length': 60_000}] * 3)['level'], 'large')
        self.assertEqual(estimate([{'raw_length': 300_000}] * 2)['level'], 'very_large')


if __name__ == '__main__':
    unittest.main()


class MsaViewSharingTests(unittest.TestCase):
    """The MSA view and the Gene Trees view find each other's alignments."""

    def _items(self, main):
        items = []
        for i, strand in enumerate('+-'):
            t = transcript(strand)
            simple = main.SimpleTranscript(
                f'tx{i}', '1', t['start'], t['end'], strand,
                [main.SimpleFeature('exon', e['start'], e['end'], strand) for e in t['exons']],
                [main.SimpleFeature('CDS', c['start'], c['end'], strand) for c in t['cds']],
                [main.SimpleFeature(u['feature_type'], u['start'], u['end'], strand) for u in t['utrs']])
            # The MSA view's default window: the gene (here 950-2200), with oriented flanks.
            start, end = main._interval_window_with_oriented_flanks(950, 2200, strand, 100, 60)
            seq, _, _ = fetch('1', start, end)
            raw = seq if strand == '+' else reverse_complement(seq)
            items.append({'genome': f'G{i}', 'genome_key': f'G{i}', 'tag': f'g{i}', 'query': f'gene{i}', 'transcript_id': f'tx{i}',
                          'tx': simple, 'window_start': start, 'window_end': end, 'fetched_chrom': '1', 'raw_seq': raw.lower(),
                          'flank_5_bp': 100, 'flank_3_bp': 60, 'overlay_annotation': True, 'use_gene_boundaries': True})
        return items

    def test_an_msa_row_and_a_gene_tree_row_of_one_transcript_share_a_signature(self):
        import main
        from dataclasses import asdict
        from unittest.mock import patch
        items = self._items(main)
        with patch.object(main, '_resolve_browse_genome_context', lambda g: {'species': {'assembly': f'GCA_{g}'}}):
            shared = main._msa_shared_rows(items)
        for item, row in zip(items, shared):
            tx = {**asdict(item['tx']), 'id': item['transcript_id'], 'gene_start': 950, 'gene_end': 2200}
            tree_row = prepare_row(row['row_key'], tx, fetch, settings_params({'region': 'genomic', 'flank_5': 100, 'flank_3': 60}))
            self.assertEqual(tree_row['signature'], row['signature'])

    def test_an_msa_run_is_saved_and_reused(self):
        import main
        from unittest.mock import patch
        items = self._items(main)
        with patch.object(main, '_resolve_browse_genome_context', lambda g: {'species': {'assembly': f'GCA_{g}'}}):
            shared = main._msa_shared_rows(items)
        width = max(len(i['raw_seq']) for i in items)
        ordered = [(item, gapped(item['raw_seq'].upper()).ljust(width + 400, '-')) for item in items]
        with tempfile.TemporaryDirectory() as root:
            store = AlignmentStore(Path(root))
            main._msa_save_shared(store, items, shared, ordered, 'test', '')
            stem = store.find_covering(r['signature'] for r in shared)
            self.assertTrue(stem and stem.startswith('msa_g0_g1'))
            result = main._msa_result_from_store(store, stem, items, shared, items, [], [], 'balanced')
        self.assertTrue(result.cache_hit)
        self.assertEqual([r.transcript_id for r in result.rows], ['tx0', 'tx1'])
        for (item, aligned), row in zip(ordered, result.rows):
            self.assertEqual(row.aligned_sequence.replace('-', ''), item['raw_seq'].upper())
            self.assertTrue(any(f.type == 'cds' for f in row.features))


class MsaTrimTests(unittest.TestCase):
    """The MSA view keeps only what the selected transcripts (and their flanks) reach."""

    def test_a_gene_running_past_its_selected_transcript_is_cut_back(self):
        import main
        tx = lambda strand, start, end: main.SimpleTranscript('t', '1', start, end, strand, [main.SimpleFeature('exon', start, end, strand)], [], [])  # noqa: E731
        # Row A: a gene window 101-160 whose selected transcript is 111-120 (flanks 5 and 3,
        # so 106-123 is kept); row B: a window that is its transcript plus flanks.
        a_seq, b_seq = 'A' * 60, 'C' * 20
        rows = [
            main.MultiAlignedRow(genome='A', genome_key='A', transcript_id='t', chrom='1', genomic_start=101, genomic_end=160, strand='+',
                                 aligned_sequence=a_seq, raw_length=60, flank_5_bp=5, flank_3_bp=3,
                                 features=[main.Feature(type='exon', start=10, end=19, original_start=111, original_end=120),
                                           main.Feature(type='exon', start=40, end=50, original_start=141, original_end=151)]),
            main.MultiAlignedRow(genome='B', genome_key='B', transcript_id='u', chrom='2', genomic_start=500, genomic_end=519, strand='-',
                                 aligned_sequence='-' * 3 + b_seq + '-' * 37, raw_length=20, flank_5_bp=0, flank_3_bp=0),
        ]
        result = main.MultiAlignmentResult(timestamp='', alignment_length=60, requested_count=2, included_count=2, profile='balanced',
                                           strategy='x', consensus='', rows=rows)
        items = [{'genome_key': 'A', 'transcript_id': 't', 'tx': tx('+', 111, 120)},
                 {'genome_key': 'B', 'transcript_id': 'u', 'tx': tx('-', 500, 519)}]
        out = main._trim_multi_to_transcripts(result, items)
        # A keeps 106-123 (columns 5-22); B reaches columns 3-22: the union is 3-22.
        self.assertEqual(out.alignment_length, 20)
        a, b = out.rows
        self.assertEqual((a.genomic_start, a.genomic_end, a.raw_length), (104, 123, 20))
        self.assertEqual(b.aligned_sequence, b_seq)
        self.assertEqual([(f.start, f.end) for f in a.features], [(7, 16)])  # the far exon is gone
        self.assertIn('Trimmed', out.warnings[-1])
        # Trimming again changes nothing.
        self.assertEqual(main._trim_multi_to_transcripts(out, items).alignment_length, 20)
