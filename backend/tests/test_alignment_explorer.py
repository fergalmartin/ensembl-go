import gzip
import io
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from alignment_explorer.store import AlignmentStore, maf_blocks, stable_id, locate_column, parse_metadata, CHUNK, SOURCE_GAP, LAYOUT_VERSION
from alignment_explorer.api import create_router
from alignment_explorer.adapters import import_native, graph_preview, project_graph
from fastapi import FastAPI
from fastapi.testclient import TestClient

MAF='''##maf version=1

a score=17
s human.chr1 10 6 + 100 AC-GTN-A
s mouse.chr1 20 6 - 100 AT-GTN-A
s mouse.chr1 40 5 + 100 AC-GT--A
e ancestor.chr1 0 8 + 100 M

a score=4
s orphan.chr2 0 4 + 10 TTAA
s human.chr1 30 4 + 100 TTAA
'''

class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.store=AlignmentStore(self.root/'index');self.store.initialize()
    def tearDown(self): self.temp.cleanup()
    def load(self, text=MAF, fmt='maf'):
        path=self.root/('input.'+fmt);path.write_text(text);self.store.import_file(path,fmt);return path
    def test_all_rows_and_duplicate_identity(self):
        self.load();rows=self.store.inventory()['rows']
        self.assertEqual(len(rows),5)
        mouse=[r for r in rows if r['source']=='mouse.chr1'];self.assertEqual(len(mouse),2);self.assertNotEqual(mouse[0]['id'],mouse[1]['id'])
        self.assertIn('orphan.chr2',[r['source'] for r in rows])
    def test_reverse_coordinates_and_subregion_export(self):
        self.load();row_id=stable_id('mouse.chr1')
        row=self.store.region(1,1,6,[row_id])['rows'][0]
        self.assertEqual((row['start'],row['end'],row['offset_bases']),(74,80,1))
        self.assertEqual(row['sequence'],'T-GTN')
        self.assertEqual(locate_column(self.store,1,row_id,78),1)
        exported=self.store.export(1,1,6,[row_id],'maf')
        parsed=list(maf_blocks(io.StringIO(exported)))[0][0][0]
        self.assertEqual((parsed['start'],parsed['end'],parsed['strand'],parsed['sequence']),(75,79,'-','T-GTN'))
    def test_absent_is_not_gap(self):
        self.load();rows=self.store.region(1)['rows'];missing=next(r for r in rows if r['source']=='ancestor.chr1')
        self.assertTrue(missing['missing']);self.assertIsNone(missing['sequence'])
        self.assertEqual(missing['empty_status'],'M')
    def test_large_fasta_chunks_and_cross_chunk_coordinates(self):
        seq='A'*(CHUNK-1)+'--CGT';self.load('>sample\n'+seq+'\n>other\n'+seq+'\n','fasta')
        row=self.store.region(1,CHUNK-2,CHUNK+4)['rows'][0]
        self.assertEqual(row['sequence'],'A--CGT');self.assertEqual(row['offset_bases'],CHUNK-2)
        with self.store.connect() as db:self.assertLessEqual(db.execute('SELECT max(length(bases)) FROM chunks').fetchone()[0],CHUNK)
    def test_overview_keeps_canonical_denominators(self):
        self.load();data=self.store.region(1,0,8,max_cells=1,bins=16,focus_id=stable_id('human.chr1'))
        self.assertFalse(data['detail']);row=next(r for r in data['rows'] if r['id']==stable_id('mouse.chr1'))
        self.assertEqual(sum(v['comparable'] for v in row['divergence_bins']),5)
        self.assertEqual(sum(v['different'] for v in row['divergence_bins']),1)
    def test_gzip_and_unequal_rows(self):
        path=self.root/'input.maf.gz'
        with gzip.open(path,'wt') as f:f.write(MAF)
        self.store.import_file(path,'maf');self.assertEqual(self.store.blocks()['total'],2)
        with self.assertRaises(ValueError):list(maf_blocks(io.StringIO('a\ns x 0 5 + 5 ACTG\n')))
    def test_cancel_and_invalid_fasta(self):
        path=self.root/'input.fa';path.write_text('>a\nACGT\n>b\nACTG\n')
        with self.assertRaises(InterruptedError):self.store.import_file(path,'fasta',lambda:True)
    def test_metadata_does_not_remove_sequences(self):
        self.load();self.store.update_metadata([{'source':'mouse.chr1','genome_key':'active::mouse','group':'mammals'}])
        self.assertEqual(self.store.inventory()['total'],5)
        mouse=[r for r in self.store.inventory()['rows'] if r['source']=='mouse.chr1']
        self.assertTrue(all(r['metadata']['group']=='mammals' for r in mouse))
    def test_saved_fasta_metadata_restores_verified_source_coordinates(self):
        self.load('>sample\nAC-GT\n','fasta')
        entries=parse_metadata(json.dumps({'genomes':[{'genome_key':'sample','chrom':'chr1','genomic_start':101,'genomic_end':104,'strand':'-'}]}),'.json')
        self.store.update_metadata(entries)
        row=self.store.region(1)['rows'][0]
        self.assertEqual((row['start'],row['end'],row['strand'],row['coordinates']),(100,104,'-',1))
        self.assertEqual(locate_column(self.store,1,row['id'],102),1)

    def test_invalid_fasta_coordinate_metadata_is_rejected(self):
        self.load('>sample\nAC-GT\n','fasta')
        with self.assertRaises(ValueError):self.store.update_metadata([{'source':'sample','genomic_start':10,'genomic_end':20}])
        self.assertFalse(self.store.region(1)['rows'][0]['coordinates'])

    def test_region_lookup_finds_all_mappings(self):
        self.load();self.assertEqual(self.store.blocks(sequence_id=stable_id('human.chr1'),coordinate=31)['total'],1)
        self.assertEqual(self.store.blocks(sequence_id=stable_id('orphan.chr2'))['blocks'][0]['id'],2)
    def test_standard_text_formats(self):
        cases={'clustal':'CLUSTAL W\n\na   ACTG\nb   A-TG\n', 'stockholm':'# STOCKHOLM 1.0\na ACTG\nb A-TG\n//\n','phylip-relaxed':' 2 4\na ACTG\nb A-TG\n','xmfa':'>1:1-4 + one\nACTG\n>2:1-3 - two\nA-TG\n=\n'}
        for fmt,text in cases.items():
            with self.subTest(fmt=fmt):
                store=AlignmentStore(self.root/fmt);store.initialize();path=self.root/(fmt+'.txt');path.write_text(text);store.import_file(path,fmt)
                self.assertEqual([r['sequence'] for r in store.region(1)['rows']],['ACTG','A-TG'])
    def test_graph_projection_preserves_alternative_path_inventory(self):
        path=self.root/'graph.gfa';path.write_text('H\tVN:Z:1.0\nS\t1\tAC\nS\t2\tTG\nS\t3\tGG\nL\t1\t+\t2\t+\t0M\nL\t1\t+\t3\t+\t0M\nP\tref\t1+,2+\t*\nP\talt\t1+,3+\t*\n')
        import_native(self.store,path,'gfa',lambda:False,lambda **kw:None)
        self.assertEqual(graph_preview(self.store)['total_nodes'],3)
        projection=project_graph(self.store,'ref');self.assertEqual(len(projection['blocks']),2)
        self.assertEqual(self.store.inventory()['total'],2)
        self.assertEqual(len(self.store.region(projection['blocks'][1])['rows']),1)

class ApiTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();app=FastAPI();app.include_router(create_router(self.temp.name));self.client=TestClient(app)
    def tearDown(self):self.client.close();self.temp.cleanup()
    def register(self,**payload):
        response=self.client.post('/api/alignment-explorer/datasets',json=payload);self.assertEqual(response.status_code,200,response.text);job=response.json()
        for _ in range(100):
            status=self.client.get('/api/alignment-explorer/jobs/'+job['id']).json()
            if status['status'] in ('failed','ready','cancelled'):return status
            time.sleep(.01)
        self.fail('Import did not complete')
    def test_zero_genomes_import_and_workspace(self):
        status=self.register(content='>unlinked\nACGT\n>another\nA-GT\n',format='fasta');self.assertEqual(status['status'],'ready',status)
        prefix='/api/alignment-explorer/datasets/'+status['dataset_id']
        rows=self.client.get(prefix+'/sequences').json()['rows'];self.assertEqual(len(rows),2)
        region=self.client.post(prefix+'/region',json={'block':1,'start':0,'end':4}).json();self.assertEqual(len(region['rows']),2)
        workspace={'version':1,'sets':[{'members':[rows[0]['id']]}],'selection':[]}
        self.assertEqual(self.client.put(prefix+'/workspace',json=workspace).status_code,200)
        self.assertEqual(self.client.get(prefix+'/workspace').json(),workspace)
        self.assertEqual(self.client.post(prefix+'/export',json={'block':1,'start':0,'end':4,'format':'maf'}).status_code,400)
    def test_layer_summary_rows_connections_and_versioned_workspace(self):
        status=self.register(content=MAF,format='maf')
        prefix='/api/alignment-explorer/datasets/'+status['dataset_id']
        rows=self.client.get(prefix+'/blocks/1/rows').json()
        self.assertEqual(rows['length'],8)
        self.assertEqual(len(rows['rows']),4)
        human=stable_id('human.chr1');mouse=stable_id('mouse.chr1')
        data=self.client.post(prefix+'/region',json={'block':1,'start':0,'end':8,'summary':True,'focus':human}).json()
        self.assertFalse(data['detail']);self.assertIsNone(data['rows'][0]['sequence'])
        pairs=[{'id':r,'rowId':r,'from':{'sourceBlock':1,'start':0,'end':2},'to':{'sourceBlock':1,'start':6,'end':8}} for r in (human,mouse)]
        connections=self.client.post(prefix+'/connections',json={'pairs':pairs}).json()['connections']
        self.assertEqual([c['bases'] for c in connections],[3,3])
        self.assertEqual(connections[1]['left']['start'],78)
        self.assertEqual(connections[1]['right']['end'],75)
        workspace={'version':2,'layers':[{'name':'Regions'}]}
        self.assertEqual(self.client.put(prefix+'/workspace',json=workspace).status_code,200)
        self.assertEqual(self.client.get(prefix+'/workspace?version=2').json(),workspace)
        self.assertIsNone(self.client.get(prefix+'/workspace').json())

    def test_embedded_annotations_are_clipped_to_requested_source_columns(self):
        status=self.register(rows=[{'source':'sample','aligned_sequence':'AC-GT','features':[{'type':'cds','start':1,'end':3},{'type':'exon','start':4,'end':4}]}])
        prefix='/api/alignment-explorer/datasets/'+status['dataset_id']
        response=self.client.post(prefix+'/annotations',json={'block':1,'start':1,'end':4}).json()
        self.assertEqual(list(response['rows'].values())[0],[{'type':'cds','start':1,'end':3}])

    def test_linked_annotation_callback_receives_reverse_source_span(self):
        calls=[]
        def provider(*args):
            calls.append(args)
            return [{'type':'cds','start':0,'end':1}]
        temp=Path(self.temp.name)/'linked'
        app=FastAPI();app.include_router(create_router(temp,annotation_provider=provider))
        previous=self.client;self.client=TestClient(app)
        try:
            status=self.register(content=MAF,format='maf');prefix='/api/alignment-explorer/datasets/'+status['dataset_id'];row=stable_id('mouse.chr1')
            self.client.post(prefix+'/metadata',json={'entries':[{'id':row,'genome_key':'mouse','chrom':'chr1'}]})
            response=self.client.post(prefix+'/annotations',json={'block':1,'start':1,'end':6,'ids':[row]}).json()
            self.assertEqual(calls[0][:6],('mouse','chr1',76,79,'T-GTN','-'))
            self.assertEqual(response['rows'][row],[{'type':'cds','start':1,'end':2}])
        finally:self.client.close();self.client=previous

    def test_changed_source_rejected(self):
        path=Path(self.temp.name)/'source.fa';path.write_text('>a\nACGT\n')
        status=self.register(path=str(path));path.write_text('>a\nACGTACGT\n')
        self.assertEqual(self.client.get('/api/alignment-explorer/datasets/'+status['dataset_id']).status_code,409)
    def test_malformed_alignment_failed_job(self):
        status=self.register(content='>a\nACGT\n>b\nA\n',format='fasta');self.assertEqual(status['status'],'failed')
    def test_missing_native_helper_is_actionable(self):
        from unittest.mock import patch
        path=Path(self.temp.name)/'test.hal';path.write_bytes(b'not-hal')
        with patch('alignment_explorer.adapters.hal_helper',return_value=None):
            status=self.register(path=str(path));self.assertEqual(status['status'],'failed');self.assertIn('ENSEMBL_HAL_HELPER',status['error'])

