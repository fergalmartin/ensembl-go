import test from 'node:test'
import assert from 'node:assert/strict'
import { createFragment,createLayer,emptyWorkspace,cutFragment,moveSelection,mergeLayers,combineOverlaps,layerOverlap,tidyLayer,layerConnections,firstBlocks,selectionRect,validateLayerWorkspace,cellRanges } from '../src/components/alignment-explorer/layers.js'

function cells(fragments){const result=[];for(const f of fragments)for(const id of f.rowIds)for(const [a,z] of cellRanges(f,id))for(let i=a;i<z;i++)result.push(`${f.sourceBlock}:${id}:${i}`);return result.sort()}
function fixture(){const fragment=createFragment(1,0,12,['a','b','c']),layer=createLayer('Working',0,[fragment]);return {fragment,layer,state:{...emptyWorkspace(),layers:[layer],active:layer.id}}}
test('rectangle cut preserves exactly all input cells and no duplicates',()=>{const {fragment}=fixture(),cut=cutFragment(fragment,{start:3,end:8,rowIds:['b']});assert.deepEqual(cells([...cut.remaining,cut.extracted]),cells([fragment]));assert.equal(cells(cut.remaining).length,31);assert.deepEqual(cut.extracted.rowIds,['b'])})
test('moving selected cells removes source cells and keeps source coordinates',()=>{const {fragment,layer,state}=fixture(),target=createLayer('Region');state.selection=[{fragmentId:fragment.id,start:2,end:5,rowIds:['a','c']}];const next=moveSelection(state,target.id,{targetLayer:target});assert.equal(next.active,target.id);assert.deepEqual(cells(next.layers.flatMap(l=>l.fragments)),cells(layer.fragments));assert.deepEqual(next.layers[1].fragments.map(f=>[f.start,f.end]),[[2,5]]);assert.equal(state.layers[0].fragments.length,1)})
test('copy leaves original cells in source',()=>{const {fragment,state}=fixture(),target=createLayer('Copy');state.selection=[{fragmentId:fragment.id,start:1,end:3,rowIds:['b']}];const next=moveSelection(state,target.id,{copy:true,targetLayer:target});assert.deepEqual(next.layers[0].fragments,state.layers[0].fragments);assert.equal(cells(next.layers[1].fragments).length,2)})
test('merging overlapping intervals unions membership without adding unselected cells',()=>{const a=createFragment(1,0,8,['a']),b=createFragment(1,4,12,['b']);const combined=combineOverlaps([a,b],['a','b']);assert.equal(combined.length,1);assert.deepEqual(cells(combined),cells([a,b]));assert.deepEqual(combined[0].coverage,{a:[[0,8]],b:[[4,12]]})})
test('transitive overlap combines once; duplicate cells count once',()=>{const fragments=[createFragment(1,0,5,['a']),createFragment(1,8,12,['a']),createFragment(1,4,9,['a'])];const combined=combineOverlaps(fragments);assert.equal(combined.length,1);assert.equal(cells(combined).length,12)})
test('cutting a merged mask does not reveal absent cells',()=>{const [f]=combineOverlaps([createFragment(1,0,6,['a']),createFragment(1,4,10,['b'])]);const cut=cutFragment(f,{start:2,end:8,rowIds:['a','b']});assert.deepEqual(cells([...cut.remaining,cut.extracted]),cells([f]));assert.deepEqual(cut.extracted.coverage,{a:[[2,6]],b:[[4,8]]})})
test('overlap in different source blocks is never coalesced',()=>{const a=createLayer('A',0,[createFragment(1,0,5,['a'])]),b=createLayer('B',1,[createFragment(2,0,5,['a'])]);assert.equal(layerOverlap(a,b),false);assert.equal(combineOverlaps([...a.fragments,...b.fragments]).length,2)})
test('merge keep separate retains duplicate overlapping panels',()=>{const a=createLayer('A',0,[createFragment(1,0,8,['a'])]),b=createLayer('B',1,[createFragment(1,3,9,['b'])]);const state={...emptyWorkspace(),layers:[a,b],active:a.id};assert.equal(layerOverlap(a,b),true);const next=mergeLayers(state,a.id,b.id,false);assert.equal(next.layers.length,1);assert.equal(next.layers[0].fragments.length,2);assert.equal(mergeLayers(state,a.id,b.id,true).layers[0].fragments.length,1)})
test('strings use source order and omitted alignment columns regardless of placement',()=>{const a=createFragment(1,10,20,['a'],{x:400}),b=createFragment(1,40,50,['a'],{x:0});const layer=createLayer('A',0,[b,a]),[c]=layerConnections(layer);assert.equal(c.columns,20);assert.equal(c.from.id,a.id);assert.equal(firstBlocks(layer).get('a'),b.id)})
test('strings distinguish overlap and unknowable cross-block column gaps',()=>{const layer=createLayer('A',0,[createFragment(1,10,30,['a']),createFragment(1,20,40,['a']),createFragment(2,0,5,['a'])]);assert.deepEqual(layerConnections(layer).map(c=>c.columns),[-10,null])})
test('auto arrange aligns identical rows in shared slots',()=>{const layer=createLayer('A',0,[createFragment(1,20,30,['b','c']),createFragment(1,0,10,['a','c'])]);const next=tidyLayer(layer,['a','b','c']);assert.deepEqual(next.fragments.map(f=>f.start),[0,20]);assert.deepEqual(next.fragments.map(f=>f.slots),[[0,2],[1,2]])})
test('rectangle uses layout slots while columns include all rows',()=>{const layer=createLayer('A',0,[createFragment(1,10,20,['a','b'],{x:0,y:2,slots:[0,3]})]);assert.deepEqual(selectionRect(layer,{x1:2,x2:6,y1:4,y2:6})[0].rowIds,['b']);assert.deepEqual(selectionRect(layer,{x1:2,x2:6,y1:4,y2:6},true)[0].rowIds,['a','b']);assert.equal(selectionRect(layer,{x1:2,x2:6,y1:4,y2:6})[0].start,12)})
test('workspace roundtrip preserves masks, positions, camera and layer names',()=>{const {state}=fixture();state.layers[0].name='Promoter';state.camera={x:20,y:8,scale:12};const restored=validateLayerWorkspace(JSON.parse(JSON.stringify(state)),['a','b','c']);assert.deepEqual(restored,state);assert.throws(()=>validateLayerWorkspace({...state,version:1},['a']));assert.throws(()=>validateLayerWorkspace(state,['a']))})

test('automatic genome association requires an unambiguous assembly identifier',async()=>{
  const {exactGenomeLinks}=await import('../src/components/alignment-explorer/associations.js')
  const genome={species_key:'human',assembly:'GCA_123.1'},rows=[{id:'a',source:'GCA_123.1.chr1',metadata:{}},{id:'b',source:'human.chr1',metadata:{}},{id:'c',source:'GCA_123.1.chr2',metadata:{genome_key:'explicit'}}]
  assert.equal(exactGenomeLinks(rows,[genome]).length,1)
  assert.equal(exactGenomeLinks(rows,[genome])[0].chrom,'chr1')
  assert.equal(exactGenomeLinks(rows,[genome,{...genome,provider:'manual'}]).length,0)
})

