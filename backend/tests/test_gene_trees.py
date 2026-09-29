import json
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import FastAPI
from fastapi.testclient import TestClient

from gene_trees import create_router, model, taxonomy
from gene_trees.linking import Linker, build_protein_map
from gene_trees.parsers import TreeParseError, iter_source_trees, parse_newick, parse_text, stream_newick_texts
from gene_trees.store import GeneTreeStore

FIXTURES = Path(__file__).resolve().parent / 'fixtures' / 'gene_trees'


def leaves(nodes):
    return [n for n in nodes if n.get('leaf')]


def by_label(nodes, label):
    return next(n for n in nodes if n.get('leaf') and n['leaf']['label'] == label)


def make_index(path, genes, transcripts=()):
    conn = sqlite3.connect(path)
    conn.execute('CREATE TABLE genes (id TEXT PRIMARY KEY, chrom TEXT, start INTEGER, end INTEGER, strand TEXT, '
                 "name TEXT, biotype TEXT DEFAULT '', description TEXT DEFAULT '', version TEXT DEFAULT '')")
    conn.execute('CREATE TABLE transcripts (id TEXT PRIMARY KEY, chrom TEXT, start INTEGER, end INTEGER, strand TEXT, '
                 'parent_gene_id TEXT, data JSON, is_canonical INTEGER DEFAULT 0)')
    conn.executemany('INSERT INTO genes (id, chrom, start, end, strand, name, biotype) VALUES (?, ?, ?, ?, ?, ?, ?)',
                     [(g, '1', 100, 900, '+', name, 'protein_coding') for g, name in genes])
    conn.executemany('INSERT INTO transcripts (id, chrom, start, end, strand, parent_gene_id) VALUES (?, ?, ?, ?, ?, ?)',
                     [(t, '1', 100, 900, '+', g) for t, g in transcripts])
    conn.commit()
    conn.close()


class GenomeFixture:
    """Three fake local genomes: human (with a GFF for proteins), mouse and a fox whose IDs differ."""

    def __init__(self, root: Path):
        human_index = root / 'human.index.db'
        make_index(human_index, [('ENSG00000139618', 'BRCA2'), ('ENSG00000000233', 'ARF5'), ('ENSG00000187634', 'SAMD11')],
                   [('ENST00000380152', 'ENSG00000139618'), ('ENST00000000233', 'ENSG00000000233')])
        human_gff = root / 'human.gff3'
        human_gff.write_text(
            '##gff-version 3\n'
            '13\tensembl\tCDS\t1\t9\t.\t+\t0\tID=CDS:ENSP00000369497;Parent=transcript:ENST00000380152;protein_id=ENSP00000369497\n'
            '7\tensembl\tCDS\t1\t9\t.\t+\t0\tID=CDS:ENSP00000000233;Parent=transcript:ENST00000000233;protein_id=ENSP00000000233\n')
        mouse_index = root / 'mouse.index.db'
        make_index(mouse_index, [('ENSMUSG00000041147', 'Brca2')])
        fox_index = root / 'fox.index.db'
        make_index(fox_index, [('ENSVVUG00015027449', 'BRCA2')])
        self.genomes = [
            {'assembly': 'GCA_000001405.29', 'species_key': 'Homo_sapiens', 'scientific_name': 'Homo sapiens',
             'provider': 'ensembl', 'index_path': str(human_index), 'gff_path': str(human_gff)},
            {'assembly': 'GCA_000001635.9', 'species_key': 'Mus_musculus', 'scientific_name': 'Mus musculus',
             'provider': 'ensembl', 'index_path': str(mouse_index), 'gff_path': ''},
            {'assembly': 'GCA_964106925.2', 'species_key': 'Vulpes_vulpes', 'scientific_name': 'Vulpes vulpes',
             'provider': 'ensembl', 'index_path': str(fox_index), 'gff_path': ''},
        ]


def wait_for_links(linker, nodes, **kwargs):
    deadline = time.time() + 10
    while True:
        result = linker.link_tree(nodes, **kwargs)
        if not result['pending'] or time.time() > deadline:
            return result
        time.sleep(0.05)


