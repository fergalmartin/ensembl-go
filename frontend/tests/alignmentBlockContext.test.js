import test from 'node:test'
import assert from 'node:assert/strict'
import { createDetail, restrictRows, chooseReference, rowGroups, totalLanes, rowLanes, splitRows, comparatorFor, comparators, activePair, setReference, setMode, moveRow, setLanes, pickTranscript, clampContext, detailFragments, detailRestricted, laneRect, CONTEXT_MAX_BP, requestBatches, CONTEXT_MAX_COLUMNS } from '../src/components/alignment-explorer/detail.js'
import { rowCount, rowSlot, layerBounds, constrainCamera, fitCamera, panelRect } from '../src/components/alignment-explorer/layers.js'
import { rowCoverage } from '../src/components/alignment-explorer/tileCoverage.js'
import { planTiles } from '../src/components/alignment-explorer/tilePlan.js'
import { visibleRequests, visibleRequest } from '../src/components/alignment-explorer/regionRequests.js'

const detail = (rows=['a','b','c'],extra={}) =>
  createDetail({fragmentId:'f',sourceBlock:7,length:1000,rowIds:rows,allRowIds:rows,...extra})

test('a block pick does not restrict the rows; a row pick and a highlight do', () => {
  const rows=['a','b','c']
  const block=[{kind:'block',fragmentId:'f',start:0,end:9,rowIds:['a','b','c']}]
  assert.deepEqual(restrictRows(rows,block,[]),rows)
  assert.deepEqual(restrictRows(rows,[{kind:'row',rowIds:['b']}],[]),['b'])
  assert.deepEqual(restrictRows(rows,[],['c','a']),['a','c'])
  assert.deepEqual(restrictRows(rows,[{kind:'region',rowIds:['c']}],[]),['c'])
  // Naming a row this block does not hold is not a narrowing of it.
  assert.deepEqual(restrictRows(rows,[{kind:'row',rowIds:['zz']}],[]),rows)
  // Nor is picking every row.
  assert.deepEqual(restrictRows(rows,[{kind:'row',rowIds:['a','b','c']}],[]),rows)
})

test('the reference falls back to the first row that has coverage, and says so', () => {
  assert.deepEqual(chooseReference(['a','b','c'],['a','b']),{reference:'a',fallback:null})
  assert.deepEqual(chooseReference(['a','b','c'],['b','c']),{reference:'b',fallback:'a'})
  assert.deepEqual(chooseReference(['a','b'],[]),{reference:null,fallback:'none'})
  const d=detail(['a','b','c'],{available:['b','c']})
  assert.equal(d.reference,'b')
  assert.equal(d.referenceFallback,'a')
})

test('row groups are cumulative, and expanding one moves only the rows below it', () => {
  const d=detail()
  assert.deepEqual(rowGroups(d).map(g=>g.slot),[0,2,4])
  assert.equal(totalLanes(rowGroups(d)),6)
  const wide=setLanes(d,'b',3)
  assert.equal(rowLanes(wide,'b'),4)
  assert.deepEqual(rowGroups(wide).map(g=>g.slot),[0,2,6])
  // 'a' is where it was; only what follows 'b' has moved.
  assert.equal(rowGroups(wide)[0].slot,rowGroups(d)[0].slot)
})

test('a detail fragment reports every one of its lanes, tracks included', () => {
  const d=detail()
  const [targets,reference]=detailFragments(d)
  assert.equal(reference.id,'detail:reference')
  assert.equal(reference.pinned,true)
  assert.equal(rowCount(reference),2)
  assert.equal(rowCount(targets),4)
  assert.deepEqual(targets.rowIds,['b','c'])
  assert.deepEqual(targets.rowIds.map((_,i)=>rowSlot(targets,i)),[0,2])
  // The stack begins below the pinned reference's own lanes.
  assert.equal(targets.y,2)
  // Both are the same block over the same columns.
  for(const f of [targets,reference]){assert.equal(f.sourceBlock,7);assert.equal(f.start,0);assert.equal(f.end,1000)}
})

test('a pinned fragment keeps the horizontal transform and drops the vertical one', () => {
  const d=detail()
  const [targets,reference]=detailFragments(d)
  const camera={x:0,y:260,scale:4,plane:1}
  assert.equal(panelRect(reference,camera).y,panelRect(reference,{...camera,y:0}).y)
  assert.notEqual(panelRect(targets,camera).y,panelRect(targets,{...camera,y:0}).y)
  // Same columns land in the same place for both.
  assert.equal(panelRect(reference,camera).x,panelRect(targets,camera).x)
  assert.equal(panelRect(reference,camera).width,panelRect(targets,camera).width)
})