test('drag hit testing only starts on highlighted cells, not other rows or gaps in membership',async()=>{
  const {selectedCellAt}=await import('../src/components/alignment-explorer/layers.js')
  const f=createFragment(1,100,120,['a','b'],{x:10,y:2,slots:[0,3],coverage:{a:[[100,108],[112,120]],b:[[100,120]]}})
  const l=createLayer('Selected',0,[f]),selection=[{fragmentId:f.id,start:104,end:116,rowIds:['a']}]
  assert.equal(selectedCellAt(l,selection,{x:15,y:2.5}),true)
  assert.equal(selectedCellAt(l,selection,{x:19,y:2.5}),false)
  assert.equal(selectedCellAt(l,selection,{x:15,y:5.5}),false)
  assert.equal(selectedCellAt(l,selection,{x:11,y:2.5}),false)
  assert.equal(selectedCellAt(l,selection,{x:26,y:2.5}),false)
  assert.equal(selectedCellAt(l,[],{x:15,y:2.5}),false)
})

test('zoom limits retain the full horizontal extent and prevent losing a layer',async()=>{
  const {fitCamera,constrainCamera}=await import('../src/components/alignment-explorer/layers.js')
  const layer=createLayer('Large',0,[createFragment(1,0,1e9,['a'],{x:-500})])
  const size={width:1000,height:600},fit=fitCamera(layer,size.width,size.height)
  assert.ok(fit.scale<1e-6,'large alignments can fit without an arbitrary scale floor')
  const bounded=constrainCamera(layer,{x:1e20,y:-1e20,scale:1e-20},size)
  assert.equal(bounded.scale,fit.scale)
  assert.ok(Math.abs(bounded.x+500)<1)
  assert.equal(bounded.y,0)
  const zoomed=constrainCamera(layer,{x:1e20,y:1e20,scale:12},size)
  assert.ok(zoomed.x<1e9)
})
test('vertical scrolling remains available for large row inventories',async()=>{
  const {constrainCamera}=await import('../src/components/alignment-explorer/layers.js')
  const layer=createLayer('Tall',0,[createFragment(1,0,100,Array.from({length:200},(_,i)=>String(i)))])
  const bounded=constrainCamera(layer,{x:0,y:900,scale:12},{width:1000,height:600})
  assert.equal(bounded.y,900)
})

test('new workspaces contain only the immutable original alignment',()=>{
  const state=emptyWorkspace();assert.equal(state.original,true);assert.deepEqual(state.layers,[])
})
test('inserting between chunks preserves vertical positions and makes horizontal room',async()=>{
  const {insertChunks}=await import('../src/components/alignment-explorer/layers.js')
  const first=createFragment(1,0,10,['a'],{x:0,y:4,slots:[2]})
  const last=createFragment(1,90,100,['a'],{x:30,y:9,slots:[3]})
  const middle=createFragment(1,40,60,['a'])
  const result=insertChunks([first,last],[middle],40)
  const a=result.find(f=>f.id===first.id),b=result.find(f=>f.id===middle.id),c=result.find(f=>f.id===last.id)
  assert.equal(a.x,0);assert.equal(a.y,4);assert.equal(c.y,9);assert.deepEqual(c.slots,[3])
  assert.equal(b.x,50);assert.equal(b.y,4);assert.deepEqual(b.slots,[2]);assert.equal(c.x,110)
  assert.equal(last.x,30,'input remains unchanged for undo')
})
test('fit-aware chunk spacing leaves room for connection labels',async()=>{
  const {chunkGap,insertChunks,fitCamera}=await import('../src/components/alignment-explorer/layers.js')
  const fragments=[createFragment(1,0,100,['a']),createFragment(1,500,600,['a'])]
  const gap=chunkGap(fragments,1000),layer=createLayer('Spaced',0,insertChunks([],fragments,gap))
  assert.ok(gap*fitCamera(layer,1000,500).scale>=100)
})
test('chunk FASTA includes every selected row and masks unselected cells without inventing gaps',async()=>{
  const {chunkFasta}=await import('../src/components/alignment-explorer/layers.js')
  const f=createFragment(2,10,15,['a','b'],{coverage:{a:[[10,12],[14,15]],b:[[10,15]]}})
  assert.equal(chunkFasta(f,[{id:'a',source:'chr1',sequence:'A-CGT'}]),'>a source=chr1 block=2 columns=11-15\nA-NNT\n>b source=b block=2 columns=11-15\nNNNNN\n')
})

test('zoom-out never restores an earlier camera while wider tiles arrive',async()=>{
  const {viewportCovered,transitionCamera}=await import('../src/components/alignment-explorer/regionTransition.js')
  const requests=['left','right'].map(id=>({id,request:{start:0,end:1000,ids:['a','b'],summary:true}}))
  const tile={data:{start:0,end:1000,detail:false,rows:[{id:'a'},{id:'b'}]}}
  const ready={layerId:'layer',camera:{x:400,y:0,scale:12}},camera={x:0,y:0,scale:.5}
  assert.equal(viewportCovered({left:tile},requests),false)
  assert.equal(transitionCamera('layer',camera,ready,false),camera)
  assert.equal(viewportCovered({left:tile,right:tile},requests),true)
  assert.equal(transitionCamera('layer',camera,ready,true),camera)
  assert.equal(transitionCamera('another',camera,ready,false),camera)
  const pan={...ready.camera,x:450}
  assert.equal(transitionCamera('layer',pan,ready,false),pan)
})
test('partial row data and narrow base tiles cannot stand in for a wider summary',async()=>{
  const {viewportCovered}=await import('../src/components/alignment-explorer/regionTransition.js')
  const requests=[{id:'f',request:{start:0,end:2000,ids:['a','b'],summary:true}}]
  assert.equal(viewportCovered({f:{data:{start:500,end:1000,detail:true,rows:[{id:'a'},{id:'b'}]}}},requests),false)
  assert.equal(viewportCovered({f:{data:{start:0,end:2000,detail:false,rows:[{id:'a'}]}}},requests),false)
})

test('saving Original rebases navigation to the visible source block',async()=>{
  const {workspaceForSave,sourceViewAnchor}=await import('../src/components/alignment-explorer/layers.js')
  const fragments=[createFragment(6,0,100,['a'],{x:1000}),createFragment(7,0,100,['a'],{x:1200})]
  const state={...emptyWorkspace(),sourceBlock:1,camera:{x:1225,y:40,scale:5}}
  assert.equal(sourceViewAnchor(fragments,state.camera).sourceBlock,7)
  const saved=workspaceForSave(state,fragments)
  assert.equal(saved.sourceBlock,7);assert.deepEqual(saved.camera,{x:25,y:40,scale:5})
  assert.equal(state.camera.x,1225,'saving does not move the visible strip')
})


