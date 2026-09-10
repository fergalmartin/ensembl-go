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
