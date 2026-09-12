import test from 'node:test'
import assert from 'node:assert/strict'

const load = () => import('../src/components/alignment-explorer/layers.js')
// The Original's gutter: one column of names, MARGIN_X wide, a row apiece.
const gutter = ids => ids.map((rowId, i) => ({ kind: 'label', rowId, x: 0, y: 56 + i * 26, width: 156, height: 26 }))
const panel = { x: 156, y: 56, width: 900, height: 5 * 26 }

test('a rectangle over the names picks the names it covers',async()=>{
  const {namesInRect}=await load()
  const labels=gutter(['a','b','c','d','e'])
  assert.deepEqual(namesInRect(labels,{x1:10,x2:120,y1:60,y2:110}),['a','b','c'])
  assert.deepEqual(namesInRect(labels,{x1:10,x2:120,y1:140,y2:170}),['d','e'])
  assert.deepEqual(namesInRect(labels,{x1:10,x2:120,y1:400,y2:420}),[],'below every name is no name')
})

test('a press that never travelled still means the name under it',async()=>{
  const {namesInRect}=await load()
  // In Select mode a click on a name has to go on picking that name, and a
  // click is a rectangle of no width at all.
  const labels=gutter(['a','b','c'])
  assert.deepEqual(namesInRect(labels,{x1:40,x2:40,y1:90,y2:90}),['b'])
  assert.deepEqual(namesInRect(labels,{x1:0,x2:0,y1:56,y2:56}),['a'],'the very corner of the first name')
})

test('Columns mode over the names takes all of them, as it does over sequence',async()=>{
  const {namesInRect}=await load()
  const labels=gutter(['a','b','c','d'])
  // The names are one column; touching it is touching the column.
  assert.deepEqual(namesInRect(labels,{x1:40,x2:60,y1:90,y2:92},true),['a','b','c','d'])
  assert.deepEqual(namesInRect(labels,{x1:40,x2:60,y1:90,y2:92},false),['b'],'and Select alone does not')
})

test('a drag that carries on into the sequence is a region, not a name pick',async()=>{
  const {rectEntersCells}=await load()
  assert.equal(rectEntersCells([panel],{x1:10,x2:120,y1:60,y2:110},156),false,'stayed among the names')
  assert.equal(rectEntersCells([panel],{x1:10,x2:400,y1:60,y2:110},156),true,'ran on into the alignment')
  assert.equal(rectEntersCells([panel],{x1:300,x2:400,y1:60,y2:110},156),true,'started in the alignment')
})

test('a block scrolled under the name gutter is not something the reader can mean',async()=>{
  const {rectEntersCells}=await load()
  // The Original paints an opaque gutter over the blocks behind it. Without the
  // left bound, dragging over the names would count as reaching the sequence
  // hidden underneath and would never pick a name at all.
  const scrolled={x:-400,y:56,width:900,height:130}
  assert.equal(rectEntersCells([scrolled],{x1:10,x2:120,y1:60,y2:110},156),false)
  assert.equal(rectEntersCells([scrolled],{x1:10,x2:200,y1:60,y2:110},156),true,'past the gutter it counts again')
  // A working layer has no gutter, so nothing is hidden and the bound is zero.
  assert.equal(rectEntersCells([scrolled],{x1:10,x2:120,y1:60,y2:110},0),true)
})

test('picking names produces the same picks as clicking each name',async()=>{
  const {createLayer,createFragment,rowPicks,namesInRect}=await load()
  const layer=createLayer('Work',0,[
    createFragment(1,0,10,['a','b']),
    createFragment(1,20,30,['a','b']),
  ])
  const names=namesInRect(gutter(['a','b','c']),{x1:10,x2:120,y1:60,y2:90})
  assert.deepEqual(names,['a','b'])
  const picks=names.flatMap(id=>rowPicks(layer,id))
  // One pick per chunk the sequence runs through, which is what a name click gives.
  assert.equal(picks.length,4)
  for(const pick of picks)assert.equal(pick.kind,'row')
  assert.deepEqual([...new Set(picks.flatMap(p=>p.rowIds))].sort(),['a','b'])
  assert.deepEqual(picks.filter(p=>p.rowIds[0]==='a'),rowPicks(layer,'a'))
})