test('Original camera limits depend on the dataset, not the loaded neighbour window',async()=>{
  const {constrainCamera}=await import('../src/components/alignment-explorer/layers.js')
  const camera={x:82000,y:0,scale:.6},size={width:1000,height:500}
  const a={id:'original',extent:100000,fragments:[createFragment(80,0,100,['a'],{x:82000})]}
  const b={...a,fragments:[createFragment(79,0,100,['a'],{x:81800}),...a.fragments,createFragment(81,0,100,['a'],{x:82200})]}
  assert.deepEqual(constrainCamera(a,camera,size),camera)
  assert.deepEqual(constrainCamera(b,camera,size),camera)
})
test('Original row identities stay aligned across changing memberships; compaction is explicit',async()=>{
  const {layoutOriginal}=await import('../src/components/alignment-explorer/originalLayout.js')
  const fragments=[createFragment(1,0,10,['c','a']),createFragment(2,0,10,['b','c'],{x:50})]
  const aligned=layoutOriginal(fragments,['a','b','c'])
  assert.deepEqual(aligned[0].slots,[0,2]);assert.deepEqual(aligned[1].slots,[1,2])
  assert.equal(aligned[0].layoutRows,3)
  const perBlock=layoutOriginal(fragments,['a','b','c'],'aligned',{2:'compact'},2)
  assert.equal(perBlock[0].compact,false);assert.equal(perBlock[1].compact,true)
  assert.deepEqual(perBlock[1].rowIds,['b','c'])
  const compact=layoutOriginal(fragments,['a','b','c'],'compact',{},2)
  assert.equal(compact[0].y,0);assert.equal(compact[1].y,0,'compact blocks stay visible at the top; labels use a shared gutter')
})
test('paths can be hit between endpoints, not only on their distance label',async()=>{
  const {hitCanvasItem}=await import('../src/components/alignment-explorer/originalLayout.js')
  const hit={points:[{x:10,y:20},{x:100,y:40},{x:200,y:40}]}
  assert.equal(hitCanvasItem(hit,{x:150,y:43}),true)
  assert.equal(hitCanvasItem(hit,{x:150,y:55}),false)
})

test('subpixel detail is summarized once and never drawn as flickering base stripes',async()=>{
  const {renderResolution}=await import('../src/components/alignment-explorer/renderResolution.js')
  const data={start:0,end:8,detail:true,focus:'a',rows:[{id:'a',sequence:'ACGTNN--'},{id:'b',sequence:'ATGTN---'}]}
  assert.equal(renderResolution(data,1),data)
  const summary=renderResolution(data,.5)
  assert.equal(summary.detail,false);assert.equal(summary.bin_size,8)
  assert.deepEqual(summary.rows[1].bins,[{A:1,T:2,G:1,N:1,'-':3}])
  assert.equal(summary.rows[1].divergence_bins[0].comparable,4)
  assert.equal(summary.rows[1].divergence_bins[0].different,1)
  assert.equal(renderResolution(data,.5),summary,'repeat camera frames reuse the prepared summary')
})

test('grouped block descriptors are never coordinate-selection targets',async()=>{
  const {coordinateFragments}=await import('../src/components/alignment-explorer/layers.js')
  // Mirrors useOriginalBlocks: an aggregate's end is end_x-x, spanning several
  // blocks plus the layout gaps between them, and its rowIds are the union of
  // rows present anywhere in the group. Offering it as "Block 1 · 1–2096"
  // would address alignment columns that do not exist.
  const grouped=createFragment(1,0,2096,['a','b'],{id:'aggregate:1:20',x:0,aggregate:{first:1,last:20,count:20,presence:{a:20,b:3}}})
  const single=createFragment(21,0,640,['a'],{id:'original:21',x:2128})
  assert.deepEqual(coordinateFragments({fragments:[grouped,single]}),[single])
  assert.deepEqual(coordinateFragments({fragments:[grouped]}),[])
  assert.deepEqual(coordinateFragments(null),[])
  // Drag selection has always skipped them; both paths must agree.
  assert.deepEqual(selectionRect({fragments:[grouped]},{x1:0,x2:2096,y1:-99,y2:99},true),[])
})

test('the grouped overview reports the block span it shows, not the first block',async()=>{
  const {visibleSourceRange}=await import('../src/components/alignment-explorer/layers.js')
  // Two aggregates covering blocks 1-100 and 101-200, laid out end to end.
  const group=(first,last,x,width)=>createFragment(first,0,width,['a'],{id:`aggregate:${first}:${last}`,x,aggregate:{first,last,count:last-first+1,presence:{a:1}}})
  const overview=[group(1,100,0,21000),group(101,200,21000,22000)]
  // Whole file in view: naming block 1 here would claim the view sits on the
  // first block while it actually shows all 200.
  const whole=visibleSourceRange(overview,{x:0,scale:900/43000},1080)
  assert.deepEqual(whole,{grouped:true,first:1,last:200})
  // Scrolled onto the second group only.
  assert.deepEqual(visibleSourceRange(overview,{x:30000,scale:900/12000},1080),{grouped:true,first:101,last:200})
  // Zoomed into a single block, the anchor block is still the current one.
  const single=createFragment(12,0,54340,['a'],{id:'original:12',x:80000})
  assert.deepEqual(visibleSourceRange([single],{x:80000,scale:.02},1080),{grouped:false,first:12,last:12})
  assert.equal(visibleSourceRange([],{x:0,scale:1},1080),null)
})

test('the drawn column and the selected column are the same column',async()=>{
  const {columnScale,layerXToColumn,BLOCK_EDGE_GAP,blockGap,panelGeometry}=await import('../src/components/alignment-explorer/layers.js')
  const MARGIN_X=156
  const panelRect=(f,camera)=>panelGeometry(f,camera,MARGIN_X)
  // Blocks are compressed into their rect minus a pixel channel, so the painter
  // and the screen->column inverse must use the same mapping or a click lands on
  // a different column than the one drawn under the cursor.
  for(const [span,scale] of [[3387,0.21],[65137,0.014],[1000000,0.0007],[955,8]]){
    const f=createFragment(1,0,span,['a'],{x:5000})
    const camera={x:4000,y:0,scale}
    const r=panelRect(f,camera)
    for(const column of [0,1,Math.floor(span/2),span-1]){
      const painted=r.x+(column-f.start)*r.scale
      const layerX=camera.x+(painted-MARGIN_X)/camera.scale
      // Exact equality would be hostage to float rounding at a column boundary;
      // what matters is that the inverse lands on the column that was drawn.
      assert.ok(Math.abs(layerXToColumn(f,camera,layerX)-column)<1e-6,`span ${span} scale ${scale} column ${column}`)
    }
    // The channel is real, and never eats more than a quarter of a narrow block.
    assert.ok(Math.abs((span*camera.scale-r.width)-blockGap(f,camera))<1e-6)
    assert.ok(blockGap(f,camera)<=BLOCK_EDGE_GAP)
    assert.ok(blockGap(f,camera)<=span*camera.scale*0.25+1e-9)
    assert.equal(r.scale,columnScale(f,camera))
    // The left edge stays on its exact affine position: camera.x keeps its meaning.
    assert.equal(r.x,MARGIN_X+(f.x-camera.x)*camera.scale)
  }
})