test('reference and adjacent modes ask different questions of the same rows', () => {
  const d=detail()
  assert.equal(comparatorFor(d,'a'),null)
  assert.equal(comparatorFor(d,'b'),'a')
  assert.equal(comparatorFor(d,'c'),'a')
  assert.deepEqual(comparators(d),['a'])
  const adjacent=setMode(d,'adjacent')
  assert.equal(comparatorFor(adjacent,'a'),null)
  assert.equal(comparatorFor(adjacent,'b'),'a')
  assert.equal(comparatorFor(adjacent,'c'),'b')
  assert.deepEqual(comparators(adjacent).sort(),['a','b'])
  // Adjacent mode has nothing to pin: every row is read against the one above.
  assert.equal(splitRows(adjacent).pinned,null)
  assert.deepEqual(splitRows(adjacent).targets,['a','b','c'])
  assert.equal(splitRows(d).pinned,'a')
})

test('adjacent mode compares the neighbours actually displayed, after a move', () => {
  let d=setMode(detail(),'adjacent')
  d=moveRow(d,'c','b')
  assert.deepEqual(d.rows,['a','c','b'])
  assert.equal(comparatorFor(d,'c'),'a')
  assert.equal(comparatorFor(d,'b'),'c')
  // And after a row is taken out of the view.
  const fewer={...d,rows:d.rows.filter(id=>id!=='c')}
  assert.equal(comparatorFor(fewer,'b'),'a')
})

test('changing the reference keeps the order; reordering keeps the reference', () => {
  let d=moveRow(detail(),'c','a')
  assert.deepEqual(d.rows,['c','a','b'])
  assert.equal(d.reference,'a')
  d=setReference(d,'b')
  assert.equal(d.reference,'b')
  assert.deepEqual(d.rows,['c','a','b'],'a change of reference must not rearrange the stack')
  assert.equal(comparatorFor(d,'a'),'b')
  assert.equal(comparatorFor(d,'b'),null)
  // Moving to the end.
  assert.deepEqual(moveRow(d,'c',null).rows,['a','b','c'])
  // A row this view does not hold cannot be moved or made the reference.
  assert.equal(moveRow(d,'zz','a'),d)
  assert.equal(setReference(d,'zz'),d)
})

test('the active pair is resolved against what is displayed, never a stale id', () => {
  const d=detail()
  assert.deepEqual(activePair(d),['a','b'])
  assert.deepEqual(activePair({...d,pair:['a','c']}),['a','c'])
  // A stored pair whose rows have gone, or whose relationship no longer holds.
  assert.deepEqual(activePair({...d,pair:['a','zz']}),['a','b'])
  assert.deepEqual(activePair({...setMode(d,'adjacent'),pair:['a','c']}),['a','b'])
  assert.equal(activePair({...d,rows:['a'],reference:'a'}),null)
})

test('a transcript pick belongs to one row and says nothing about any other', () => {
  let d=pickTranscript(detail(),'a','ENST1')
  assert.deepEqual(d.picks,{a:'ENST1'})
  d=pickTranscript(d,'b','ENST2')
  assert.deepEqual(d.picks,{a:'ENST1',b:'ENST2'})
  assert.deepEqual(pickTranscript(d,'a',null).picks,{b:'ENST2'})
  assert.equal(d.reference,'a')
})

test('genomic context is bounded at both ends', () => {
  assert.equal(clampContext(-5),0)
  assert.equal(clampContext(1e9),CONTEXT_MAX_BP)
  assert.equal(clampContext('2500'),2500)
})

test('restriction is reported only when rows are actually held back', () => {
  assert.equal(detailRestricted(detail()),false)
  assert.equal(detailRestricted(createDetail({fragmentId:'f',sourceBlock:1,length:10,rowIds:['a'],allRowIds:['a','b']})),true)
})

test('a lane rect sits under its own sequence and covers only its own lanes', () => {
  const d=setLanes(detail(),'b',2)
  const [targets]=detailFragments(d)
  const rect={x:100,width:400,y:50,height:rowCount(targets)*26}
  assert.deepEqual(laneRect(targets,rect,0,26),{x:100,width:400,y:50+26,height:26*2})
  assert.deepEqual(laneRect(targets,rect,1,26),{x:100,width:400,y:50+26*4,height:26})
})

