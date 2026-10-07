import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from download_manager import DownloadManager, ENSEMBL_FTP_BASE


class HomologyDownloadDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.pig = 'GCA/000/003/025/6/ensembl/2022_02/'
        self.rat = 'GCA/036/323/735/1/ensembl/2024_03/'
        species = {}
        for key, assembly, release, prefix in [
            ('Sus_scrofa', 'GCA_000003025.6', '2022_02', self.pig),
            ('Rattus_norvegicus', 'GCA_036323735.1', '2024_03', self.rat),
        ]:
            species[key] = {'scientific_name': key.replace('_', ' '), 'taxid': 1, 'assemblies': {
                assembly: {'name': assembly, 'assembly': {'files': {}}, 'genebuild_providers': {
                    'ensembl': {release: {'paths': {'genebuild': {'files': {'annotations': {
                        'genes.gff3.gz': prefix + 'geneset/genes.gff3.gz',
                    }}}}}},
                }},
            }}
        catalog = self.root / 'species.json'
        catalog.write_text(json.dumps({'species': species}))
        self.manager = DownloadManager(catalog, cache_dir=self.root / 'cache')
        self.manager._get_metadata_file_info = Mock(return_value=None)
        self.manager._get_pairwise_alignment_file_infos = Mock(return_value=[])
        self.listings = {
            ENSEMBL_FTP_BASE + self.pig + 'geneset/': ['genes.gff3.gz'],
            ENSEMBL_FTP_BASE + self.pig + 'homology/': ['2024_09_18/', 'md5sum.txt'],
            ENSEMBL_FTP_BASE + self.pig + 'homology/2024_09_18/': ['homology.tsv.gz', 'md5sum.txt'],
            ENSEMBL_FTP_BASE + self.rat + 'geneset/': ['genes.gff3.gz'],
            ENSEMBL_FTP_BASE + self.rat + 'homology/': ['2024_10_28/'],
            ENSEMBL_FTP_BASE + self.rat + 'homology/2024_10_28/': ['homology.tsv.gz'],
        }
        self.listing_patch = patch.object(self.manager, '_fetch_ftp_directory_entries', side_effect=lambda url: self.listings.get(url, []))
        self.entries = self.listing_patch.start()

    def tearDown(self):
        self.listing_patch.stop()
        self.tmp.cleanup()

    def homology(self, availability):
        return next(file for file in availability['dataset_releases'][0]['files'] if file['type'] == 'homology')

    def test_pig_and_rat_catalogue_omissions_are_discovered_in_download_selector(self):
        for species, assembly, prefix, release, date in [
            ('Sus_scrofa', 'GCA_000003025.6', self.pig, '2022_02', '2024_09_18'),
            ('Rattus_norvegicus', 'GCA_036323735.1', self.rat, '2024_03', '2024_10_28'),
        ]:
            with self.subTest(species=species):
                availability = self.manager.get_file_availability(species, assembly, include_directory_listing=True)
                item = self.homology(availability)
                self.assertEqual(item['url'], ENSEMBL_FTP_BASE + prefix + 'homology/' + date + '/homology.tsv.gz')
                self.assertEqual(item['dataset_release_key'], 'ensembl/' + release)
                self.assertEqual(item['dataset_release_date'], release)
                self.assertTrue(item['selected_by_default'])

    def test_homology_only_download_api_also_discovers_missing_catalogue_entries(self):
        files = self.manager.get_download_urls('Sus_scrofa', 'GCA_000003025.6', file_types=['homology'])
        self.assertEqual(len(files), 1)
        self.assertEqual(files[0].type, 'homology')
        self.assertEqual(files[0].dataset_release_key, 'ensembl/2022_02')
        self.assertTrue(files[0].url.endswith('/homology/2024_09_18/homology.tsv.gz'))
        self.assertNotIn(ENSEMBL_FTP_BASE + self.pig + 'geneset/', [call.args[0] for call in self.entries.call_args_list])

    def test_latest_usable_export_replaces_stale_catalogue_without_duplicate_type(self):
        build = self.manager.species_data['Sus_scrofa']['assemblies']['GCA_000003025.6']['genebuild_providers']['ensembl']['2022_02']
        build['paths']['homologies'] = {'files': {'homology_data': {'homology.tsv.gz': self.pig + 'homology/2023_01_01/homology.tsv.gz'}}}
        self.listings[ENSEMBL_FTP_BASE + self.pig + 'homology/'].extend(['2025_12_01/', '../', 'not-an-export/'])
        self.listings[ENSEMBL_FTP_BASE + self.pig + 'homology/2025_12_01/'] = ['md5sum.txt']
        result = self.manager.get_file_availability('Sus_scrofa', 'GCA_000003025.6', include_directory_listing=True)
        homologies = [item for item in result['dataset_releases'][0]['files'] if item['type'] == 'homology']
        self.assertEqual(len(homologies), 1)
        self.assertTrue(homologies[0]['url'].endswith('/homology/2024_09_18/homology.tsv.gz'))
        self.assertNotIn(ENSEMBL_FTP_BASE + self.pig + 'homology/not-an-export/', [call.args[0] for call in self.entries.call_args_list])

    def test_transient_ftp_failure_preserves_catalogue_and_other_files(self):
        build = self.manager.species_data['Sus_scrofa']['assemblies']['GCA_000003025.6']['genebuild_providers']['ensembl']['2022_02']
        catalog_path = self.pig + 'homology/2023_01_01/homology.tsv.gz'
        build['paths']['homologies'] = {'files': {'homology_data': {'homology.tsv.gz': catalog_path}}}
        self.entries.side_effect = OSError('FTP unavailable')
        result = self.manager.get_file_availability('Sus_scrofa', 'GCA_000003025.6', include_directory_listing=True)
        self.assertEqual(self.homology(result)['url'], ENSEMBL_FTP_BASE + catalog_path)
        self.assertIn('gff3', [item['type'] for item in result['dataset_releases'][0]['files']])

    def test_annotation_only_downloads_do_not_probe_homologies(self):
        result = self.manager.get_download_urls('Sus_scrofa', 'GCA_000003025.6', file_types=['gff3'])
        self.assertEqual([item.type for item in result], ['gff3'])
        self.entries.assert_not_called()

    def test_live_listings_are_cached_and_root_level_tsv_is_supported(self):
        self.listing_patch.stop()
        def response(url, *args, **kwargs):
            payload = Mock()
            payload.text = '<a href="homology.tsv.gz">homology.tsv.gz</a>' if url.endswith('/homology/') else '<a href="genes.gff3.gz">genes.gff3.gz</a>'
            return payload
        with patch('download_manager.get_with_validated_redirects', side_effect=response) as fetch:
            first = self.manager.get_file_availability('Sus_scrofa', 'GCA_000003025.6', include_directory_listing=True)
            second = self.manager.get_file_availability('Sus_scrofa', 'GCA_000003025.6', include_directory_listing=True)
            self.assertEqual(fetch.call_count, 2)
        self.assertEqual(self.homology(first)['url'], ENSEMBL_FTP_BASE + self.pig + 'homology/homology.tsv.gz')
        self.assertEqual(first, second)