test('adjacent blocks are separated by the same pixel channel at every zoom',async()=>{
  const {BLOCK_EDGE_GAP,panelGeometry}=await import('../src/components/alignment-explorer/layers.js')
  const panelRect=(f,camera)=>panelGeometry(f,camera,156)
  // A short block beside a very long one: the stored layout spaces them equally
  // in columns, and the drawn channel between them is equal in pixels too.
  const short=createFragment(1,0,2000,['a'],{x:0})
  const long=createFragment(2,0,900000,['a'],{x:2032})
  for(const scale of [0.0005,0.002,0.02,0.2]){
    const camera={x:0,y:0,scale}
    const a=panelRect(short,camera),b=panelRect(long,camera)
    const channel=b.x-(a.x+a.width)
    // 32 stored columns plus the drawn channel, whatever the zoom.
    assert.ok(channel>=Math.min(BLOCK_EDGE_GAP,2000*scale*0.25),`scale ${scale} channel ${channel}`)
    assert.ok(channel<=BLOCK_EDGE_GAP+32*scale+1e-6,`scale ${scale} channel ${channel}`)
  }
})

test('a link skipping blocks becomes a marker on each block edge, pointing the same way',async()=>{
  const {blockJumpMarkers,pathIsOccluded}=await import('../src/components/alignment-explorer/layers.js')
  const rect=(sourceBlock,x,width)=>({sourceBlock,x,width,y:100,height:200})
  const link=(id,from,to)=>({id,rowId:'r',from:{id:`f${from}`,sourceBlock:from},to:{id:`f${to}`,sourceBlock:to}})
  const drawn=[rect(4,0,100),rect(5,140,100),rect(6,280,100),rect(7,420,100)]

  // Adjacent blocks have nothing in between, so the direct curve still carries them.
  assert.equal(pathIsOccluded(link('a',4,5),drawn),false)
  assert.deepEqual(blockJumpMarkers([link('a',4,5)],[],drawn),[])
  // Blocks that are not drawn cannot bury anything either.
  assert.deepEqual(blockJumpMarkers([link('a',4,7)],[],[rect(4,0,100),rect(7,420,100)]),[])

  // Skipping 5 and 6 gives one marker leaving block 4 and one entering block 7.
  const [out,into]=blockJumpMarkers([link('a',4,7)],[],drawn)
  assert.deepEqual([out.fragmentId,out.edge,out.flow,out.block],['f4',1,1,7])
  assert.deepEqual([into.fragmentId,into.edge,into.flow,into.block],['f7',-1,1,4])
  // Each names the block at the far end, so either is a jump target.
  assert.equal(out.block,7)
  assert.equal(into.block,4)
  // They sit on opposite edges but point the same way, so the link reads as one
  // direction of travel rather than two unrelated arrows.
  assert.equal(out.flow,into.flow)
  assert.notEqual(out.edge,into.edge)

  // A backwards link mirrors both ends rather than crossing them over.
  const [bout,bin]=blockJumpMarkers([link('b',7,4)],[],drawn)
  assert.deepEqual([bout.fragmentId,bout.edge,bout.flow],['f7',-1,-1])
  assert.deepEqual([bin.fragmentId,bin.edge,bin.flow],['f4',1,-1])

  // A path leaving the loaded window contributes only the end that exists.
  const off=[{id:'off',rowId:'r',fragment:{id:'f7'},block:145,direction:1}]
  const [only]=blockJumpMarkers([],off,drawn)
  assert.deepEqual([only.fragmentId,only.edge,only.flow,only.block],['f7',1,1,145])
  assert.equal(blockJumpMarkers([],off,drawn).length,1)
})

test('paths continuing outside the loaded window become stubs on the outermost block holding the row',async()=>{
  const {offWindowLinks}=await import('../src/components/alignment-explorer/layers.js')
  const block=(n,ids)=>createFragment(n,0,100,ids,{id:`original:${n}`,x:n*132})
  const layer={fragments:[block(4,['a','b']),block(5,['a']),block(6,['a','b'])]}
  const links=offWindowLinks(layer,{before:{a:2},after:{a:40,b:51}})
  const find=(rowId,direction)=>links.find(l=>l.rowId===rowId&&l.direction===direction)
  // 'a' continues both ways; the stubs hang off the first and last loaded block
  // holding it, not off whichever fragment happened to be listed first.
  assert.equal(find('a',-1).fragment.sourceBlock,4)
  assert.equal(find('a',-1).block,2)
  assert.equal(find('a',1).fragment.sourceBlock,6)
  assert.equal(find('a',1).block,40)
  // 'b' is absent from block 5, so its last loaded block is still 6.
  assert.equal(find('b',1).fragment.sourceBlock,6)
  assert.equal(find('b',1).block,51)
  // Nothing off the left for 'b': the window edge is where its path starts.
  assert.equal(find('b',-1),undefined)
  assert.equal(links.length,3)
  // Aggregates describe runs of blocks and can never anchor a stub.
  const grouped={fragments:[{...block(4,['a']),aggregate:{first:4,last:20,count:17,presence:{}}}]}
  assert.deepEqual(offWindowLinks(grouped,{before:{a:2},after:{a:40}}),[])
  assert.deepEqual(offWindowLinks(layer,null),[])
  assert.deepEqual(offWindowLinks(layer,{before:{},after:{}}),[])
})

test('level of detail keeps blocks readable and merges only when they are many',async()=>{
  const {mergeWidth,BLOCK_DETAIL_SPAN,MERGED_BLOCKS_ON_SCREEN}=await import('../src/components/alignment-explorer/layers.js')
  // Zoomed in far enough to read a block, never merge.
  assert.equal(mergeWidth(1),0)
  assert.equal(mergeWidth(BLOCK_DETAIL_SPAN),0)
  assert.ok(mergeWidth(BLOCK_DETAIL_SPAN+1)>0)
  // Roughly a dozen merged blocks on screen at any zoom past the threshold.
  for(const span of [900_000,5_000_000,43_023_632,400_000_000]){
    const onScreen=span/mergeWidth(span)
    assert.ok(onScreen>=MERGED_BLOCKS_ON_SCREEN/2&&onScreen<=MERGED_BLOCKS_ON_SCREEN*2,`${span} -> ${onScreen}`)
  }
  // Powers of two, so levels nest: a merged block splits in half on zooming in
  // rather than resegmenting into unrelated groups, and every level caches.
  for(const span of [900_000,5_000_000,43_023_632]){
    const w=mergeWidth(span)
    assert.equal(w,2**Math.round(Math.log2(w)))
    assert.ok(mergeWidth(span/2)===w/2||mergeWidth(span/2)===0,`${span} does not nest`)
  }
  // The whole primate file lands near the 5M-per-merge size this was sized for.
  assert.equal(mergeWidth(43_023_632),4_194_304)
})