test('unpadded layer bounds and camera fitting are unchanged by block context', () => {
  const d=detail()
  const layer={id:'detail',fragments:detailFragments(d)}
  const bounds=layerBounds(layer)
  assert.deepEqual([bounds.left,bounds.right],[0,1000])
  assert.equal(bounds.top,0)
  // Every lane of every group is inside the travel the camera is given.
  assert.equal(bounds.bottom,(2+4)*26)
  const view=fitCamera(layer,900,500)
  assert.ok(view.scale>0)
  assert.equal(constrainCamera(layer,{...view,x:-50,y:-40,plane:1},{width:900,height:500}).x,0)
})

test('a summary built against another reference is never drawn in its place', () => {
  const bins=focus=>({start:0,end:10,bin_size:1,detail:false,focus,rows:[{id:'r',bins:[{A:1}],divergence_bins:[{fraction:.5}]}]})
  const seq={start:0,end:10,detail:true,focus:'a',rows:[{id:'r',sequence:'ACGTACGTAC'}]}
  // No expectation: everything that covers the row is a candidate, as before.
  assert.equal(rowCoverage([bins('a')],'r',0,10,1).spans.length,1)
  // With one, a stale-comparator summary leaves a hole that reads as loading.
  assert.equal(rowCoverage([bins('a')],'r',0,10,1,'b').spans.length,0)
  assert.deepEqual(rowCoverage([bins('a')],'r',0,10,1,'b').holes,[[0,10]])
  assert.equal(rowCoverage([bins('b')],'r',0,10,1,'b').spans.length,1)
  // Sequence is sequence whoever it is read against.
  assert.equal(rowCoverage([seq],'r',0,10,4,'b').spans.length,1)
})

test('requests are grouped by the comparator their bins are relative to', () => {
  const fragment={id:'f',sourceBlock:7,start:0,end:4000,x:0,y:0,rowIds:['a','b','c'],slots:[0,2,4],layoutRows:6}
  const camera={x:0,y:0,scale:0.2,plane:1},size={width:900,height:500}
  // Without a comparator the block's first row is the one every row is read
  // against, exactly as every other sheet asks.
  const plain=visibleRequests(fragment,camera,size)
  assert.equal(plain.length,1)
  assert.equal(plain[0].focus,'a')
  assert.deepEqual(visibleRequest(fragment,camera,size),plain[0])
  // One reference for everyone is still one request.
  const reference=visibleRequests(fragment,camera,size,()=>'a')
  assert.equal(reference.length,1)
  assert.equal(reference[0].focus,'a')
  // Each row against the one above it is one request per comparator.
  const pairs={a:null,b:'a',c:'b'}
  const adjacent=visibleRequests(fragment,camera,size,id=>pairs[id])
  assert.deepEqual(adjacent.map(r=>r.focus).sort(),['a','b'])
  for(const request of adjacent)assert.ok(request.ids.includes(request.focus),'the comparator is always in its own request')
  const planned=planTiles(fragment,camera,size,2,0,id=>pairs[id])
  assert.deepEqual([...new Set(planned.map(t=>t.request.focus))].sort(),['a','b'])
  for(const task of planned)assert.ok(task.request.ids.includes(task.request.focus))
  // And with no comparator function, tile planning is byte-identical.
  assert.deepEqual(planTiles(fragment,camera,size,2),planTiles(fragment,camera,size,2,0,null))
})

// --- what the overlay and its data path decide, without a canvas ------------
import { emptyLaneReason, shownTranscript, contextWindow, contextRows } from '../src/components/alignment-explorer/detail.js'

test('an empty lane always says which kind of nothing it is', () => {
  // Never "no genes here" for any of these: an absent genome is not evidence
  // about biology, and a track that said so would be making a claim.
  assert.match(emptyLaneReason({reason:'unresolved'}),/genome link/i)
  assert.match(emptyLaneReason({reason:'unavailable'}),/not installed/i)
  assert.match(emptyLaneReason({reason:'no-annotation'}),/no annotation/i)
  assert.match(emptyLaneReason({reason:'no-region'}),/region/i)
  assert.match(emptyLaneReason({reason:'no-coverage'}),/no aligned sequence/i)
  assert.match(emptyLaneReason({reason:'failed'}),/could not be read/i)
  // A row that answered, with nothing over these columns, is the only case that
  // may say there are no features - and it says it about the columns, not the genome.
  assert.match(emptyLaneReason({genes:[]}),/over these columns/i)
  // Nothing back yet is not an answer at all.
  assert.match(emptyLaneReason(null,{availability:'ready'}),/loading/i)
})