class ParserTests(unittest.TestCase):
    def test_nhx_events_taxa_and_leaf_tags(self):
        fmt, trees = parse_text((FIXTURES / 'small.nhx').read_text())
        self.assertEqual(fmt, 'nhx')
        nodes = trees[0].nodes
        self.assertEqual(len(leaves(nodes)), 6)
        root = nodes[0]
        self.assertEqual(root['taxon']['name'], 'Euteleostomi')
        self.assertEqual(root['event'], 'speciation')
        events = [n['event'] for n in nodes if n['children']]
        self.assertIn('duplication', events)
        self.assertIn('dubious', events)
        homininae = next(n for n in nodes if (n.get('taxon') or {}).get('name') == 'Homininae')
        self.assertEqual(homininae['support'], 100)
        human = by_label(nodes, 'ENSP00000369497_Hsap')
        self.assertEqual(human['leaf']['gene_id'], 'ENSG00000139618')
        self.assertEqual(human['leaf']['taxid'], 9606)
        self.assertAlmostEqual(human['branch_length'], 0.0019)

    def test_multiple_trees_quoting_support_and_internal_names(self):
        fmt, trees = parse_text((FIXTURES / 'multi.nwk').read_text(), 'multi')
        self.assertEqual(fmt, 'newick')
        self.assertEqual([t.name for t in trees], ['multi 1', 'multi 2'])
        first = trees[0].nodes
        self.assertEqual(sorted(n['leaf']['label'] for n in leaves(first)), ['A', 'B', 'C d'])
        self.assertEqual(next(n for n in first if n['children'] and n['parent'] == 0)['support'], 90)
        second = trees[1].nodes
        self.assertEqual(next(n for n in second if n['children'] and n['parent'] == 0)['taxon']['name'], 'Clade one')

    def test_malformed_newick_is_rejected(self):
        for bad in ['((A,B);', '(A,B));', '(A,B):x;']:
            with self.assertRaises(TreeParseError, msg=bad):
                parse_newick(bad)

    def test_deep_caterpillar_does_not_recurse(self):
        depth = 5000
        text = '(' * depth + 'A' + ''.join(f',L{i})' for i in range(depth)) + ';'
        tree = parse_newick(text)[0]
        self.assertEqual(len(leaves(tree.nodes)), depth + 1)
        self.assertTrue(model.to_newick(tree.nodes).startswith('((((('))

    def test_newick_round_trip(self):
        text = "((A:1,B:2):0.5,'C d':3);"
        tree = parse_newick(text)[0]
        self.assertEqual(model.to_newick(tree.nodes), text)
        again = parse_newick(model.to_newick(tree.nodes, nhx=True))[0]
        self.assertEqual([n['leaf']['label'] for n in leaves(again.nodes)], ['A', 'B', 'C d'])

    def test_ensembl_json_matches_compara_statistics(self):
        fmt, trees = parse_text((FIXTURES / 'brca2_ensembl.json').read_text())
        self.assertEqual(fmt, 'ensembl_json')
        tree = trees[0]
        stats = model.tree_stats(tree.nodes)
        # The same counts the Ensembl gene tree page reports for this tree.
        self.assertEqual((stats['genes'], stats['speciation'], stats['duplication'], stats['dubious'], stats['gene_split']),
                         (175, 169, 2, 2, 1))
        self.assertEqual(tree.nodes[0]['taxon']['name'], 'Vertebrata')
        self.assertEqual(tree.nodes[0]['taxon']['mya'], 563)
        human = next(n for n in tree.nodes if n.get('leaf') and n['leaf']['species'] == 'Homo sapiens')
        self.assertEqual(human['leaf']['gene_id'], 'ENSG00000139618')
        self.assertEqual(human['leaf']['protein_id'], 'ENSP00000369497')
        self.assertEqual(human['leaf']['symbol'], 'BRCA2')
        self.assertEqual(human['leaf']['location'], '13:32315086-32400268')

    def test_streaming_split_respects_quotes_and_comments(self):
        import io
        text = "(A,B);\n('x;y',C[&&NHX:S=a;b]);(D)"
        self.assertEqual(list(stream_newick_texts(io.StringIO(text))), ['(A,B);', "('x;y',C[&&NHX:S=a;b]);", '(D)'])

    def test_directory_of_orthofinder_trees(self):
        found = list(iter_source_trees(FIXTURES / 'orthofinder' / 'Gene_Trees'))
        self.assertEqual([tree.name for _, tree in found], ['OG0000001', 'OG0000002'])