test('pointing inside a merged block finds the block actually under the cursor',async()=>{
  const {blockAtLayoutX}=await import('../src/components/alignment-explorer/layers.js')
  // Widths differ by two orders of magnitude, so dividing the merge evenly would
  // name the wrong block almost everywhere.
  const edges=[{block:7,x:1000,end_x:1_001_000},{block:8,x:1_001_032,end_x:1_003_032},{block:9,x:1_003_064,end_x:1_103_064}]
  const merged={aggregate:{first:7,last:9,count:3,edges}}
  assert.equal(blockAtLayoutX(merged,1000).block,7)
  assert.equal(blockAtLayoutX(merged,900_000).block,7)
  assert.equal(blockAtLayoutX(merged,1_002_000).block,8)
  assert.equal(blockAtLayoutX(merged,1_100_000).block,9)
  // The gaps between blocks belong to no block, and neither does outside.
  assert.equal(blockAtLayoutX(merged,1_001_010),null)
  assert.equal(blockAtLayoutX(merged,10),null)
  // A merge too fine-grained to carry its edges points at nothing rather than guessing.
  assert.equal(blockAtLayoutX({aggregate:{first:1,last:900,count:900,edges:[]}},500),null)
  assert.equal(blockAtLayoutX({},500),null)
  assert.equal(blockAtLayoutX(null,500),null)
})

test('a gap found at any resolution is remembered and never fills back in',async()=>{
  const {createGapMemory,rememberGaps,gapRanges,visibleGaps}=await import('../src/components/alignment-explorer/gapMemory.js')
  const memory=createGapMemory()

  // A coarse tile proves only the bins that are wholly gap. A bin merely
  // containing gap says nothing about where inside it the gap falls, so it
  // contributes nothing rather than a guess.
  const coarse={start:0,end:400,bin_size:100,detail:false,rows:[{id:'a',bins:[
    {A:60,'-':40},{'-':100},{'-':100},{C:100}]}]}
  assert.deepEqual(gapRanges(coarse,coarse.rows[0]),[[100,200],[200,300]])
  rememberGaps(memory,7,coarse)
  assert.deepEqual(visibleGaps(memory,7,'a',0,400),[[100,300]])

  // Detail over the same region gives exact runs. It can only ever add gap the
  // coarse pass could not see; it can never contradict it.
  const detail={start:0,end:400,detail:true,rows:[{id:'a',sequence:'A'.repeat(60)+'-'.repeat(240)+'C'.repeat(100)}]}
  assert.deepEqual(gapRanges(detail,detail.rows[0]),[[60,300]])
  rememberGaps(memory,7,detail)
  assert.deepEqual(visibleGaps(memory,7,'a',0,400),[[60,300]])

  // Replaying the coarse tile afterwards, as a repaint driven by an older tile
  // would, must not shrink what is known.
  rememberGaps(memory,7,coarse)
  assert.deepEqual(visibleGaps(memory,7,'a',0,400),[[60,300]])

  // Clipped to the window asked for, and kept apart per block and per row.
  assert.deepEqual(visibleGaps(memory,7,'a',100,200),[[100,200]])
  assert.deepEqual(visibleGaps(memory,7,'b',0,400),[])
  assert.deepEqual(visibleGaps(memory,8,'a',0,400),[])

  // Too narrow to be its own mark, so it waits for the camera rather than
  // stippling the bottom of every block.
  assert.deepEqual(visibleGaps(memory,7,'a',0,400,300),[])
  assert.deepEqual(visibleGaps(memory,7,'a',0,400,240),[[60,300]])

  // A row with no gap at all leaves nothing behind.
  assert.deepEqual(gapRanges({start:0,end:4,detail:true,rows:[]},{id:'z',sequence:'ACGT'}),[])
  assert.equal(rememberGaps(memory,7,{rows:[{id:'a',sequence:'ACGT'}],start:0,end:4,detail:true}),false)
})

test('every finer view of a remembered gap is still a gap',async()=>{
  const {gapRanges}=await import('../src/components/alignment-explorer/gapMemory.js')
  // The property the memory relies on: an all-gap bin cannot contain sequence at
  // any finer resolution, so remembering it can never be wrong later.
  // Deliberately not aligned to any bin grid: the coarse pass must then see
  // strictly fewer gap columns than the fine one, which is the case that matters.
  const sequence='A'.repeat(55)+'-'.repeat(190)+'G'.repeat(55)
  const bin=(size)=>{
    const rows=[{id:'a',bins:[]}]
    for(let i=0;i<sequence.length;i+=size){
      const counts={}
      for(const c of sequence.slice(i,i+size))counts[c]=(counts[c]||0)+1
      rows[0].bins.push(counts)
    }
    return {start:0,end:sequence.length,bin_size:size,detail:false,rows}
  }
  const covered=size=>{
    const data=bin(size)
    return gapRanges(data,data.rows[0]).flatMap(([a,z])=>{const out=[];for(let i=a;i<z;i++)out.push(i);return out})
  }
  const coarse=new Set(covered(50)),fine=new Set(covered(10))
  assert.ok(coarse.size>0&&fine.size>coarse.size)
  // Everything the coarse pass called gap is still gap when cut finer.
  for(const column of coarse)assert.ok(fine.has(column),`column ${column} stopped being a gap`)
  // And every column either pass calls gap really is one.
  for(const column of fine)assert.equal(sequence[column],'-')
})

test('a wheel over the name list scrolls the rows, not the track',async()=>{
  const {wheelScrollsRowList}=await import('../src/components/alignment-explorer/layers.js')
  const MARGIN_X=156
  // Over the gutter, a vertical wheel belongs to the row list.
  assert.equal(wheelScrollsRowList(20,{dx:0,dy:40},MARGIN_X),true)
  assert.equal(wheelScrollsRowList(155,{dx:3,dy:-40},MARGIN_X),true)
  // Over the alignment it never does, however vertical: the track keeps its
  // wheel behaviour everywhere the reader is actually looking at sequence.
  assert.equal(wheelScrollsRowList(156,{dx:0,dy:40},MARGIN_X),false)
  assert.equal(wheelScrollsRowList(900,{dx:0,dy:40},MARGIN_X),false)
  // A sideways swipe over the gutter still pans the alignment, as it does
  // everywhere else, rather than being swallowed by the list.
  assert.equal(wheelScrollsRowList(20,{dx:-40,dy:0},MARGIN_X),false)
  assert.equal(wheelScrollsRowList(20,{dx:40,dy:12},MARGIN_X),false)
  // Nothing to do is not a scroll.
  assert.equal(wheelScrollsRowList(20,{dx:0,dy:0},MARGIN_X),false)
  assert.equal(wheelScrollsRowList(20,undefined,MARGIN_X),false)
})

