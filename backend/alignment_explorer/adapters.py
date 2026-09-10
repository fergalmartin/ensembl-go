"""Optional native readers. Missing tools never silently change file semantics."""
import io
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from .store import clean_sequence, maf_blocks, stable_id


def hal_helper():
    override = os.environ.get('ENSEMBL_HAL_HELPER')
    candidates = [override, str(Path(sys.executable).parent / 'alignment_tools' / 'ensembl-hal'), shutil.which('ensembl-hal')]
    return next((p for p in candidates if p and Path(p).is_file() and os.access(p, os.X_OK)), None)


def native_capabilities():
    try:
        import taffy.lib  # noqa
        taf = True
    except ImportError: taf = False
    try:
        import pyBigWig  # noqa
        big = True
    except ImportError: big = False
    return {'hal': bool(hal_helper()), 'taf': taf, 'bigmaf': big, 'gfa': True,
            'hal_help': 'Install the ensembl-hal helper (backend/native/alignment_explorer) or set ENSEMBL_HAL_HELPER.',
            'taf_help': 'Install ComparativeGenomicsToolkit/taffy in the backend Python environment.'}


def run_hal(*args):
    helper = hal_helper()
    if not helper: raise ValueError(native_capabilities()['hal_help'])
    result = subprocess.run([helper, *map(str,args)], capture_output=True, text=True, timeout=90)
    if result.returncode: raise ValueError(result.stderr.strip()[:2000] or 'HAL reader failed')
    return result.stdout


def import_native(store, path, fmt, cancelled, progress):
    store.set_meta('format', fmt)
    store.set_meta('native_source', str(path))
    if fmt == 'hal':
        manifest = json.loads(run_hal('inventory', path))
        with store.connect() as db:
            for row in manifest['sequences']:
                source = row['source']
                db.execute('INSERT INTO sequences VALUES (?,?,?,?)', (stable_id(source), source, source, json.dumps(row)))
        store.set_meta('native_regions', True)
        store.set_meta('tree', manifest.get('tree'))
        store.set_meta('capabilities', {'native_regions': True, 'coordinates': True, 'ancestors': True, 'copies': True})
    elif fmt == 'taf':
        try: from taffy.lib import AlignmentReader
        except ImportError as exc: raise ValueError(native_capabilities()['taf_help']) from exc
        with AlignmentReader(str(path), make_row_links=False) as reader:
            for i, block in enumerate(reader):
                if cancelled(): raise InterruptedError('Import cancelled')
                rows=[]
                for r in block:
                    forward=r.start() if r.strand() else r.sequence_length()-r.start()-r.length()
                    rows.append({'source':r.sequence_name(),'sequence':clean_sequence(r.bases()),'start':forward,'end':forward+r.length(),'source_length':r.sequence_length(),'strand':'+' if r.strand() else '-','coordinates':True})
                store.add_block(rows, {'source_format':'taf'});progress(blocks=i+1)
    elif fmt == 'bigmaf':
        try: import pyBigWig
        except ImportError as exc: raise ValueError('bigMaf needs pyBigWig in the backend environment') from exc
        handle=pyBigWig.open(str(path))
        try:
            if not handle.isBigBed(): raise ValueError('Expected a bigMaf/bigBed file')
            count=0
            for chrom,length in handle.chroms().items():
                for start in range(0,length,1_000_000):
                    if cancelled(): raise InterruptedError('Import cancelled')
                    for a,b,text in handle.entries(chrom,start,min(length,start+1_000_000)) or []:
                        if a<start: continue
                        # bigMaf stores the original MAF block in its mafBlock field,
                        # replacing newlines with semicolons.
                        block_text=text.split('\t')[-1].replace(';','\n')
                        for rows,meta in maf_blocks(io.StringIO(block_text)):
                            store.add_block(rows,{**meta,'reference':chrom});count+=1
                    progress(blocks=count)
            if not count: raise ValueError('No MAF blocks found in bigBed mafBlock field')
        finally: handle.close()
    elif fmt == 'gfa':
        # Preserve graph topology. No invented multiple alignment between paths.
        graph=store.directory/'graph.sqlite'
        import sqlite3
        db=sqlite3.connect(graph)
        db.executescript('CREATE TABLE nodes(id TEXT PRIMARY KEY, sequence TEXT); CREATE TABLE links(a TEXT, a_dir TEXT, b TEXT, b_dir TEXT, overlap TEXT); CREATE TABLE paths(id TEXT PRIMARY KEY, nodes TEXT);')
        from .store import open_text
        try:
            with open_text(path) as handle:
                for line in handle:
                    if cancelled(): raise InterruptedError('Import cancelled')
                    p=line.rstrip('\n').split('\t')
                    if p[0]=='S': db.execute('INSERT INTO nodes VALUES (?,?)',(p[1],None if p[2]=='*' else clean_sequence(p[2])))
                    elif p[0]=='L': db.execute('INSERT INTO links VALUES (?,?,?,?,?)',tuple(p[1:6]))
                    elif p[0]=='P': db.execute('INSERT INTO paths VALUES (?,?)',(p[1],p[2]))
                    elif p[0]=='W':
                        import re
                        nodes=','.join(n+('+' if sign=='>' else '-') for sign,n in re.findall(r'([<>])([^<>]+)',p[6]))
                        db.execute('INSERT INTO paths VALUES (?,?)',(f'{p[1]}#{p[2]}#{p[3]}:{p[4]}-{p[5]}',nodes))
            db.commit()
            with store.connect() as dest:
                for source,nodes in db.execute('SELECT * FROM paths'):
                    dest.execute('INSERT INTO sequences VALUES (?,?,?,?)',(stable_id(source),source,source,json.dumps({'graph_path':True})))
            store.set_meta('graph',True)
            store.set_meta('capabilities',{'topology':True,'classical_alignment':False,'projection':'shared-node anchors only'})
        finally: db.close()


