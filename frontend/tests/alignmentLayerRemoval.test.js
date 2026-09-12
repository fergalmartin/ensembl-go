import test from 'node:test'
import assert from 'node:assert/strict'

const load = () => import('../src/components/alignment-explorer/layers.js')
// Three chunks of one source block, left to right, sharing two sequences.
const build = async () => {
  const { createLayer, createFragment } = await load()
  return createLayer('Work', 0, [
    createFragment(1, 0, 10, ['a', 'b'], { slots: [0, 1] }),
    createFragment(1, 20, 30, ['a', 'b'], { slots: [0, 1] }),
    createFragment(1, 40, 50, ['a', 'b'], { slots: [0, 1] }),
  ])
}
const links = (connections, rowId) =>
  connections.filter(c => c.rowId === rowId).map(c => [c.from.start, c.to.start])

test('removing a middle chunk re-links its neighbours rather than leaving a loose end',async()=>{
  const {removeFragment,layerConnections}=await load()
  const layer=await build()
  assert.deepEqual(links(layerConnections(layer),'a'),[[0,20],[20,40]])
  const next=removeFragment(layer,layer.fragments[1].id)
  assert.equal(next.fragments.length,2)
  // The path is still one path: what was A-B-C is now A-C, not A-B with B gone.
  assert.deepEqual(links(layerConnections(next),'a'),[[0,40]])
  assert.deepEqual(links(layerConnections(next),'b'),[[0,40]])
})

test('removing an end chunk drops the connection it carried and keeps the rest',async()=>{
  const {removeFragment,layerConnections}=await load()
  const layer=await build()
  const next=removeFragment(layer,layer.fragments[2].id)
  assert.deepEqual(links(layerConnections(next),'a'),[[0,20]])
})

test('removing a sequence takes every connection along that sequence with it',async()=>{
  const {removeRowFromLayer,layerConnections}=await load()
  const layer=await build()
  const next=removeRowFromLayer(layer,'a')
  assert.deepEqual(layerConnections(next).filter(c=>c.rowId==='a'),[])
  assert.deepEqual(links(layerConnections(next),'b'),[[0,20],[20,40]],'the other sequence is untouched')
  for(const f of next.fragments)assert.ok(!f.rowIds.includes('a'))
})

test('a removal returns a new layer, so anything derived from it is rebuilt',async()=>{
  const {removeFragment,removeRowFromLayer}=await load()
  const layer=await build()
  // useLayerData memoises connections on the layer's identity; sharing it would
  // leave the old connections on screen after the chunk had gone.
  assert.notEqual(removeFragment(layer,layer.fragments[0].id),layer)
  assert.notEqual(removeRowFromLayer(layer,'a'),layer)
  // And an untouched layer keeps its identity, so nothing recomputes for nothing.
  assert.equal(removeFragment(layer,'no-such-chunk'),layer)
  assert.equal(removeRowFromLayer(layer,'no-such-row'),layer)
})

test('a chunk left holding no sequences goes, rather than staying as an empty panel',async()=>{
  const {createLayer,createFragment,removeRowFromLayer}=await load()
  const layer=createLayer('Work',0,[
    createFragment(1,0,10,['a','b']),
    createFragment(1,20,30,['a']),
  ])
  const next=removeRowFromLayer(layer,'a')
  assert.equal(next.fragments.length,1)
  assert.deepEqual(next.fragments[0].rowIds,['b'])
})

test('removing a sequence closes its lane instead of leaving the layer taller',async()=>{
  const {createLayer,createFragment,removeRowFromLayer,rowCount}=await load()
  const layer=createLayer('Work',0,[
    createFragment(1,0,10,['a','b','c'],{slots:[0,1,2]}),
    createFragment(1,20,30,['a','c'],{slots:[0,2]}),
  ])
  assert.equal(rowCount(layer.fragments[0]),3)
  const next=removeRowFromLayer(layer,'b')
  assert.deepEqual(next.fragments[0].slots,[0,1])
  // c kept a slot shared with the other chunk: rows still line up across them.
  assert.deepEqual(next.fragments[1].slots,[0,1])
  assert.equal(rowCount(next.fragments[0]),2,'the layer is shorter, not holed')
})

