import asyncio
import csv
import gzip
import json
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from homology_search import HomologySearchStore, row_rank

COLUMNS = ['ref_species', 'ref_assembly', 'query_species', 'query_assembly',
           'ref_gene_stable_id', 'ref_gene_name', 'query_gene_stable_id', 'query_gene_name',
           'homology_type', 'query_perc_id', 'query_perc_cov', 'custom_column']


def hit(query_id='M1', query_name='Brca2', ref_id='H1', ref_name='BRCA2',
        kind='homolog_rbbh', identity='90', coverage='100', assembly='GRCh38', species='homo_sapiens'):
    return dict(zip(COLUMNS, [species, assembly, 'mus_musculus', 'GRCm39', ref_id, ref_name,
                              query_id, query_name, kind, identity, coverage, 'original evidence']))


def write_tsv(path, rows):
    opener = gzip.open if path.suffix == '.gz' else open
    with opener(path, 'wt', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=COLUMNS, delimiter='\t')
        writer.writeheader()
        writer.writerows(rows)


class HomologyStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.path = self.root / 'mouse.tsv'
        self.rows = [hit(), hit(), hit(ref_id='H2', kind='homolog_bbh', identity='99'),
                     hit(ref_id='D1', ref_name='BRCA2', species='canis_lupus', assembly='Dog1'),
                     hit(query_id='M2', query_name='Other', ref_id='H1', identity='85'),
                     hit(query_id='M2', query_name='Other', ref_id='D2', ref_name='X', species='canis_lupus', assembly='Dog1'),
                     hit(query_id='M3', query_name='Brca2like', ref_id='H3', ref_name='Other')]
        write_tsv(self.path, self.rows)
        self.store = HomologySearchStore(self.root / 'indexes')

    def tearDown(self):
        self.tmp.cleanup()

    def test_search_either_endpoint_then_expand_local_genes_once(self):
        result = self.store.search(self.path, 'h1')
        self.assertEqual(result['matched_by'], 'exact')
        self.assertEqual([gene['id'] for gene in result['resolved_genes']], ['M1', 'M2'])
        self.assertEqual(result['total_rows'], 6)
        self.assertIn('D2', [group['gene_id'] for group in result['evidence']])
        self.assertNotIn('M3', [gene['id'] for gene in result['resolved_genes']])
        self.assertEqual(result['resolved_genes'][0]['provenance'][0]['endpoint'], 'ref')

    def test_exact_on_either_end_precedes_partial_on_query_end(self):
        write_tsv(self.path, [hit(query_name='ALPHAlike', ref_name='Beta'), hit(query_id='M2', query_name='Other', ref_name='ALPHA')])
        result = self.store.search(self.path, 'alpha')
        self.assertEqual(result['matched_by'], 'exact')
        self.assertEqual([gene['id'] for gene in result['resolved_genes']], ['M2'])

    def test_case_insensitive_symbols_and_partial_label(self):
        self.assertEqual(self.store.search(self.path, 'bRcA2')['matched_by'], 'exact')
        result = self.store.search(self.path, 'brca')
        self.assertEqual(result['matched_by'], 'contains')
        self.assertEqual(len(result['resolved_genes']), 3)
        self.assertEqual(self.store.search(self.path, 'no-match')['matched_by'], 'none')

    def test_custom_ids_and_sql_wildcards_are_literal(self):
        write_tsv(self.path, [hit(query_id='custom_%_1', query_name=''), hit(query_id='custom_AB_1', query_name='')])
        self.assertEqual(self.store.search(self.path, '%')['resolved_genes'][0]['id'], 'custom_%_1')
        self.assertEqual(len(self.store.search(self.path, '%')['resolved_genes']), 1)

    def test_rank_tiers_ties_and_duplicates(self):
        result = self.store.search(self.path, 'M1')
        h1 = next(group for group in result['evidence'] if group['gene_id'] == 'H1')
        h2 = next(group for group in result['evidence'] if group['gene_id'] == 'H2')
        self.assertEqual(h1['row_count'], 2)
        self.assertTrue(h1['variants'][0]['best'])
        self.assertFalse(h2['variants'][0]['best'])
        write_tsv(self.path, [hit(ref_id='H1'), hit(ref_id='H2')])
        self.assertTrue(all(group['variants'][0]['best'] for group in self.store.search(self.path, 'M1')['evidence']))

    def test_filters_do_not_rerank(self):
        result = self.store.search(self.path, 'M1', filters={'types': ['homolog_bbh']})
        self.assertEqual(result['filtered_rows'], 1)
        self.assertFalse(result['rows'][0]['best'])
        self.assertEqual(len(result['evidence']), 3)
        self.assertEqual(self.store.search(self.path, 'M1', filters={'types': []})['filtered_rows'], 0)

    def test_missing_scores_are_unknown_and_sort_below_scored(self):
        write_tsv(self.path, [hit(identity='', coverage=''), hit(ref_id='H2', identity='NaN', coverage='inf'),
                              hit(ref_id='H3', kind='homolog_bbh', identity='95')])
        result = self.store.search(self.path, 'M1', filters={'min_identity': 0})
        self.assertEqual(result['filtered_rows'], 1)
        self.assertIsNone(result['evidence'][0]['variants'][0]['identity'])
        self.assertGreater(row_rank(hit()), row_rank(hit(kind='homolog_bbh', identity='100')))

    def test_pagination_and_drill_do_not_truncate_summary(self):
        first = self.store.search(self.path, 'H1', limit=1)
        second = self.store.search(self.path, 'H1', limit=1, offset=1)
        self.assertEqual(first['evidence'], second['evidence'])
        self.assertEqual(first['total_rows'], second['total_rows'])
        self.assertNotEqual(first['rows'][0]['row_id'], second['rows'][0]['row_id'])
        group = first['evidence'][0]
        drill = self.store.search(self.path, 'H1', query_gene_id='M1', target_key=group['target_key'])
        self.assertEqual(drill['filtered_rows'], 2)
        self.assertEqual(drill['total_rows'], 6)
        self.assertEqual(drill['rows'][0]['values']['custom_column'], 'original evidence')
        self.assertIsNone(self.store.search(self.path, 'M1', include_evidence=False)['evidence'])

    def test_focus_locates_a_later_page_without_narrowing_results(self):
        write_tsv(self.path, [hit(ref_id=f'H{i:03}', ref_name='Other', identity=str(100-i/5)) for i in range(245)])
        full = self.store.search(self.path, 'M1', limit=500)
        target = full['rows'][173]
        focused = self.store.search(self.path, 'M1', focus_query_gene_id='m1', focus_target_key=target['target_key'])
        self.assertEqual(focused['offset'], 100)
        self.assertEqual(focused['focus_row_id'], target['row_id'])
        self.assertEqual(focused['filtered_rows'], 245)
        self.assertEqual(focused['total_rows'], 245)
        self.assertEqual(focused['rows'], full['rows'][100:200])
        self.assertEqual(focused['evidence'], full['evidence'])

    def test_focus_respects_sorting_and_keeps_other_local_genes(self):
        for sort in ['score', 'ref_gene_stable_id', 'ref_gene_name', 'query_perc_id', 'query_perc_cov']:
            for direction in ['asc', 'desc']:
                with self.subTest(sort=sort, direction=direction):
                    full = self.store.search(self.path, 'H1', limit=500, sort_key=sort, direction=direction)
                    position, target = next((i, row) for i, row in enumerate(full['rows']) if row['values']['ref_gene_stable_id'] == 'D2')
                    focused = self.store.search(self.path, 'H1', limit=2, sort_key=sort, direction=direction,
                                                focus_query_gene_id='M2', focus_target_key=target['target_key'])
                    self.assertEqual(focused['offset'], position // 2 * 2)
                    self.assertEqual(focused['focus_row_id'], target['row_id'])
                    self.assertEqual(focused['filtered_rows'], full['filtered_rows'])
                    self.assertEqual(len(focused['resolved_genes']), 2)

    def test_focus_hidden_by_filters_keeps_the_full_filtered_table(self):
        full = self.store.search(self.path, 'M1')
        target = next(row for row in full['rows'] if row['values']['ref_gene_stable_id'] == 'H1')
        result = self.store.search(self.path, 'M1', filters={'types': ['homolog_bbh']},
                                   focus_query_gene_id='M1', focus_target_key=target['target_key'])
        self.assertIsNone(result['focus_row_id'])
        self.assertEqual(result['filtered_rows'], 1)
        self.assertEqual(result['rows'][0]['values']['ref_gene_stable_id'], 'H2')

    def test_aliases_assembly_separation_and_incomplete_identity(self):
        write_tsv(self.path, [hit(), hit(assembly='GRCh38.p14'), hit(assembly='Other'),
                              hit(ref_id='', ref_name='Same'), hit(ref_id='', ref_name='Same')])
        groups = self.store.search(self.path, 'M1')['evidence']
        self.assertEqual(len(groups), 4)
        self.assertEqual(groups[0]['row_count'], 2)
        self.assertEqual(sum(group['incomplete'] for group in groups), 2)

    def test_gzip_and_capitalized_columns(self):
        path = self.root / 'mouse.tsv.gz'
        write_tsv(path, self.rows)
        self.assertEqual(self.store.search(path, 'H1')['total_rows'], 6)
        self.path.write_text(self.path.read_text().replace('query_gene_stable_id', 'QUERY_GENE_STABLE_ID'))
        self.assertEqual(self.store.search(self.path, 'M1')['resolved_genes'][0]['id'], 'M1')

    def test_unsupported_header_is_actionable(self):
        self.path.write_text('A\tB\n1\t2\n')
        with self.assertRaisesRegex(ValueError, 'header with query_gene_stable_id'):
            self.store.search(self.path, '1')
        self.assertFalse(list((self.root / 'indexes').glob('*.sqlite')))

    def test_reuse_change_invalidation_and_parallel_builds(self):
        with patch.object(self.store, '_build', wraps=self.store._build) as build:
            with ThreadPoolExecutor(max_workers=3) as pool:
                results = list(pool.map(lambda _: self.store.search(self.path, 'M1'), range(3)))
            self.assertEqual(build.call_count, 1)
            self.assertEqual(len({result['source_token'] for result in results}), 1)
            write_tsv(self.path, self.rows + [hit(ref_id='H4')])
            updated = self.store.search(self.path, 'M1')
            self.assertNotEqual(updated['source_token'], results[0]['source_token'])
            self.assertEqual(build.call_count, 2)


class HomologyApiTests(unittest.TestCase):
    def setUp(self):
        HomologyStoreTests.setUp(self)
        import main
        import routes.homology  # noqa: E402
        import config_store  # noqa: E402
        self.main = main
        self.homology = routes.homology
        self.genome_key = 'ensembl::Mus_musculus::GCA_1::dataset::ensembl/2025_12'
        self.genome = {'provider': 'ensembl', 'species_key': 'Mus_musculus', 'assembly': 'GCA_1',
                       'dataset_release_key': 'ensembl/2025_12', 'files': {'homology': str(self.path)}}
        self.config = {'active_species': [self.genome]}
        self.config_patch = patch.object(config_store, 'load_config', return_value=self.config)
        self.store_patch = patch.object(routes.homology, 'homology_search_store', self.store)
        self.config_patch.start()
        self.store_patch.start()

    def tearDown(self):
        self.store_patch.stop()
        self.config_patch.stop()
        HomologyStoreTests.tearDown(self)

    def test_api_keys_access_filters_and_sources(self):
        main = self.main
        result = self.homology.search_homology_table(self.homology.HomologySearchRequest(genome_key=self.genome_key, gene_query='H1'))
        self.assertEqual(result['genome_key'], self.genome_key)
        self.assertEqual(self.homology.homology_search_sources()['sources'][self.genome_key]['source_token'], result['source_token'])
        target = next(row for row in result['rows'] if row['values']['ref_gene_stable_id'] == 'D2')
        focused = self.homology.search_homology_table(self.homology.HomologySearchRequest(genome_key=self.genome_key, gene_query='H1', limit=2,
                                                                       focus_query_gene_id='M2', focus_target_key=target['target_key']))
        self.assertEqual(focused['focus_row_id'], target['row_id'])
        self.assertEqual(focused['filtered_rows'], result['filtered_rows'])
        with self.assertRaises(main.HTTPException) as error:
            self.homology.search_homology_table(self.homology.HomologySearchRequest(genome_key=self.genome_key.replace('2025_12', '2024_10'), gene_query='H1'))
        self.assertEqual(error.exception.status_code, 404)
        with self.assertRaises(main.HTTPException):
            self.homology.search_homology_table(self.homology.HomologySearchRequest(genome_key=self.genome_key, gene_query='H1', min_identity=float('nan')))

    def test_no_file_and_unconfigured_path(self):
        main = self.main
        self.genome['files']['homology'] = ''
        with self.assertRaises(main.HTTPException) as error:
            self.homology.search_homology_table(self.homology.HomologySearchRequest(genome_key=self.genome_key, gene_query='H1'))
        self.assertEqual(error.exception.status_code, 404)
        self.assertEqual(self.homology.homology_search_sources()['sources'][self.genome_key]['status'], 'missing')
        with self.assertRaises(main.HTTPException):
            self.homology._resolve_allowed_homology_path(str(self.path))

    def test_legacy_endpoint_contract_remains_unchanged(self):
        legacy = asyncio.run(self.homology.query_homology_table(path=str(self.path), gene_query='BRCA2'))
        self.assertEqual(legacy['match_scope'], 'query')
        self.assertEqual(legacy['matched_by'], 'exact')
        self.assertEqual(legacy['total_matches'], 4)
        self.assertIn('custom_column', legacy['columns'])
        self.assertNotIn('resolved_genes', legacy)

    def test_completed_download_is_discovered_without_resaving_genome(self):
        self.config['output_dir'] = str(self.root)
        self.genome['files'] = {'homology': ''}
        directory = self.root / 'local_data' / 'Mus_musculus' / 'GCA_1' / 'datasets' / 'ensembl' / '2025_12'
        directory.mkdir(parents=True)
        downloaded = directory / 'GCA_1.homology.tsv.gz'
        self.assertEqual(self.homology.homology_search_sources()['sources'][self.genome_key]['status'], 'missing')
        write_tsv(downloaded, self.rows)
        source = self.homology.homology_search_sources()['sources'][self.genome_key]
        self.assertEqual(source['status'], 'ready')
        self.assertEqual(source['path'], str(downloaded.resolve()))
        result = self.homology.search_homology_table(self.homology.HomologySearchRequest(genome_key=self.genome_key, gene_query='Brca2'))
        self.assertEqual(result['total_rows'], 6)
        self.assertEqual(result['source_token'], source['source_token'])
        self.assertEqual(self.genome['files']['homology'], '')
        downloaded.unlink()
        other = directory.parent / '2024_10'
        other.mkdir()
        write_tsv(other / downloaded.name, self.rows)
        self.assertEqual(self.homology.homology_search_sources()['sources'][self.genome_key]['status'], 'missing')

    def test_discovery_handles_legacy_paths_and_annotation_only_release_records(self):
        self.config['output_dir'] = str(self.root)
        self.genome.pop('dataset_release_key')
        directory = self.root / 'local_data' / 'Mus_musculus' / 'GCA_1'
        directory.mkdir(parents=True)
        downloaded = directory / 'GCA_1.homology.tsv'
        write_tsv(downloaded, self.rows)
        self.genome['files'] = {'homology': ''}
        self.assertEqual(self.homology._homology_source_path(self.genome, self.config), str(downloaded.resolve()))
        release = directory / 'datasets' / 'ensembl' / '2025_12'
        release.mkdir(parents=True)
        write_tsv(release / downloaded.name, self.rows)
        self.genome['files']['gff3'] = str(release / 'GCA_1.gff3.gz')
        self.assertEqual(self.homology._homology_source_path(self.genome, self.config), str((release / downloaded.name).resolve()))
        self.genome['dataset_release_key'] = 'ensembl/../../outside'
        self.assertEqual(self.homology._homology_source_path(self.genome, self.config), '')