test('names that are not drawn cannot be picked',async()=>{
  const {namesInRect}=await load()
  // The painter only lays down a label for a row that is on screen, so a
  // Columns-mode sweep takes every visible name and makes no claim on the rest.
  const visible=gutter(['c','d','e'])
  assert.deepEqual(namesInRect(visible,{x1:40,x2:60,y1:90,y2:92},true),['c','d','e'])
})

test('nothing behind the name gutter can be pressed, however far it reaches',async()=>{
  const {hitAtPoint}=await import('../src/components/alignment-explorer/originalLayout.js')
  const MARGIN_X=156
  // A block scrolled left of the gutter: its header region still spans the
  // whole width of the block, including the part the gutter is painted over.
  const header={kind:'header',fragmentId:'f1',x:-400,y:18,width:1400,height:48}
  const name={kind:'label',rowId:'a',x:0,y:66,width:MARGIN_X,height:26}
  const marker={kind:'blockjump',rowId:'b',x:20,y:70,width:60,height:18}
  const hits=[header,name,marker]
  const original={original:true,marginX:MARGIN_X}
  // The reported bug: a press above the names, over the gutter, found that
  // header and was taken as a click on it, so no rectangle was ever drawn.
  assert.equal(hitAtPoint(hits,{x:40,y:40},original),null)
  // Anything else buried under the gutter is just as unreachable.
  assert.equal(hitAtPoint(hits,{x:40,y:75},original),name,'the gutter is the names, and only the names')
  // Right of the gutter edge the header is drawn and answers as it always did.
  assert.equal(hitAtPoint(hits,{x:MARGIN_X,y:40},original),header)
  assert.equal(hitAtPoint(hits,{x:600,y:40},original),header)
  // A layer paints no gutter, so nothing there is hidden and nothing is dropped.
  assert.equal(hitAtPoint(hits,{x:40,y:40},{original:false}),header)
  // Last published wins, so a control drawn over a region is the one pressed.
  const cross={kind:'deselect',x:600,y:36,width:22,height:22}
  assert.equal(hitAtPoint([...hits,cross],{x:610,y:44},original),cross)
  assert.equal(hitAtPoint([...hits,cross],{x:610,y:44},{...original,filter:h=>h.kind==='header'}),header)
  assert.equal(hitAtPoint([],{x:10,y:10},original),null)
  assert.equal(hitAtPoint(undefined,{x:10,y:10},original),null)
})

test('a selection mode leaves every press to the rectangle',async()=>{
  const {isSelectMode}=await import('../src/components/alignment-explorer/selectKinds.js')
  // The predicate the canvas gates on. Pan takes hold of rows, headers,
  // connectors and jump markers; the selection modes take hold of nothing, so
  // a press anywhere starts the rectangle instead of carrying something off.
  assert.equal(!isSelectMode('pan'),true)
  assert.equal(!isSelectMode('rectangle'),false)
  assert.equal(!isSelectMode('columns'),false)
})

test('a name off the sheet is lit, since which block is open is not part of what was said',async()=>{
  const {toggleHighlights,rowPicks}=await import('../src/components/alignment-explorer/layers.js')
  const layer={fragments:[{id:'f1',start:0,end:100,rowIds:['a','b']}]}
  // Rows the open blocks hold have cells to pick; the rest have none at all,
  // which is why a rectangle over their names used to select nothing.
  assert.equal(rowPicks(layer,'a').length,1)
  assert.equal(rowPicks(layer,'zz').length,0)
  // So those names go to the lit set instead, and toggle there the way picks do.
  assert.deepEqual(toggleHighlights([],['zz','yy']),['zz','yy'])
  assert.deepEqual(toggleHighlights(['zz'],['zz','yy']),['zz','yy'],'a partial pass completes it')
  assert.deepEqual(toggleHighlights(['zz','yy'],['zz','yy']),[],'the same pass again puts them out')
  assert.deepEqual(toggleHighlights(['other'],['zz']),['other','zz'],'nothing else is disturbed')
  assert.deepEqual(toggleHighlights(['a'],[]),['a'],'no names is no change')
  assert.deepEqual(toggleHighlights(undefined,['a']),['a'])
})