test('per-row coverage and membership lose the sequence too',async()=>{
  const {createLayer,createFragment,removeRowFromLayer,cellRanges}=await load()
  const layer=createLayer('Work',0,[createFragment(1,0,10,['a','b'],
    {slots:[0,1],coverage:{a:[[0,4]],b:[[2,10]]},availableRows:['a','b']})])
  const next=removeRowFromLayer(layer,'a')
  const fragment=next.fragments[0]
  assert.deepEqual(Object.keys(fragment.coverage),['b'])
  assert.deepEqual(fragment.availableRows,['b'])
  assert.deepEqual(cellRanges(fragment,'b'),[[2,10]])
})

test('taking out the last chunk or the last sequence leaves an empty layer, not a broken one',async()=>{
  const {createLayer,createFragment,removeFragment,removeRowFromLayer,layerConnections}=await load()
  const one=createLayer('Work',0,[createFragment(1,0,10,['a'])])
  assert.deepEqual(removeFragment(one,one.fragments[0].id).fragments,[])
  assert.deepEqual(removeRowFromLayer(one,'a').fragments,[])
  assert.deepEqual(layerConnections(removeRowFromLayer(one,'a')),[])
})

test('a pick is found by reference, so a control drawn on it survives a repaint',async()=>{
  const {createFragment,pickAt,selectedCellAt}=await load()
  const fragment=createFragment(1,0,10,['a','b','c'],{slots:[0,1,2]})
  const layer={fragments:[fragment]}
  const region={fragmentId:fragment.id,start:2,end:6,rowIds:['b','c']}
  const other={fragmentId:fragment.id,start:7,end:9,rowIds:['a']}
  const picks=[region,other]
  assert.equal(pickAt(layer,picks,{x:3,y:1.5}),region,'the pick itself, not a copy of it')
  assert.equal(pickAt(layer,picks,{x:8,y:0.5}),other,'the one under the pointer, not merely the first')
  assert.equal(pickAt(layer,picks,{x:3,y:0.5}),null,'a row the region does not cover')
  assert.equal(pickAt(layer,picks,{x:9.5,y:1.5}),null,'a column no region covers')
  assert.equal(selectedCellAt(layer,picks,{x:3,y:1.5}),true,'the boolean wrapper still answers the cursor')
  assert.equal(selectedCellAt(layer,picks,{x:3,y:0.5}),false)
})

test('a pick knows which rows it covers, so its corner is its own and not the block’s',async()=>{
  const {createFragment,pickSlots}=await load()
  const fragment=createFragment(1,0,10,['a','b','c'],{slots:[0,1,2]})
  assert.deepEqual(pickSlots(fragment,{rowIds:['b','c']}),{top:1,bottom:2})
  assert.deepEqual(pickSlots(fragment,{rowIds:['a']}),{top:0,bottom:0})
  assert.equal(pickSlots(fragment,{rowIds:['gone']}),null,'a pick naming no row here has no corner here')
})

test('the drop control belongs to regions however they were drawn',async()=>{
  const {createLayer,createFragment,blockPick,rowPicks,selectionRect}=await load()
  const fragment=createFragment(1,0,10,['a','b'],{slots:[0,1]})
  const layer=createLayer('Work',0,[fragment])
  // The painter decides by exclusion, so this is the list of what it excludes.
  const isRegion=pick=>pick.kind!=='row'&&pick.kind!=='block'
  assert.equal(isRegion(blockPick(fragment)),false,'a block is dropped by clicking its header again')
  assert.equal(isRegion(rowPicks(layer,'a')[0]),false,'a name is dropped by clicking it again')
  // Two ways of drawing a region reach state in two different shapes. A drag is
  // stamped 'region' by LayerCanvas; Select by coordinates stamps nothing. A
  // rule naming the kinds it wanted matched one and silently missed the other.
  const dragged=selectionRect(layer,{x1:0,x2:5,y1:0,y2:2},false,{x:0,y:0,scale:1,plane:1})
    .map(r=>({...r,kind:'region'}))
  const byCoordinates={fragmentId:fragment.id,start:0,end:5,rowIds:['a','b']}
  assert.ok(dragged.length)
  for(const pick of dragged)assert.equal(isRegion(pick),true,'a dragged region carries the control')
  assert.equal(isRegion(byCoordinates),true,'and so does one entered by coordinates')
})