class LabelTests(unittest.TestCase):
    def test_label_shapes(self):
        cases = {
            'Homo_sapiens_ENSP00000369497': ('Homo sapiens', 'ENSP00000369497', 'protein'),
            'ENSP00000369497_Hsap': ('Hsap', 'ENSP00000369497', 'protein'),
            'Homo_sapiens.GRCh38.pep.all_ENSP00000369497.3': ('Homo sapiens', 'ENSP00000369497.3', 'protein'),
            'Mus_musculus_ENSMUSG00000041147': ('Mus musculus', 'ENSMUSG00000041147', 'gene'),
            'Homo_sapiens_NP_000050.3': ('Homo sapiens', 'NP_000050.3', 'protein'),
            'Danio_rerio_brca2': ('Danio rerio', 'brca2', None),
            'geneX': (None, 'geneX', None),
        }
        for label, expected in cases.items():
            got = model.interpret_leaf_label(label)
            self.assertEqual((got['species'], got['id'], got['kind']), expected, label)

    def test_custom_pattern(self):
        got = model.interpret_leaf_label('HUMAN|P51587', r'(?P<species>[A-Z]+)\|(?P<id>\w+)')
        self.assertEqual((got['species'], got['id']), ('HUMAN', 'P51587'))

    def test_strip_version_only_touches_stable_ids(self):
        self.assertEqual(model.strip_version('ENSG00000139618.17'), 'ENSG00000139618')
        self.assertEqual(model.strip_version('F55A12.1'), 'F55A12.1')


class TaxonomyTests(unittest.TestCase):
    def test_lca_labels_and_inferred_events(self):
        tree = parse_newick((FIXTURES / 'orthofinder' / 'Gene_Trees' / 'OG0000001_tree.txt').read_text())[0]
        model.interpret_leaves(tree.nodes)
        taxonomy.annotate(tree.nodes)
        human_mouse = tree.nodes[tree.nodes[0]['children'][0]]
        self.assertEqual(human_mouse['taxon']['name'], 'Euarchontoglires')
        self.assertTrue(human_mouse['taxon']['inferred'])
        self.assertEqual(human_mouse['event'], 'speciation')
        self.assertTrue(human_mouse['event_inferred'])

    def test_a_clade_with_an_unknown_species_is_not_named_after_the_known_one(self):
        tree = parse_newick((FIXTURES / 'orthofinder' / 'Gene_Trees' / 'OG0000001_tree.txt').read_text())[0]
        model.interpret_leaves(tree.nodes)
        taxonomy.annotate(tree.nodes)
        fish_and_unknown = tree.nodes[tree.nodes[0]['children'][1]]
        self.assertIsNone(fish_and_unknown.get('taxon'))
        # The root still has two known lineages to go on, and says it is partial.
        self.assertTrue(tree.nodes[0]['taxon']['partial'])

    def test_paralogs_are_inferred_duplications(self):
        tree = parse_newick((FIXTURES / 'orthofinder' / 'Gene_Trees' / 'OG0000002_tree.txt').read_text())[0]
        model.interpret_leaves(tree.nodes)
        taxonomy.annotate(tree.nodes)
        paralogs = tree.nodes[tree.nodes[0]['children'][0]]
        self.assertEqual(paralogs['event'], 'duplication')
        self.assertEqual(paralogs['taxon']['name'], 'Homo sapiens')

    def test_source_events_are_not_overwritten(self):
        tree = parse_text((FIXTURES / 'small.nhx').read_text())[1][0]
        taxonomy.annotate(tree.nodes)
        self.assertFalse(any(n.get('event_inferred') for n in tree.nodes))


class LinkingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.fixture = GenomeFixture(self.root)
        self.linker = Linker(lambda: self.fixture.genomes, self.root / 'cache')

    def tearDown(self):
        self.linker.proteins.wait()
        self.temp.cleanup()

    def test_ensembl_tree_links_by_id_taxid_and_symbol(self):
        tree = parse_text((FIXTURES / 'brca2_ensembl.json').read_text())[1][0]
        taxonomy.annotate(tree.nodes)
        result = wait_for_links(self.linker, tree.nodes)
        links = result['links']

        def link_for(species):
            node = next(n for n in tree.nodes if n.get('leaf') and n['leaf']['species'] == species)
            return links[str(node['id'])]

        human = link_for('Homo sapiens')
        self.assertEqual((human['status'], human['assembly'], human['matched_by']), ('linked', 'GCA_000001405.29', 'gene_id'))
        mouse = link_for('Mus musculus reference (CL57BL6) strain')
        self.assertEqual((mouse['status'], mouse['assembly'], mouse['via']), ('linked', 'GCA_000001635.9', 'taxid'))
        fox = link_for('Vulpes vulpes')
        self.assertEqual((fox['status'], fox['matched_by'], fox['gene']['id']), ('linked', 'symbol', 'ENSVVUG00015027449'))
        # Other mouse species share the genus but not the genome.
        self.assertEqual(link_for('Mus spretus reference strain')['status'], 'unresolved')
        self.assertEqual(result['summary']['linked'], 3)

    def test_orthofinder_proteins_resolve_through_the_gff(self):
        tree = parse_newick((FIXTURES / 'orthofinder' / 'Gene_Trees' / 'OG0000001_tree.txt').read_text())[0]
        model.interpret_leaves(tree.nodes)
        first = self.linker.link_tree(tree.nodes)
        human_id = str(by_label(tree.nodes, 'Homo_sapiens_ENSP00000369497')['id'])
        self.assertIn(first['links'][human_id]['status'], ('pending', 'linked'))
        result = wait_for_links(self.linker, tree.nodes)
        human = result['links'][human_id]
        self.assertEqual((human['status'], human['matched_by'], human['gene']['id'], human['transcript_id']),
                         ('linked', 'protein_id', 'ENSG00000139618', 'ENST00000380152'))
        # Mouse has no GFF, so its protein cannot be confirmed: the genome is local, the gene is not known.
        mouse = result['links'][str(by_label(tree.nodes, 'Mus_musculus_ENSMUSP00000144150')['id'])]
        self.assertEqual(mouse['status'], 'genome')
        unknown = result['links'][str(by_label(tree.nodes, 'Unknownia_fakeus_XYZ0001')['id'])]
        self.assertEqual(unknown['status'], 'unresolved')

    def test_species_map_and_manual_links_override(self):
        tree = parse_newick('(Hsap_BRCA2,Other_leaf);')[0]
        model.interpret_leaves(tree.nodes, r'(?P<species>[^_]+)_(?P<id>.+)')
        result = self.linker.link_tree(tree.nodes, species_map={'Hsap': 'GCA_000001405.29'},
                                       manual={'Other_leaf': {'assembly': 'GCA_000001635.9', 'gene_id': 'ENSMUSG00000041147'}})
        hsap = result['links'][str(by_label(tree.nodes, 'Hsap_BRCA2')['id'])]
        self.assertEqual((hsap['status'], hsap['via'], hsap['matched_by']), ('linked', 'species_map', 'symbol'))
        other = result['links'][str(by_label(tree.nodes, 'Other_leaf')['id'])]
        self.assertEqual((other['status'], other['matched_by'], other['gene']['name']), ('linked', 'manual', 'Brca2'))

    def test_bare_identifier_is_probed_in_every_genome(self):
        tree = parse_newick('(ENSMUSG00000041147,ENSG00000139618.17);')[0]
        model.interpret_leaves(tree.nodes)
        links = self.linker.link_tree(tree.nodes)['links']
        self.assertEqual(links['1']['assembly'], 'GCA_000001635.9')
        self.assertEqual(links['2']['assembly'], 'GCA_000001405.29')

    def test_protein_map_builder(self):
        genome = self.fixture.genomes[0]
        mapping = build_protein_map(genome['gff_path'], genome['index_path'])
        self.assertEqual(tuple(mapping['ENSP00000369497']), ('ENST00000380152', 'ENSG00000139618'))


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.fixture = GenomeFixture(self.root)
        app = FastAPI()
        self.router = create_router(lambda: self.root / 'library' / 'gene_trees_index.sqlite',
                                    lambda: self.fixture.genomes, self.root / 'cache')
        app.include_router(self.router)
        self.client = TestClient(app)

    def tearDown(self):
        self.router.linker.proteins.wait()
        self.temp.cleanup()

    def import_and_wait(self, **payload):
        job = self.client.post('/api/gene-trees/datasets', json=payload).json()
        for _ in range(200):
            status = self.client.get(f"/api/gene-trees/jobs/{job['job']}").json()
            if status['status'] not in ('queued', 'running'):
                return status
            time.sleep(0.02)
        self.fail('Import did not finish')

    def test_import_metadata_and_tree_with_links(self):
        status = self.import_and_wait(content=(FIXTURES / 'brca2_ensembl.json').read_text(), name='BRCA2 (Compara)',
                                      method='Ensembl Compara 115', tags=['vertebrates'])
        self.assertEqual(status['status'], 'ready', status)
        collection_id = status['collection_id']
        collections = self.client.get('/api/gene-trees/datasets').json()['collections']
        self.assertEqual((collections[0]['name'], collections[0]['method'], collections[0]['tags'], collections[0]['format']),
                         ('BRCA2 (Compara)', 'Ensembl Compara 115', ['vertebrates'], 'ensembl_json'))
        trees = self.client.get(f'/api/gene-trees/datasets/{collection_id}/trees').json()
        self.assertEqual(trees['total'], 1)
        tree_id = trees['trees'][0]['tree_id']
        self.assertEqual(tree_id, 'ENSGT00390000003602')
        tree = self.client.get(f'/api/gene-trees/datasets/{collection_id}/trees/{tree_id}').json()
        self.assertEqual(tree['stats']['genes'], 175)
        self.assertEqual(tree['collection']['name'], 'BRCA2 (Compara)')
        self.assertGreaterEqual(tree['link_summary']['linked'], 3)
        renamed = self.client.patch(f'/api/gene-trees/datasets/{collection_id}',
                                    json={'name': 'BRCA2 vertebrates', 'description': 'From REST'}).json()
        self.assertEqual((renamed['name'], renamed['description']), ('BRCA2 vertebrates', 'From REST'))
        self.assertEqual(self.client.patch(f'/api/gene-trees/datasets/{collection_id}', json={'name': ' '}).status_code, 400)

    def test_a_gene_in_several_trees_lists_every_context(self):
        compara = self.import_and_wait(content=(FIXTURES / 'brca2_ensembl.json').read_text(), name='Compara')
        ortho = self.import_and_wait(path=str(FIXTURES / 'orthofinder' / 'Gene_Trees'), name='OrthoFinder run',
                                     method='OrthoFinder 2.5')
        self.assertEqual(ortho['status'], 'ready', ortho)
        self.assertEqual(ortho['trees'], 2)
        # A versioned gene ID finds the Compara tree directly.
        results = self.client.get('/api/gene-trees/search', params={'q': 'ENSG00000139618.17'}).json()['results']
        self.assertEqual([r['collection_name'] for r in results], ['Compara'])
        # With its genome, the gene's proteins find the OrthoFinder tree as well.
        for _ in range(200):
            results = self.client.get('/api/gene-trees/search', params={'gene': 'ENSG00000139618',
                                                                        'genome': 'GCA_000001405.29'}).json()['results']
            if len(results) == 2:
                break
            time.sleep(0.05)
        self.assertEqual(sorted((r['collection_name'], r['tree_name']) for r in results),
                         [('Compara', 'ENSGT00390000003602'), ('OrthoFinder run', 'OG0000001')])
        self.assertEqual(next(r for r in results if r['collection_name'] == 'OrthoFinder run')['method'], 'OrthoFinder 2.5')
        by_symbol = self.client.get('/api/gene-trees/search', params={'q': 'brca2'}).json()['results']
        self.assertEqual(by_symbol[0]['tree_id'], 'ENSGT00390000003602')
        self.assertTrue(compara['collection_id'])

    def test_label_mapping_preview_and_update(self):
        status = self.import_and_wait(content='(HUMAN|ENSP00000369497,MOUSE|ENSMUSP00000144150);', name='pipes')
        cid = status['collection_id']
        preview = self.client.get(f'/api/gene-trees/datasets/{cid}/labels',
                                  params={'pattern': r'(?P<species>[A-Z]+)\|(?P<id>\w+)'}).json()
        self.assertEqual({s['species'] for s in preview['samples']}, {'HUMAN', 'MOUSE'})
        self.assertEqual(self.client.get(f'/api/gene-trees/datasets/{cid}/labels', params={'pattern': '('}).status_code, 400)
        self.client.put(f'/api/gene-trees/datasets/{cid}/mapping', json={
            'label_pattern': r'(?P<species>[A-Z]+)\|(?P<id>\w+)', 'species_map': {'HUMAN': 'GCA_000001405.29'}})
        tree_id = self.client.get(f'/api/gene-trees/datasets/{cid}/trees').json()['trees'][0]['tree_id']
        for _ in range(200):
            tree = self.client.get(f'/api/gene-trees/datasets/{cid}/trees/{tree_id}').json()
            if not tree['links_pending']:
                break
            time.sleep(0.05)
        self.assertEqual(tree['links']['1']['status'], 'linked')
        self.assertEqual(tree['links']['1']['gene']['id'], 'ENSG00000139618')
        self.assertEqual(tree['links']['2']['status'], 'unresolved')

    def test_manual_link_table_export_and_delete(self):
        cid = self.import_and_wait(content=(FIXTURES / 'small.nhx').read_text(), name='small')['collection_id']
        applied = self.client.post(f'/api/gene-trees/datasets/{cid}/links', json={
            'content': 'label\tassembly\tgene_id\nENSMUSP00000099999_Mmus\tGCA_000001635.9\tENSMUSG00000041147\n'}).json()
        self.assertEqual(applied['applied'], 1)
        tree_id = self.client.get(f'/api/gene-trees/datasets/{cid}/trees').json()['trees'][0]['tree_id']
        tree = self.client.get(f'/api/gene-trees/datasets/{cid}/trees/{tree_id}').json()
        node = next(n for n in tree['nodes'] if (n.get('leaf') or {}).get('label') == 'ENSMUSP00000099999_Mmus')
        self.assertEqual(tree['links'][str(node['id'])]['matched_by'], 'manual')
        nhx = self.client.get(f'/api/gene-trees/datasets/{cid}/trees/{tree_id}/export', params={'format': 'nhx', 'node': 1}).text
        self.assertIn('D=Y', nhx)
        self.assertEqual(len(parse_newick(nhx)[0].nodes), len(model.subtree(tree['nodes'], 1)))
        self.client.delete(f'/api/gene-trees/datasets/{cid}')
        self.assertEqual(self.client.get('/api/gene-trees/datasets').json()['collections'], [])
        self.assertEqual(self.client.get('/api/gene-trees/search', params={'q': 'ENSG00000139618'}).json()['results'], [])

    def test_workspace_round_trip(self):
        self.assertEqual(self.client.get('/api/gene-trees/workspace').json(), {'workspace': None, 'updated': None})
        workspace = {'version': 1, 'active': 'L1', 'original': False, 'layers': [
            {'id': 'L1', 'name': 'Primates', 'color': '#e64980', 'fragments': [
                {'id': 'F1', 'source': {'collectionId': 'c', 'treeId': 't'}, 'nodes': [
                    {'id': 0, 'parent': -1, 'children': [1], 'src': 4}, {'id': 1, 'parent': 0, 'children': [], 'src': 5, 'leaf': {'label': 'A'}}]}]}]}
        saved = self.client.put('/api/gene-trees/workspace', json=workspace).json()
        self.assertIn('updated', saved)
        back = self.client.get('/api/gene-trees/workspace').json()
        self.assertEqual(back['workspace'], workspace)
        self.assertEqual(self.client.put('/api/gene-trees/workspace', json={'layers': 'nope'}).status_code, 400)
        self.assertEqual(self.client.put('/api/gene-trees/workspace', content=b'{bad').status_code, 400)

    def test_bad_input_is_reported_not_stored(self):
        status = self.import_and_wait(content='((A,B);', name='broken')
        self.assertEqual(status['status'], 'failed')
        self.assertIn('Unbalanced', status['error'])
        self.assertEqual(self.client.get('/api/gene-trees/datasets').json()['collections'], [])
        self.assertEqual(self.client.post('/api/gene-trees/datasets', json={'content': ''}).status_code, 400)
        self.assertEqual(self.client.get('/api/gene-trees/datasets/nothex').status_code, 404)