test('a row shows the transcript that was picked, and only if it is really there', () => {
  const entry={genes:[{gene_id:'G',transcripts:[{transcript_id:'T1'},{transcript_id:'T2'}]}]}
  assert.equal(shownTranscript(entry,'T2').transcript.transcript_id,'T2')
  assert.equal(shownTranscript(entry,'gone'),null)
  assert.equal(shownTranscript(entry,null),null)
  assert.equal(shownTranscript(null,'T1'),null)
})

test('the annotation window is quantised, so panning re-uses what is in hand', () => {
  const fragment={id:'detail:targets',sourceBlock:1,start:0,end:200000,x:0,y:0,rowIds:['a'],slots:[0],layoutRows:2}
  const size={width:900,height:500}
  const first=contextWindow(fragment,{x:0,y:0,scale:.05,plane:1},size)
  const nudged=contextWindow(fragment,{x:40,y:0,scale:.05,plane:1},size)
  assert.deepEqual(first,nudged,'a small pan must not ask a new question')
  assert.equal(first.start,0)
  assert.ok(first.end<=fragment.end)
  // Far along the block it is a different window, still whole quanta.
  const far=contextWindow(fragment,{x:120000,y:0,scale:.05,plane:1},size)
  assert.notDeepEqual(far,first)
  assert.equal(far.start%16384,0)
  // Off screen entirely, there is nothing to ask.
  assert.equal(contextWindow(fragment,{x:-1e7,y:0,scale:.05,plane:1},size),null)
  assert.equal(contextWindow(null,{x:0,y:0,scale:1,plane:1},size),null)
})

test('only the rows on screen are asked about, plus whatever they are read against', () => {
  const d=detail(['a','b','c','d'])
  const layer={fragments:detailFragments(d)}
  const size={width:900,height:500}
  const camera={x:0,y:0,scale:1,plane:1}
  // Everything fits, so everything is asked for, in the reader's order.
  assert.deepEqual(contextRows(d,layer,camera,size),['a','b','c','d'])
  // Scrolled so the upper targets are off screen, they are not asked about -
  // scrolling a long stack must not load every row's transcripts. The pinned
  // reference is still fetched, because it is what the rest are read against.
  const scrolled=contextRows(d,layer,{...camera,y:250},size)
  assert.ok(scrolled.includes('a'),'the pinned reference is never dropped')
  assert.ok(scrolled.includes('d'))
  assert.ok(!scrolled.includes('b'))
  // Adjacent mode pulls in each visible row's own neighbour instead.
  const adjacent=setMode(d,'adjacent')
  const adjacentLayer={fragments:detailFragments(adjacent)}
  assert.ok(contextRows(adjacent,adjacentLayer,camera,size).includes('c'))
  assert.deepEqual(contextRows(null,layer,camera,size),[])
})

test('all visible rows are batched without silently dropping rows past the eighth', () => {
  const many=Array.from({length:30},(_,i)=>`r${i}`)
  const d=detail(many)
  const layer={fragments:detailFragments(d)}
  const rows=contextRows(d,layer,{x:0,y:0,scale:1,plane:1},{width:900,height:4000})
  const batches=requestBatches(rows)
  assert.deepEqual(batches.flat(),many)
  assert.ok(batches.every(batch=>batch.length<=8))
})

// --- the genomic half: real lengths, real coordinates -----------------------
import { trackWindow, pairScale, coordinateToX, xToCoordinate, blockCoverage, rulerStep, exonSegments } from '../src/components/alignment-explorer/genomicContext.js'

test('one scale for the pair, each track centred on its own selection', () => {
  const short={start:1000,end:1100},long={start:50000,end:54000}
  const scale=pairScale([short,long],2000,800)
  // The wider of the two decides the scale; neither is squeezed to match.
  assert.equal(scale,(4000+4000)/800)
  const a=trackWindow(short,2000,800,scale),b=trackWindow(long,2000,800,scale)
  assert.equal(a.end-a.start,b.end-b.start,'both tracks cover the same number of bases')
  assert.equal(a.centre,1050)
  assert.equal(b.centre,52000)
  // And the two selections stay visibly unequal, which is the fact worth seeing.
  assert.equal(a.span,100)
  assert.equal(b.span,4000)
  assert.equal(trackWindow(null,2000,800,scale),null)
})