if __name__=='__main__':unittest.main()

class LayoutPerformanceTests(unittest.TestCase):
    setUp=StoreTests.setUp
    tearDown=StoreTests.tearDown
    def test_layout_direct_jump_and_stable_positions(self):
        for i in range(40):
            self.store.add_block([{'source':'a','sequence':'A'*100},{'source':f'copy{i}','sequence':'T'*100}])
        info=self.store.layout_info(30)
        self.assertEqual(info['layout_start'],29*132)
        window=self.store.layout_region(info['layout_start'],info['layout_start']+100)
        self.assertEqual([b['block'] for b in window['blocks']],[30])
        self.assertEqual(window['blocks'][0]['row_ids'],[stable_id('a'),stable_id('copy29')])
        wider=self.store.layout_region(info['layout_start']-150,info['layout_start']+300)
        self.assertEqual(next(b for b in wider['blocks'] if b['block']==30)['x'],info['layout_start'])
        self.assertEqual(window['layout_end'],40*132-32)
    def test_whole_file_overview_represents_every_block_without_large_inventory(self):
        for i in range(600):self.store.add_block([{'source':'a','sequence':'ACGT'}])
        result=self.store.layout_region(0,self.store.layout_info()['layout_end'],limit=32)
        self.assertLessEqual(len(result['blocks']),32)
        self.assertEqual(sum(b['count'] for b in result['blocks']),600)
        self.assertTrue(all(b['aggregate'] and b['row_ids']==[stable_id('a')] for b in result['blocks']))
        self.assertTrue(all(b['presence'][stable_id('a')]==b['count'] for b in result['blocks']))
        # Coarse blocks resolve to ordinary, exact memberships on zoom-in.
        item=result['blocks'][10]
        detail=self.store.layout_region(item['x'],item['end_x'],limit=256)
        self.assertTrue(all(not b.get('aggregate') for b in detail['blocks']))
    def test_summary_exactness_across_chunks_and_missing_reference(self):
        ref=('ACGTN-'*(CHUNK//6+2))[:CHUNK+5]
        other=ref[:CHUNK-3]+'TTN--'+ref[CHUNK+2:]
        self.store.add_block([{'source':'a','sequence':ref},{'source':'b','sequence':other}])
        result=self.store.region(1,CHUNK-8,CHUNK+4,max_cells=0,bins=16,focus_id=stable_id('a'))
        row=next(r for r in result['rows'] if r['id']==stable_id('b'))
        expected=[(a,b) for a,b in zip(ref[CHUNK-8:CHUNK+4],other[CHUNK-8:CHUNK+4]) if a in 'ACGT' and b in 'ACGT']
        self.assertEqual(sum(b['comparable'] for b in row['divergence_bins']),len(expected))
        self.assertEqual(sum(b['different'] for b in row['divergence_bins']),sum(a!=b for a,b in expected))

    def test_block_spacing_is_equal_regardless_of_block_length(self):
        # Unequal spacing reads as if the distance between blocks meant
        # something. It never does, so every gap is the same width whatever the
        # blocks either side of it happen to be.
        lengths=[1000,50000,400000,2000]
        for length in lengths:
            self.store.add_block([{'source':'a','sequence':'A'*length}])
        blocks={b['block']:b for b in self.store.layout_region(0,self.store.layout_info()['layout_end'])['blocks']}
        gaps=[blocks[i+1]['x']-blocks[i]['end_x'] for i in (1,2,3)]
        self.assertEqual(gaps,[SOURCE_GAP]*3)
        self.assertTrue(all(blocks[i]['end_x']<blocks[i+1]['x'] for i in (1,2,3)))
        # Each block still spans exactly its own column count.
        for i,length in enumerate(lengths,start=1):
            self.assertEqual(blocks[i]['end_x']-blocks[i]['x'],length)

    def test_a_layout_index_from_an_older_spacing_formula_is_rebuilt(self):
        for _ in range(4):
            self.store.add_block([{'source':'a','sequence':'A'*10000}])
        before=self.store.layout_info()['layout_end']
        # Simulate an index left by an earlier release: right shape, stale
        # positions, no version marker.
        with self.store.connect() as db:
            db.execute('UPDATE source_layout SET x=x*2, end_x=end_x*2')
            db.execute("DELETE FROM meta WHERE key='layout_version'")
        # Read the stale rows directly: layout_info would rebuild them first.
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT max(end_x) FROM source_layout').fetchone()[0],before*2)
        # Any layout read discards the stale index and rebuilds it in place.
        self.assertEqual(self.store.layout_info()['layout_end'],before)
        with self.store.connect() as db:
            self.assertEqual(json.loads(db.execute("SELECT value FROM meta WHERE key='layout_version'").fetchone()['value']),LAYOUT_VERSION)

    def test_neighbours_find_the_nearest_occurrence_outside_the_loaded_window(self):
        # a spans everything; b skips a long way; c only sits inside the window.
        layout={1:['a','b'],2:['a'],3:['a','c'],4:['a','c'],5:['a'],9:['a','b']}
        for block in range(1,10):
            self.store.add_block([{'source':s,'sequence':'ACGT'} for s in layout.get(block,['a'])])
        ids=[stable_id(x) for x in ('a','b','c')]
        a,b,c=ids
        # Window covers blocks 3-4: b continues in both directions, c in neither.
        result=self.store.outside_neighbours(ids,3,4)
        self.assertEqual(result['before'],{a:2,b:1})
        self.assertEqual(result['after'],{a:5,b:9})
        # Nearest, not first or last: a is in 2 and 5, never 1 or 9.
        self.assertNotIn(c,result['before'])
        self.assertNotIn(c,result['after'])
        # A window covering the whole file has nothing outside it.
        self.assertEqual(self.store.outside_neighbours(ids,1,9),{'before':{},'after':{}})
        self.assertEqual(self.store.outside_neighbours([],1,2),{'before':{},'after':{}})

    def test_neighbours_ignore_empty_components(self):
        # An 'e' record states the sequence is absent, so the path cannot resume
        # there; the next real occurrence is what the view must point at.
        self.store.add_block([{'source':'a','sequence':'ACGT'}])
        self.store.add_block([{'source':'a','sequence':'ACGT'},{'source':'b','sequence':'ACGT'}])
        # A block needs a real row; 'a' is present only as an empty component.
        self.store.add_block([{'source':'z','sequence':'ACGT'},{'source':'a','sequence':None,'empty_status':'C','start':0,'end':0}])
        self.store.add_block([{'source':'a','sequence':'ACGT'}])
        a=stable_id('a')
        self.assertEqual(self.store.outside_neighbours([a],2,2)['after'],{a:4})
        self.assertEqual(self.store.outside_neighbours([a],3,3)['before'],{a:2})

    def test_merging_buckets_by_width_not_by_block_count(self):
        # Equal-count groups come out wildly uneven when block lengths vary, which
        # is what made the overview read as a jumble. Widths do not.
        for length in [200_000]*4+[2_000]*40+[150_000]*4:
            self.store.add_block([{'source':'a','sequence':'A'*length}])
        end=self.store.layout_info()['layout_end']
        merged=[b for b in self.store.layout_region(0,end,merge=400_000,detail=0)['blocks']]
        self.assertTrue(all(b['aggregate'] for b in merged))
        widths=[b['end_x']-b['x'] for b in merged]
        # Every merged block lands within one block's length of the budget rather
        # than varying by orders of magnitude.
        self.assertLessEqual(max(widths),400_000+200_000)
        self.assertEqual(sum(b['count'] for b in merged),48)
        # Buckets sit on a fixed grid, so a merged block keeps its identity and
        # position while panning instead of regrouping around the leftmost block.
        window=self.store.layout_region(300_000,end,merge=400_000,detail=0)['blocks']
        shared={b['x'] for b in merged}&{b['x'] for b in window}
        self.assertTrue(shared)
        for x in shared:
            a=next(b for b in merged if b['x']==x); c=next(b for b in window if b['x']==x)
            self.assertEqual((a['block'],a['last_block'],a['end_x']),(c['block'],c['last_block'],c['end_x']))

    def test_a_few_blocks_are_never_merged_however_wide_the_view(self):
        # Merging here would hand back merged blocks holding one block each, which
        # says less than the blocks do and costs their headers and rulers.
        for _ in range(6):
            self.store.add_block([{'source':'a','sequence':'A'*100_000}])
        end=self.store.layout_info()['layout_end']
        blocks=self.store.layout_region(0,end,merge=50_000,detail=40)['blocks']
        self.assertEqual(len(blocks),6)
        self.assertTrue(all(not b.get('aggregate') for b in blocks))
        # Past the threshold the same request merges.
        self.assertTrue(all(b['aggregate'] for b in self.store.layout_region(0,end,merge=50_000,detail=4)['blocks']))

    def test_a_merged_block_carries_the_edges_of_the_blocks_it_covers(self):
        for length in (10_000,20_000,30_000):
            self.store.add_block([{'source':'a','sequence':'A'*length}])
        end=self.store.layout_info()['layout_end']
        [merged]=self.store.layout_region(0,end,merge=1_000_000,detail=0)['blocks']
        self.assertEqual([e['block'] for e in merged['edges']],[1,2,3])
        self.assertEqual([e['end_x']-e['x'] for e in merged['edges']],[10_000,20_000,30_000])
        # Edges are in the same display space as the merged block itself, so the
        # view can point at the block under the cursor without another request.
        self.assertEqual(merged['edges'][0]['x'],merged['x'])
        self.assertEqual(merged['edges'][-1]['end_x'],merged['end_x'])

    def test_summary_counts_blocks_bases_and_columns_per_sequence(self):
        self.store.add_block([{'source':'a','sequence':'ACGT'*10},{'source':'b','sequence':'AC--'*10}])
        self.store.add_block([{'source':'a','sequence':'ACGTA'}])
        self.store.update_metadata([{'source':'a','genome_key':'human','chrom':'1'}])
        summary=self.store.summary()
        rows={r['source']:r for r in summary['sequences']}
        # Blocks a sequence appears in, and the alignment columns of those blocks.
        self.assertEqual(rows['a']['blocks'],2)
        self.assertEqual(rows['a']['columns'],45)
        self.assertEqual(rows['b']['blocks'],1)
        self.assertEqual(rows['b']['columns'],40)
        # These rows carry no source coordinates, so ungapped bases are not
        # derivable and are reported as none counted rather than as zero bases.
        self.assertEqual(rows['a']['placed'],0)
        self.assertEqual(rows['b']['placed'],0)
        # Explicit links travel with the sequence so the panel can filter on them.
        self.assertEqual(rows['a']['genome_key'],'human')
        self.assertIsNone(rows['b']['genome_key'])
        blocks={b['id']:b for b in summary['blocks']}
        self.assertEqual((blocks[1]['length'],blocks[1]['available']),(40,2))
        self.assertEqual((blocks[2]['length'],blocks[2]['available']),(5,1))
        self.assertEqual(summary['total'],{'sequences':2,'blocks':2})

    def test_summary_counts_ungapped_bases_where_coordinates_exist(self):
        # MAF rows as the importer yields them: start/size are ungapped.
        self.store.add_block([
            {'source':'a.1','sequence':'ACGT','start':10,'end':14,'strand':'+','source_length':100,'coordinates':True},
            {'source':'b.1','sequence':'AC--','start':20,'end':22,'strand':'+','source_length':100,'coordinates':True}])
        rows={r['source']:r for r in self.store.summary()['sequences']}
        # MAF start/size are ungapped, so the gapped row counts fewer bases than
        # the columns it spans.
        self.assertEqual((rows['a.1']['bases'],rows['a.1']['columns']),(4,4))
        self.assertEqual((rows['b.1']['bases'],rows['b.1']['columns']),(2,4))
        self.assertEqual(rows['b.1']['placed'],1)

    def test_summary_reports_truncation_rather_than_silently_dropping_rows(self):
        for _ in range(5): self.store.add_block([{'source':'a','sequence':'ACGT'}])
        limited=self.store.summary(limit=2)
        self.assertEqual(len(limited['blocks']),2)
        self.assertTrue(limited['truncated']['blocks'])
        self.assertEqual(limited['total']['blocks'],5)
        self.assertFalse(self.store.summary()['truncated']['blocks'])

    def test_blocks_with_reports_which_sequences_each_block_holds(self):
        self.store.add_block([{'source':'a','sequence':'ACGT'},{'source':'b','sequence':'ACGT'}])
        self.store.add_block([{'source':'a','sequence':'ACGT'}])
        self.store.add_block([{'source':'c','sequence':'ACGT'}])
        a,b,c=(stable_id(x) for x in 'abc')
        found=self.store.blocks_with([a,b])
        self.assertEqual([e['block'] for e in found],[1,2])
        # Block 2 holds only 'a'; a layer built from this must not invent a row
        # for 'b' there, so the membership matters and not just the block number.
        self.assertEqual(sorted(found[0]['ids']),sorted([a,b]))
        self.assertEqual(found[1]['ids'],[a])
        self.assertEqual(self.store.blocks_with([]),[])
        # An empty component is not a presence.
        self.store.add_block([{'source':'z','sequence':'ACGT'},{'source':c,'sequence':None,'empty_status':'C','start':0,'end':0}])
        self.assertEqual([e['block'] for e in self.store.blocks_with([c])],[3])

    def test_blocks_in_range_finds_the_interval_on_either_strand(self):
        # Forward and reverse rows of the same region. The importer converts MAF
        # reverse start/size to forward coordinates, so one interval finds both.
        self.store.add_block([
            {'source':'fwd','sequence':'ACGT--ACGT','start':100,'end':108,'strand':'+','source_length':1000,'coordinates':True},
            {'source':'rev','sequence':'ACGTACGTAC','start':100,'end':110,'strand':'-','source_length':1000,'coordinates':True}])
        self.store.add_block([
            {'source':'fwd','sequence':'ACGT','start':500,'end':504,'strand':'+','source_length':1000,'coordinates':True}])
        fwd,rev=stable_id('fwd'),stable_id('rev')
        # An interval inside block 1 finds both rows there and not block 2.
        found=self.store.blocks_in_range([fwd,rev],102,106)
        self.assertEqual(sorted({e['block'] for e in found}),[1])
        self.assertEqual(sorted(e['id'] for e in found),sorted([fwd,rev]))
        # The overlap is clamped to the interval, not the whole row.
        self.assertTrue(all((e['start'],e['end'])==(102,106) for e in found))
        # Columns come back in order whichever strand the row is on, and are
        # inside the block, so a layer built from them holds the right region.
        for entry in found:
            self.assertIsNotNone(entry['columns'])
            a,b=entry['columns']
            self.assertLess(a,b)
            self.assertGreaterEqual(a,0)
            self.assertLessEqual(b,10)
        # An interval only in the second block finds only that one.
        self.assertEqual([e['block'] for e in self.store.blocks_in_range([fwd],501,503)],[2])
        # Nothing outside any row, and an empty or backwards interval.
        self.assertEqual(self.store.blocks_in_range([fwd],900,950),[])
        self.assertEqual(self.store.blocks_in_range([fwd],100,100),[])
        self.assertEqual(self.store.blocks_in_range([],0,1000),[])

    def test_blocks_in_range_ignores_rows_without_coordinates(self):
        # A plain FASTA row has no source coordinates to search, so it cannot be
        # found by an interval rather than being matched at an invented zero.
        self.store.add_block([{'source':'plain','sequence':'ACGT'}])
        self.assertEqual(self.store.blocks_in_range([stable_id('plain')],0,10),[])