test('names, blocks and regions are picked into one list and toggle off',async()=>{
  const {togglePicks,blockPick,rowPicks,pickedRowIds,resolvePicks}=await import('../src/components/alignment-explorer/layers.js')
  const f1=createFragment(1,0,100,['a','b','c'],{id:'f1'}),f2=createFragment(2,0,80,['a','c'],{id:'f2'})
  const layer={fragments:[f1,f2]}

  // A name picks its whole extent in every fragment holding it, so the parts of
  // the path off screen come too.
  let sel=togglePicks([],rowPicks(layer,'a'))
  assert.deepEqual(sel.map(p=>[p.fragmentId,p.start,p.end,p.rowIds]),[['f1',0,100,['a']],['f2',0,80,['a']]])
  assert.deepEqual([...pickedRowIds(sel)],['a'])
  // A second name adds rather than replaces.
  sel=togglePicks(sel,rowPicks(layer,'c'))
  assert.deepEqual([...pickedRowIds(sel)].sort(),['a','c'])
  // Clicking the same name again takes just that one back out.
  sel=togglePicks(sel,rowPicks(layer,'a'))
  assert.deepEqual([...pickedRowIds(sel)],['c'])
  // 'b' is only in f1, so picking it adds one entry.
  assert.equal(togglePicks(sel,rowPicks(layer,'b')).length,3)

  // Blocks and regions live in the same list, so they can be mixed and moved together.
  sel=togglePicks(sel,[blockPick(f2)])
  sel=togglePicks(sel,[{kind:'region',fragmentId:'f1',start:10,end:20,rowIds:['b']}])
  // 'c' is in both fragments, so it stands as two row picks.
  assert.deepEqual(sel.map(p=>p.kind).sort(),['block','region','row','row'])
  // Toggling a block off leaves everything else alone.
  assert.deepEqual(togglePicks(sel,[blockPick(f2)]).map(p=>p.kind).sort(),['region','row','row'])
})

test('a picked block takes the whole block; regions elsewhere stay separate',async()=>{
  const {resolvePicks,blockPick}=await import('../src/components/alignment-explorer/layers.js')
  const f1=createFragment(1,0,100,['a','b'],{id:'f1'})
  const selection=[
    blockPick(f1),
    {kind:'row',fragmentId:'f1',start:0,end:100,rowIds:['a']},
    {kind:'region',fragmentId:'f1',start:10,end:20,rowIds:['b']},
    {kind:'region',fragmentId:'f2',start:5,end:15,rowIds:['a']},
  ]
  const resolved=resolvePicks(selection)
  // Everything inside the picked block folds into it; cutting the row and region
  // out separately would only fragment what was asked for whole.
  assert.deepEqual(resolved.map(p=>[p.kind,p.fragmentId]),[['block','f1'],['region','f2']])
  // With no block picked, the pieces stay the pieces they were.
  assert.deepEqual(resolvePicks(selection.slice(1)).map(p=>[p.kind,p.fragmentId]),
    [['row','f1'],['region','f1'],['region','f2']])
})

test('several picks on one fragment all move, taking their cells from the source',async()=>{
  const {moveSelection,createLayer,emptyWorkspace,cellRanges}=await import('../src/components/alignment-explorer/layers.js')
  const cells=frs=>{const out=[];for(const f of frs)for(const id of f.rowIds)for(const [a,z] of cellRanges(f,id))for(let i=a;i<z;i++)out.push(`${f.sourceBlock}:${id}:${i}`);return out.sort()}
  const fragment=createFragment(1,0,30,['a','b'],{id:'f1'})
  const layer=createLayer('Working',0,[fragment])
  const state={...emptyWorkspace(),layers:[layer],active:layer.id,selection:[
    {kind:'region',fragmentId:'f1',start:0,end:10,rowIds:['a']},
    {kind:'region',fragmentId:'f1',start:20,end:30,rowIds:['b']},
  ]}
  const target=createLayer('Region')
  const next=moveSelection(state,target.id,{targetLayer:target})
  const moved=next.layers.find(l=>l.id===target.id).fragments
  // Both regions arrive, as the two pieces they were drawn as.
  assert.equal(moved.length,2)
  assert.deepEqual(moved.map(f=>[f.start,f.end,f.rowIds]).sort(),[[0,10,['a']],[20,30,['b']]])
  // No cell is lost and none is duplicated: the second pick cut what the first left.
  assert.deepEqual(cells(next.layers.flatMap(l=>l.fragments)),cells([fragment]))
})

test('auto arrange stacks overlapping chunks and keeps their columns aligned',async()=>{
  const {tidyLayer,createLayer}=await import('../src/components/alignment-explorer/layers.js')
  // Two chunks of block 1 share columns 40-60; a third is clear of both.
  const a=createFragment(1,0,60,['x'],{id:'a'}),b=createFragment(1,40,100,['y'],{id:'b'}),c=createFragment(1,200,240,['x'],{id:'c'})
  const tidy=tidyLayer(createLayer('L',0,[a,b,c]),['x','y'],64)
  const at=id=>tidy.fragments.find(f=>f.id===id)
  // The overlapping pair is aligned on source coordinates, so column 50 is at the
  // same place in both, and stacked so they do not collide.
  assert.equal(at('b').x-at('a').x,40)
  assert.notEqual(at('a').y,at('b').y)
  // The chunk clear of them keeps being packed rather than inheriting the empty
  // columns that lay between them in the source.
  assert.ok(at('c').x<200)
  assert.equal(at('c').y,0)
  // Nothing overlaps once placed.
  const box=f=>({x1:f.x,x2:f.x+f.end-f.start,y1:f.y,y2:f.y+Math.max(...f.slots,-1)+1})
  const boxes=tidy.fragments.map(box)
  for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){
    const p=boxes[i],q=boxes[j]
    assert.ok(p.x2<=q.x1||q.x2<=p.x1||p.y2<=q.y1||q.y2<=p.y1,`${i} and ${j} overlap`)
  }
})

test('filters narrow sequences by words, links and size',async()=>{
  const {filterSequences,parseTerms,matchesTerms}=await import('../src/components/alignment-explorer/filters.js')
  const rows=[
    {id:'1',source:'homo_sapiens.1',blocks:200,bases:23165866,genome_key:'human'},
    {id:'2',source:'gorilla_gorilla.1',blocks:180,bases:19000000,genome_key:null},
    {id:'3',source:'ancestral_sequences.Ancestor_2006_1',blocks:4,bases:12000,genome_key:null},
  ]
  // Include is any-of, so two species can be asked for at once.
  assert.deepEqual(filterSequences(rows,{include:'homo gorilla'}).map(r=>r.id),['1','2'])
  // Exclude always wins, so a term can be taken back out of a broad include.
  assert.deepEqual(filterSequences(rows,{include:'a',exclude:'ancestral'}).map(r=>r.id),['1','2'])
  // Ancestors and unplaced rows are the usual reason to want one side or other.
  assert.deepEqual(filterSequences(rows,{genome:'linked'}).map(r=>r.id),['1'])
  assert.deepEqual(filterSequences(rows,{genome:'unlinked'}).map(r=>r.id),['2','3'])
  // Ranges, with a blank bound meaning no bound rather than zero.
  assert.deepEqual(filterSequences(rows,{minBlocks:'100'}).map(r=>r.id),['1','2'])
  assert.deepEqual(filterSequences(rows,{maxBlocks:'100'}).map(r=>r.id),['3'])
  assert.deepEqual(filterSequences(rows,{minBases:'',maxBases:''}).map(r=>r.id),['1','2','3'])
  // An empty filter keeps everything, so the panel opens on the whole alignment.
  assert.equal(filterSequences(rows,{}).length,3)
  assert.deepEqual(parseTerms(' Human, gorilla  '),['human','gorilla'])
  assert.equal(matchesTerms('Homo sapiens',[],[]),true)
})