test('a reverse-aligned row counts its coordinates down, as the alignment reads it', () => {
  const window_={start:1000,end:2000}
  assert.equal(coordinateToX(1000,window_,100,false),0)
  assert.equal(coordinateToX(2000,window_,100,false),100)
  // Reverse: the row reads 5'->3' left to right above, so the high coordinate
  // is on the left here too.
  assert.equal(coordinateToX(1000,window_,100,true),100)
  assert.equal(coordinateToX(2000,window_,100,true),0)
  for(const reverse of [false,true])
    for(const x of [0,25,50,100])
      assert.equal(coordinateToX(xToCoordinate(x,window_,100,reverse),window_,100,reverse),x)
})

test('sequence outside the block is named as outside, not as empty', () => {
  const window_={start:900,end:2100}
  const coverage=blockCoverage(window_,{start:1000,end:2000})
  assert.deepEqual(coverage.inside,{start:1000,end:2000})
  assert.deepEqual(coverage.before,{start:900,end:1000})
  assert.deepEqual(coverage.after,{start:2000,end:2100})
  // A window wholly inside the block has no outside at all.
  const within=blockCoverage({start:1200,end:1400},{start:1000,end:2000})
  assert.deepEqual(within.inside,{start:1200,end:1400})
  assert.equal(within.before,null)
  assert.equal(within.after,null)
  // A row with no placement is all outside; none of it is claimed as aligned.
  assert.equal(blockCoverage(window_,null).inside,null)
})

test('exons split into coding and non-coding the way the browser draws them', () => {
  // GFF3 one-based inclusive CDS against a zero-based half-open exon.
  const segments=exonSegments(100,200,[{start:121,end:180}])
  assert.deepEqual(segments,[
    {start:100,end:120,coding:false},
    {start:120,end:180,coding:true},
    {start:180,end:200,coding:false}])
  // A wholly coding exon is one filled piece; a wholly non-coding one is hollow.
  assert.deepEqual(exonSegments(100,200,[{start:101,end:200}]),[{start:100,end:200,coding:true}])
  assert.deepEqual(exonSegments(100,200,[]),[{start:100,end:200,coding:false}])
  assert.deepEqual(exonSegments(100,200,[{start:401,end:500}]),[{start:100,end:200,coding:false}])
})

test('ruler steps are round numbers at every scale', () => {
  for(const bpPerPx of [0.01,0.5,1,7,120,4000])
    assert.ok([1,2,5].includes(rulerStep(bpPerPx)/10**Math.floor(Math.log10(rulerStep(bpPerPx))))
      ||rulerStep(bpPerPx)/10**Math.floor(Math.log10(rulerStep(bpPerPx)))===1)
  assert.ok(rulerStep(1,90)>=90)
})

// --- comparison bands: the ink is the measurement ---------------------------
import { BAND_KINDS, bandSlices } from '../src/components/alignment-explorer/comparisonBands.js'
import { contextPairs } from '../src/components/alignment-explorer/detail.js'

test('agreement is blank, so what is drawn is what differs', () => {
  assert.deepEqual(bandSlices({match:100},200),[])
  assert.deepEqual(bandSlices({},200),[])
  assert.deepEqual(bandSlices({match:1},0),[])
})

test('each kind takes width in proportion to what was counted', () => {
  const slices=bandSlices({match:50,substitution:25,target_gap:25},100)
  assert.deepEqual(slices.map(s=>s.kind),['substitution','target_gap'])
  assert.equal(slices[0].width,25)
  assert.equal(slices[1].width,25)
  assert.equal(slices[1].x,25)
  // Matches take no ink but are still in the denominator: the band is half empty.
  assert.equal(slices.reduce((n,s)=>n+s.width,0),50)
})

test('one substituted column among a hundred still leaves a mark', () => {
  const slices=bandSlices({match:99,substitution:1},300)
  assert.equal(slices.length,1)
  assert.ok(slices[0].width>=0.75,'a present kind is never rounded away to nothing')
  assert.equal(slices[0].count,1)
})