class IndexTests(unittest.TestCase):
    """Streaming import of an EMF dump: progress, naming, taxa by taxid, and ranked search."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.fixture = GenomeFixture(self.root)
        self.library = self.root / 'library' / 'gene_trees_index.sqlite'
        app = FastAPI()
        self.router = create_router(lambda: self.library, lambda: self.fixture.genomes, self.root / 'cache')
        app.include_router(self.router)
        self.client = TestClient(app)

    def tearDown(self):
        self.router.linker.proteins.wait()
        self.temp.cleanup()

    def wait(self, job_id):
        for _ in range(300):
            status = self.client.get(f'/api/gene-trees/jobs/{job_id}').json()
            if status['status'] not in ('queued', 'running'):
                return status
            time.sleep(0.02)
        self.fail('Import did not finish')

    def test_gzipped_emf_is_indexed_with_progress_and_named_trees(self):
        job = self.client.post('/api/gene-trees/datasets', json={'path': str(FIXTURES / 'compara_sample.nhx.emf.gz'),
                                                                  'name': 'Compara sample'}).json()
        status = self.wait(job['job'])
        self.assertEqual(status['status'], 'ready', status)
        self.assertEqual((status['trees'], status['leaves']), (2, 8))
        self.assertEqual(status['bytes_done'], status['bytes_total'])
        self.assertGreater(status['bytes_total'], 0)
        listed = self.client.get('/api/gene-trees/jobs').json()['jobs']
        self.assertEqual(listed[-1]['id'], job['job'])
        collection = self.client.get('/api/gene-trees/datasets').json()['collections'][0]
        self.assertEqual((collection['format'], collection['status'], collection['tree_count'], collection['leaf_count']),
                         ('emf', 'ready', 2, 8))
        trees = self.client.get(f"/api/gene-trees/datasets/{collection['id']}/trees").json()['trees']
        self.assertEqual([t['name'] for t in trees], ['SAMD11', 'TP53 family'])
        tree = self.client.get(f"/api/gene-trees/datasets/{collection['id']}/trees/{trees[0]['tree_id']}").json()
        taxa = {n['taxon']['id']: n['taxon'] for n in tree['nodes'] if n.get('taxon')}
        self.assertEqual(taxa[39107]['name'], 'Murinae')
        self.assertEqual(taxa[314146]['name'], 'Euarchontoglires')
        self.assertEqual(taxa[1437010]['name'], 'Boreoeutheria')
        # A taxid nobody knows falls back to the common ancestor of its species.
        self.assertEqual(tree['nodes'][0]['taxon']['name'], 'Euteleostomi')
        human = next(n for n in tree['nodes'] if (n.get('leaf') or {}).get('gene_id') == 'ENSG00000187634')
        self.assertEqual((human['leaf']['species'], human['leaf']['protein_id']), ('Homo sapiens', 'ENSP00000342313'))
        self.assertEqual(tree['links'][str(human['id'])]['status'], 'linked')
        self.assertEqual(tree['stats']['genes'], 5)

    def test_a_symbol_finds_the_users_own_gene_first(self):
        job = self.client.post('/api/gene-trees/datasets', json={'path': str(FIXTURES / 'compara_sample.nhx.emf')}).json()
        self.assertEqual(self.wait(job['job'])['status'], 'ready')
        # The dump names only the cat and fish leaves SAMD11...
        plain = self.client.get('/api/gene-trees/search', params={'q': 'SAMD11'}).json()['results']
        self.assertEqual({m['species'] for m in plain[0]['matches']}, {'Felis catus', 'Danio rerio'})
        # ...but resolved in the user's own human genome, the human leaf leads.
        ranked = self.client.get('/api/gene-trees/search', params={'q': 'samd11', 'prefer': 'GCA_000001405.29'}).json()
        first = ranked['results'][0]['matches'][0]
        self.assertEqual((first['species'], first['gene_id'], first['rank'], first['assembly']),
                         ('Homo sapiens', 'ENSG00000187634', 0, 'GCA_000001405.29'))
        self.assertIn('elapsed', ranked)

    def test_an_earlier_library_is_offered_for_reindexing_then_removed(self):
        legacy = self.library.parent / 'gene_trees.sqlite'
        legacy.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(legacy)
        conn.executescript('CREATE TABLE collections (id TEXT, name TEXT, source TEXT, format TEXT, created REAL, tree_count INT, '
                           "label_pattern TEXT, method TEXT, description TEXT, tags TEXT);"
                           'CREATE TABLE trees (collection_id TEXT, tree_id TEXT, tree TEXT);')
        conn.execute('INSERT INTO collections VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                     ('x' * 32, 'Old Compara', str(FIXTURES / 'compara_sample.nhx.emf'), 'emf', 1.0, 2, None, 'Compara 116', '', '["vertebrates"]'))
        conn.commit()
        conn.close()
        info = self.client.get('/api/gene-trees/legacy').json()['legacy']
        self.assertEqual(info['collections'][0]['name'], 'Old Compara')
        self.assertTrue(info['collections'][0]['source_exists'])
        jobs = self.client.post('/api/gene-trees/legacy/reindex').json()['jobs']
        self.assertEqual(self.wait(jobs[0]['job'])['status'], 'ready')
        collection = self.client.get('/api/gene-trees/datasets').json()['collections'][0]
        self.assertEqual((collection['name'], collection['method'], collection['tags']), ('Old Compara', 'Compara 116', ['vertebrates']))
        self.assertTrue(self.client.delete('/api/gene-trees/legacy').json()['removed'])
        self.assertFalse(legacy.exists())
        self.assertIsNone(self.client.get('/api/gene-trees/legacy').json()['legacy'])


if __name__ == '__main__':
    unittest.main()


class NeighbourhoodTests(unittest.TestCase):
    """The genes around a leaf's gene, for the tree's Neighbourhood column."""

    ROWS = [
        {'id': 'g1', 'name': 'A', 'chrom': '1', 'start': 100, 'end': 200, 'strand': '+', 'biotype': 'protein_coding'},
        {'id': 'p1', 'name': '', 'chrom': '1', 'start': 250, 'end': 260, 'strand': '+', 'biotype': 'processed_pseudogene'},
        {'id': 'g2', 'name': 'B', 'chrom': '1', 'start': 300, 'end': 400, 'strand': '-', 'biotype': 'protein_coding'},
        {'id': 'c', 'name': 'C', 'chrom': '1', 'start': 500, 'end': 600, 'strand': '-', 'biotype': 'protein_coding'},
        {'id': 'm1', 'name': 'MIR1', 'chrom': '1', 'start': 650, 'end': 660, 'strand': '+', 'biotype': 'miRNA'},
        {'id': 'g3', 'name': 'D', 'chrom': '1', 'start': 700, 'end': 800, 'strand': '+', 'biotype': 'protein_coding'},
        {'id': 'g4', 'name': 'E', 'chrom': '1', 'start': 900, 'end': 950, 'strand': '+', 'biotype': 'protein_coding'},
    ]

    def test_window_keeps_protein_coding_flanks_and_turns_minus_strand_rows(self):
        from gene_trees.neighbourhood import window
        result = window(self.ROWS, 'c', 1)
        # C is on the minus strand: the row is reversed so it points right, and strands swap.
        self.assertTrue(result['flipped'])
        self.assertEqual([g['id'] for g in result['genes']], ['g3', 'c', 'g2'])
        self.assertEqual([g['strand'] for g in result['genes']], ['-', '+', '+'])
        both = window(self.ROWS, 'c', 4)
        self.assertEqual({g['id'] for g in both['genes']}, {'g1', 'g2', 'c', 'g3', 'g4'})  # no pseudogene, no miRNA
        forward = window(self.ROWS, 'g3', 2)
        self.assertFalse(forward['flipped'])
        self.assertEqual([g['id'] for g in forward['genes']], ['g2', 'c', 'g3', 'g4'])
        self.assertIsNone(window(self.ROWS, 'missing', 2))

    def test_route_batches_genes_and_says_why_one_is_missing(self):
        calls = []

        def lookup(index, gene_id, size):
            calls.append((index, gene_id))
            return [dict(r) for r in self.ROWS], gene_id

        genomes = [{'assembly': 'GCA_1', 'index_path': '/idx/one.sqlite'}, {'assembly': 'GCA_2', 'index_path': ''}]
        with tempfile.TemporaryDirectory() as temp:
            app = FastAPI()
            app.include_router(create_router(lambda: Path(temp) / 'lib.sqlite', lambda: genomes, Path(temp) / 'cache',
                                             neighbourhood_lookup=lookup))
            client = TestClient(app)
            body = {'genes': [{'assembly': 'GCA_1', 'gene_id': 'c'}, {'assembly': 'GCA_2', 'gene_id': 'x'},
                              {'assembly': 'GCA_9', 'gene_id': 'y'}], 'flank': 1}
            results = client.post('/api/gene-trees/neighbourhood', json=body).json()['results']
            self.assertEqual([g['id'] for g in results['GCA_1:c']['genes']], ['g3', 'c', 'g2'])
            self.assertEqual(results['GCA_2:x'], {'error': 'not indexed'})
            self.assertEqual(results['GCA_9:y'], {'error': 'not local'})
            client.post('/api/gene-trees/neighbourhood', json=body)
            self.assertEqual(calls, [('/idx/one.sqlite', 'c')])  # the second ask came from the cache
            self.assertEqual(client.post('/api/gene-trees/neighbourhood', json={'genes': 'no'}).status_code, 400)