def extract_native_region(store, source, start, end):
    if end<=start or end-start>100_000: raise ValueError('Choose a native interval between 1 and 100,000 bases')
    meta=store.meta()
    if meta['format']!='hal': raise ValueError('This dataset does not require native regional extraction')
    # The helper streams a bounded, coordinate-preserving projection. Cache resulting
    # blocks without replacing the HAL hierarchy or treating projection as the source.
    key=f'{source}:{start}:{end}'
    with store.connect() as db:
        existing=[r['id'] for r in db.execute('SELECT id FROM blocks WHERE json_extract(metadata,\'$.native_region\')=?',(key,))]
    if existing: return {'blocks':existing}
    text=run_hal('region',meta['native_source'],source,start,end)
    ids=[]
    for rows,details in maf_blocks(io.StringIO(text)):
        ids.append(store.add_block(rows,{**details,'native_region':key}))
    if not ids: raise ValueError('No aligned columns in this native interval')
    return {'blocks':ids}


def graph_preview(store):
    import sqlite3
    path=store.directory/'graph.sqlite'
    if not path.is_file(): raise ValueError('This dataset has no graph topology')
    db=sqlite3.connect(path);db.row_factory=sqlite3.Row
    try:
        total=db.execute('SELECT count(*) FROM nodes').fetchone()[0]
        nodes=[dict(r) for r in db.execute('SELECT id,length(sequence) AS length FROM nodes LIMIT 300')]
        links=[dict(r) for r in db.execute('SELECT * FROM links LIMIT 2000')]
        return {'nodes':nodes,'links':links,'truncated':total>300,'total_nodes':total}
    finally: db.close()


def project_graph(store, source):
    """Project shared GFA nodes only; each anchor node remains a distinct block."""
    import sqlite3
    db=sqlite3.connect(store.directory/'graph.sqlite')
    try:
        row=db.execute('SELECT nodes FROM paths WHERE id=?',(source,)).fetchone()
        if not row: raise ValueError('Graph path not found')
        if db.execute("SELECT count(*) FROM links WHERE overlap!='0M'").fetchone()[0]:
            raise ValueError('Shared-node projection currently requires explicit zero-overlap (0M) links. Topology remains available.')
        anchor_nodes=row[0].split(',')
        if len(anchor_nodes)>10000: raise ValueError('Project a subgraph path containing at most 10,000 nodes')
        wanted=set(n[:-1] for n in anchor_nodes)
        occurrences={node:[] for node in wanted}
        for path,nodes in db.execute('SELECT * FROM paths'):
            steps=nodes.split(',');segments=[];position=0
            for step in steps:
                value=db.execute('SELECT length(sequence) FROM nodes WHERE id=?',(step[:-1],)).fetchone()
                if not value or value[0] is None: raise ValueError('Projection requires sequence for every node on a participating path')
                length=value[0]
                if step[:-1] in wanted: segments.append((step[:-1],step[-1],position,length))
                position+=length
            for node,strand,start,length in segments:
                occurrences[node].append({'source':path,'start':start,'end':start+length,'strand':strand,'source_length':position,'coordinates':True})
        ids=[]
        for step in anchor_nodes:
            node=step[:-1];seq=db.execute('SELECT sequence FROM nodes WHERE id=?',(node,)).fetchone()[0]
            if not seq: continue
            if len(seq)*max(1,len(occurrences[node]))>20_000_000: raise ValueError('Node projection exceeds 20 million alignment cells; extract a smaller subgraph')
            # All occurrences of a node share its forward-oriented sequence. Strand
            # records map that sequence back to each path, including reverse visits.
            rows=[{**r,'sequence':seq} for r in occurrences[node]]
            ids.append(store.add_block(rows,{'graph_node':node,'projection':'shared-node only','anchor_path':source}))
        if not ids: raise ValueError('No shared sequence nodes to project')
        return {'block':ids[0],'blocks':ids}
    finally: db.close()