test('block filters read number ranges and narrow to the chosen sequences',async()=>{
  const {filterBlocks,parseNumberRanges}=await import('../src/components/alignment-explorer/filters.js')
  const blocks=[{id:1,length:1000,rows:20,available:20},{id:5,length:900000,rows:30,available:28},{id:44,length:50000,rows:4,available:4}]
  assert.deepEqual(parseNumberRanges('1-20, 44, 60-70'),[[1,20],[44,44],[60,70]])
  // Reversed ends are read the way round they were meant.
  assert.deepEqual(parseNumberRanges('20-1'),[[1,20]])
  // Half-typed input is ignored rather than filtering everything out.
  assert.deepEqual(parseNumberRanges('1-'),[])
  assert.deepEqual(filterBlocks(blocks,{numbers:'1-10'}).map(b=>b.id),[1,5])
  assert.deepEqual(filterBlocks(blocks,{minLength:'40000'}).map(b=>b.id),[5,44])
  assert.deepEqual(filterBlocks(blocks,{minRows:'10'}).map(b=>b.id),[1,5])
  // Narrowing sequences narrows the blocks on offer; block criteria still apply on top.
  assert.deepEqual(filterBlocks(blocks,{},new Set([5,44])).map(b=>b.id),[5,44])
  assert.deepEqual(filterBlocks(blocks,{minLength:'100000'},new Set([5,44])).map(b=>b.id),[5])
})

test('ticking nothing means the filter is the choice; ticking makes the ticks the choice',async()=>{
  const {effectiveChoice,filterChunks}=await import('../src/components/alignment-explorer/filters.js')
  const filtered=[{id:'a'},{id:'b'},{id:'c'}]
  // A reader who narrows to three does not then have to tick three boxes.
  assert.deepEqual(effectiveChoice(filtered,new Set()),['a','b','c'])
  assert.deepEqual(effectiveChoice(filtered,null),['a','b','c'])
  assert.deepEqual(effectiveChoice(filtered,new Set(['b'])),['b'])
  // A tick left behind by an earlier filter cannot come back through a later one.
  assert.deepEqual(effectiveChoice(filtered,new Set(['b','zz'])),['b'])
  // If the filter has moved past every tick, the filter is the choice again
  // rather than the panel silently applying to nothing.
  assert.deepEqual(effectiveChoice(filtered,new Set(['zz'])),['a','b','c'])

  // A chunk per chosen block, holding only the sequences that block really has:
  // 'c' is not in block 5, and inventing a row for it would put cells in a layer
  // that are not in the alignment.
  const membership=[{block:5,ids:['a','b']},{block:9,ids:['a','c']}]
  const lengths=new Map([[5,1000],[9,2000]])
  assert.deepEqual(filterChunks(membership,[5,9],['a','c'],lengths),
    [{sourceBlock:5,start:0,end:1000,rowIds:['a']},{sourceBlock:9,start:0,end:2000,rowIds:['a','c']}])
  // Blocks not chosen contribute nothing, and neither does one with no length known.
  assert.deepEqual(filterChunks(membership,[9],['a'],lengths),[{sourceBlock:9,start:0,end:2000,rowIds:['a']}])
  assert.deepEqual(filterChunks(membership,[5,9],['zz'],lengths),[])
  assert.deepEqual(filterChunks(null,[5],['a'],lengths),[])
})

test('the Original filter hides rows and blocks without touching the source',async()=>{
  const {layoutOriginal}=await import('../src/components/alignment-explorer/originalLayout.js')
  const f1=createFragment(1,0,100,['a','b','c'],{id:'f1',x:0})
  const f2=createFragment(2,0,100,['a','c'],{id:'f2',x:132})
  const ids=['a','b','c']
  // No filter: everything is laid out, as Original always has been.
  assert.equal(layoutOriginal([f1,f2],ids).length,2)
  assert.deepEqual(layoutOriginal([f1,f2],ids)[0].rowIds,['a','b','c'])
  // Rows outside the filter are not laid out, and the survivors close up rather
  // than leaving the gaps where the hidden ones were.
  const rows=layoutOriginal([f1,f2],ids,'aligned',{},undefined,{sequences:['a','c']})
  assert.deepEqual(rows[0].rowIds,['a','c'])
  assert.deepEqual(rows[0].slots,[0,1])
  assert.equal(rows[0].layoutRows,2)
  // Blocks outside the filter drop out of the view.
  const only=layoutOriginal([f1,f2],ids,'aligned',{},undefined,{blocks:[2]})
  assert.deepEqual(only.map(f=>f.sourceBlock),[2])
  // An empty filter is no filter, so clearing brings everything straight back.
  assert.equal(layoutOriginal([f1,f2],ids,'aligned',{},undefined,{sequences:[],blocks:[]}).length,2)
})

test('a coordinate filter takes each row its own overlapping columns',async()=>{
  const {rangeChunks}=await import('../src/components/alignment-explorer/filters.js')
  // The same genomic numbers mean different places in different sequences, so
  // within one block each matched row lands on its own column range.
  const matches=[
    {block:47,id:'human',start:5_317_521,end:5_348_311,columns:[1,43479]},
    {block:47,id:'gorilla',start:5_317_521,end:5_348_311,columns:[900,44000]},
    {block:73,id:'human',start:5_000_000,end:5_204_048,columns:[673441,1000000]},
    {block:99,id:'human',start:1,end:2,columns:null},
  ]
  const chunks=rangeChunks(matches,[47,73,99])
  assert.equal(chunks.length,2)
  // The chunk spans both rows, but coverage keeps each to its own columns rather
  // than handing back columns outside the interval for the narrower row.
  assert.deepEqual([chunks[0].sourceBlock,chunks[0].start,chunks[0].end],[47,1,44000])
  assert.deepEqual(chunks[0].coverage,{human:[[1,43479]],gorilla:[[900,44000]]})
  assert.deepEqual(chunks[0].rowIds,['human','gorilla'])
  // A row whose interval falls where it has no aligned bases gives no columns,
  // so block 99 contributes no chunk at all.
  assert.deepEqual(chunks.map(c=>c.sourceBlock),[47,73])
  // Blocks not chosen contribute nothing.
  assert.deepEqual(rangeChunks(matches,[73]).map(c=>c.sourceBlock),[73])
  assert.deepEqual(rangeChunks(null,[47]),[])
})