test('difference is drawn before absence, and both gap kinds are told apart', () => {
  const kinds=BAND_KINDS.map(([kind])=>kind)
  assert.deepEqual(kinds,['substitution','target_gap','reference_gap','unknown','unavailable'])
  // The two gap kinds must never share a colour: which row is missing is the
  // whole point of a directional comparison.
  const colours=BAND_KINDS.map(([,colour])=>colour)
  assert.equal(new Set(colours).size,colours.length)
  assert.ok(!kinds.includes('match'))
})

test('the pairs measured are exactly the comparisons on screen', () => {
  const d=detail(['a','b','c'])
  const layer={fragments:detailFragments(d)}
  const camera={x:0,y:0,scale:1,plane:1},size={width:900,height:500}
  // Reference mode: every target against the one reference, never the
  // reference against itself.
  assert.deepEqual(contextPairs(d,layer,camera,size),[['a','b'],['a','c']])
  const adjacent=setMode(d,'adjacent')
  assert.deepEqual(contextPairs(adjacent,{fragments:detailFragments(adjacent)},camera,size),[['a','b'],['b','c']])
  // A single row has nothing to compare with, and says so by asking for nothing.
  const alone=detail(['a'])
  assert.deepEqual(contextPairs(alone,{fragments:detailFragments(alone)},camera,size),[])
})


import { annotationModels, annotationLaneCounts, transcriptBounds, orderedContextHits } from '../src/components/alignment-explorer/contextModelLayout.js'
import { hitAtPoint } from '../src/components/alignment-explorer/originalLayout.js'
import { pinnedBottom } from '../src/components/alignment-explorer/layers.js'

test('pinned reference tiles remain requested after a long vertical scroll', () => {
  const reference=detailFragments(detail())[1]
  const camera={x:0,y:4000,scale:2,plane:1},size={width:900,height:500}
  assert.ok(visibleRequests(reference,camera,size).some(r=>r.ids.includes('a')))
  assert.ok(planTiles(reference,camera,size,0).some(t=>t.request.ids.includes('a')))
  assert.equal(pinnedBottom({fragments:[reference]},camera),panelRect(reference,camera).y+52)
})

test('annotation padding never rejects a visible window within the API bound', () => {
  const f={...detailFragments(detail())[0],end:1_000_000}
  const size={width:900,height:500}
  for(const scale of [.02,.03,.1,1,8]){
    const window=contextWindow(f,{x:180000,y:0,scale,plane:1},size)
    assert.ok(window.end-window.start<=CONTEXT_MAX_COLUMNS)
  }
  const fine=contextWindow(f,{x:238000,y:0,scale:8,plane:1},size,256)
  assert.ok(fine.end-fine.start<4096,'base zoom must resolve each comparison column, including its padding')
})

test('overlapping transcripts get separate complete lanes and reverse projections use true extents', () => {
  const tx=(id,features)=>({transcript_id:id,features})
  const a=tx('a',[{type:'exon',start:400,end:500},{type:'exon',start:100,end:200},{type:'cds',start:430,end:450}])
  assert.deepEqual(transcriptBounds(a),{start:100,end:500})
  const entry={genes:[{gene_id:'g',transcripts:[a,tx('b',[{start:200,end:600}]),tx('c',[{start:650,end:700}])]}]}
  const models=annotationModels(entry)
  assert.equal(models.count,2)
  assert.notEqual(models.items.find(m=>m.id==='a').lane,models.items.find(m=>m.id==='b').lane)
  assert.equal(models.items.find(m=>m.id==='c').lane,0)
  assert.ok(annotationLaneCounts({r:entry}).r*26>=8+2*30,'labels fit within their row group')
})

test('a clickable exon wins over the transcript envelope containing it', () => {
  const box={x:200,y:100,width:40,height:12}
  const hits=orderedContextHits([{kind:'feature',...box},{kind:'transcript',...box}])
  assert.equal(hitAtPoint(hits,{x:220,y:106}).kind,'feature')
})

test('comparison ink stays inside its bin and does not fill double-gap columns', () => {
  const slices=bandSlices({start:0,end:100,target_gap:1},100)
  assert.equal(slices[0].width,1)
  const small=bandSlices({start:0,end:6,substitution:1,target_gap:1,reference_gap:1,unknown:1,unavailable:1,match:1},.5)
  assert.ok(small.reduce((sum,s)=>sum+s.width,0)<=.5)
})

test('genomic context near the chromosome start requests no negative coordinates', () => {
  const window=trackWindow({start:10,end:20},2000,800,5)
  assert.equal(window.start,0)
  assert.equal(window.end-window.start,4000)
})