test('filter terms work as a collected list, not only as typed text',async()=>{
  const {parseTerms,filterSequences,isDefaultFilter,SEQUENCE_FILTER}=await import('../src/components/alignment-explorer/filters.js')
  // Terms arrive as a list once they are chips, and as typed text before that.
  assert.deepEqual(parseTerms(['Human',' Gorilla ','']),['human','gorilla'])
  assert.deepEqual(parseTerms('Human, gorilla'),['human','gorilla'])
  assert.deepEqual(parseTerms([]),[])
  assert.deepEqual(parseTerms(undefined),[])

  const rows=[
    {id:'1',source:'homo_sapiens.1',blocks:200,bases:1,genome_key:null},
    {id:'2',source:'gorilla_gorilla.1',blocks:180,bases:1,genome_key:null},
    {id:'3',source:'ancestral_sequences.Ancestor_1',blocks:4,bases:1,genome_key:null},
  ]
  // A list of chips filters exactly as the equivalent typed text did.
  assert.deepEqual(filterSequences(rows,{include:['homo','gorilla']}).map(r=>r.id),['1','2'])
  assert.deepEqual(filterSequences(rows,{include:'homo gorilla'}).map(r=>r.id),['1','2'])
  assert.deepEqual(filterSequences(rows,{exclude:['ancestral']}).map(r=>r.id),['1','2'])
  // Removing the last chip is the same as never having filtered.
  assert.deepEqual(filterSequences(rows,{include:[]}).map(r=>r.id),['1','2','3'])

  // An empty term list still counts as untouched, so clearing the chips stops
  // the panel treating the sequence side as narrowing anything.
  assert.equal(isDefaultFilter({...SEQUENCE_FILTER},SEQUENCE_FILTER),true)
  assert.equal(isDefaultFilter({...SEQUENCE_FILTER,include:[]},SEQUENCE_FILTER),true)
  assert.equal(isDefaultFilter({...SEQUENCE_FILTER,include:['human']},SEQUENCE_FILTER),false)
})

test('the cycle rail reads a cursor where it drew its dots',async()=>{
  const {cycleRailGeometry,cycleRailPosition,cyclePointerDragged,CYCLE_DRAG_THRESHOLD}=await import('../src/utils/genomeWheel.js')
  const button={left:400,right:440,bottom:100,top:80}
  const rail=cycleRailGeometry(5,button,900)
  // The rail hangs off the button and is centred on it, so it opens under the
  // hand rather than at some offset the pointer mapping then has to guess at.
  assert.equal(rail.center,420)
  assert.equal(rail.top,108)
  // A cursor on a dot reads as exactly that face. This is the pairing that was
  // wrong: the rail drew dots at padding + i*spacing while the pointer was read
  // against a different padding, so the indicator trailed the cursor.
  for(let i=0;i<5;i++){
    const dotY=rail.top+rail.padding+i*rail.spacing
    assert.ok(Math.abs(cycleRailPosition(dotY,rail,5)-i)<1e-9,`dot ${i} did not read as face ${i}`)
  }
  // Halfway between two dots reads as halfway between two faces.
  assert.ok(Math.abs(cycleRailPosition(rail.top+rail.padding+rail.spacing*1.5,rail,5)-1.5)<1e-9)
  // Past either end it clamps rather than running off the list.
  assert.equal(cycleRailPosition(-999,rail,5),0)
  assert.equal(cycleRailPosition(9999,rail,5),4)

  // A press that never travels is a click, which is what leaves the wheel open
  // to follow the bare cursor; a deliberate drag always registers.
  assert.equal(cyclePointerDragged({x:100,y:100},100,100),false)
  assert.equal(cyclePointerDragged({x:100,y:100},100,100+CYCLE_DRAG_THRESHOLD),false)
  assert.equal(cyclePointerDragged({x:100,y:100},100,100+CYCLE_DRAG_THRESHOLD+1),true)
  assert.equal(cyclePointerDragged(null,100,999),false)
})

test('a row can be moved through the order without losing any row',async()=>{
  const {moveRow,resolveRowOrder}=await import('../src/components/alignment-explorer/layers.js')
  const order=['a','b','c','d','e']
  // Down: the gap the row left closes behind it, so landing on index 3 puts it
  // third rather than fourth.
  assert.deepEqual(moveRow(order,'a',3),['b','c','d','a','e'])
  // Up.
  assert.deepEqual(moveRow(order,'e',1),['a','e','b','c','d'])
  // The ends, and a move that goes nowhere.
  assert.deepEqual(moveRow(order,'c',0),['c','a','b','d','e'])
  assert.deepEqual(moveRow(order,'c',99),['a','b','d','e','c'])
  assert.deepEqual(moveRow(order,'c',2),order)
  // Every row survives every move.
  for(const id of order)for(let i=-2;i<8;i++){
    const moved=moveRow(order,id,i)
    assert.deepEqual([...moved].sort(),[...order].sort(),`moving ${id} to ${i} changed the set of rows`)
  }
  // A row that is not there leaves the order alone.
  assert.deepEqual(moveRow(order,'zz',2),order)
})

test('a saved row order survives rows arriving and leaving',async()=>{
  const {resolveRowOrder}=await import('../src/components/alignment-explorer/layers.js')
  // No saved order is the dataset's own order.
  assert.deepEqual(resolveRowOrder(['a','b','c'],null),['a','b','c'])
  assert.deepEqual(resolveRowOrder(['a','b','c'],[]),['a','b','c'])
  // The saved arrangement is honoured where it still applies.
  assert.deepEqual(resolveRowOrder(['a','b','c'],['c','a','b']),['c','a','b'])
  // Rows the order never heard of keep their natural place at the end, rather
  // than being dropped: a reordering must never make a sequence vanish.
  assert.deepEqual(resolveRowOrder(['a','b','c','d'],['c','a']),['c','a','b','d'])
  // Rows the order names but the dataset no longer has are simply skipped.
  assert.deepEqual(resolveRowOrder(['a','b'],['zz','b','a']),['b','a'])
  // A duplicated id in a saved order cannot duplicate a row.
  assert.deepEqual(resolveRowOrder(['a','b'],['a','a','b']),['a','b'])
  // Whatever the saved order, the result is always exactly the dataset's rows.
  for(const custom of [['c'],['d','c','b','a'],['zz'],['b','b']])
    assert.deepEqual([...resolveRowOrder(['a','b','c','d'],custom)].sort(),['a','b','c','d'])
})

test('moving a row inside a chunk redeals that chunk only',async()=>{
  const {reorderFragmentRow,rowSlot,rowCount}=await import('../src/components/alignment-explorer/layers.js')
  // A chunk in the second band: its slots start at 4, not 0.
  const f=createFragment(1,0,100,['a','b','c'],{id:'f1',slots:[4,5,6]})
  const order=frag=>[...frag.rowIds].sort((x,y)=>rowSlot(frag,frag.rowIds.indexOf(x))-rowSlot(frag,frag.rowIds.indexOf(y)))
  assert.deepEqual(order(f),['a','b','c'])
  // Dropped on the chunk's last slot, 'a' becomes its last row.
  const moved=reorderFragmentRow(f,'a',6)
  assert.deepEqual(order(moved),['b','c','a'])
  // The slots in use are redealt, never grown, so the chunk keeps its band and
  // cannot gain a hole: aligning it against a neighbour still works.
  assert.deepEqual([...moved.slots].sort((x,y)=>x-y),[4,5,6])
  assert.equal(rowCount(moved),rowCount(f))
  assert.deepEqual([...moved.rowIds].sort(),['a','b','c'])
  // Dropped above everything.
  assert.deepEqual(order(reorderFragmentRow(f,'c',0)),['c','a','b'])
  // A row the chunk does not have, or a chunk with no slots at all.
  assert.equal(reorderFragmentRow(f,'zz',0),f)
  const plain=createFragment(1,0,100,['a','b','c'],{id:'f2'})
  assert.deepEqual(order(reorderFragmentRow(plain,'a',2)),['b','c','a'])
})
