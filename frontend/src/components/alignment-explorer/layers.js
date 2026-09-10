import { MARGIN_X, MARGIN_Y, ROW_HEIGHT } from './layout.js'
import { BUILTIN_GENOME_COLOR_PALETTE } from '../../genomeColorSchemes.js'
/** Alignment fragments reference immutable source columns. Layout never changes biology. */
/** Layers take the genome palette, so a colour means the same thing wherever it
 * is seen in the app and the picker offers exactly what is already on screen
 * elsewhere. New layers cycle it; editing a layer opens the same picker the
 * genome selector uses. */
export const PALETTE = BUILTIN_GENOME_COLOR_PALETTE
export const clamp = (v, min, max) => Math.max(min, Math.min(max, v))
export const newId = () => crypto.randomUUID()
export const defaultCamera = () => ({ x: 0, y: 0, scale: 2 })
export const emptyWorkspace = () => ({ version: 2, filter: null, rowOrder: null, layers: [], active: '', original: true, sourceBlock: 1, mode: 'pan', tilted: false, annotations: false, connectionUnit: 'columns', highlighted: '', selection: [], camera: defaultCamera() })
export function createFragment(sourceBlock, start, end, rowIds, options = {}) {
  return { id: newId(), sourceBlock, start, end, rowIds: [...new Set(rowIds)], x: 0, y: 0, slots: null, ...options }
}
export function createLayer(name, index = 0, fragments = []) {
  return { id: newId(), name, color: PALETTE[index % PALETTE.length], fragments, camera: defaultCamera() }
}
export const rowSlot = (fragment, index) => fragment.slots?.[index] ?? index
export const rowCount = fragment => fragment.layoutRows??(fragment.rowIds.length ? Math.max(...fragment.rowIds.map((_,i)=>rowSlot(fragment,i))) + 1 : 0)
export const sourceOrder = (a,b) => a.sourceBlock-b.sourceBlock || a.start-b.start || a.end-b.end || a.id.localeCompare(b.id)
export const overlap = (a,b) => a.sourceBlock===b.sourceBlock && a.start<b.end && b.start<a.end
export const cellRanges = (fragment,id) => fragment.coverage?.[id] || [[fragment.start,fragment.end]]
export const hasCell = (fragment,id,column) => fragment.rowIds.includes(id) && cellRanges(fragment,id).some(([a,b])=>column>=a&&column<b)
export function intersectRanges(ranges,start,end) {
  return ranges.map(([a,b])=>[Math.max(a,start),Math.min(b,end)]).filter(([a,b])=>b>a)
}
export function unionRanges(ranges) {
  const result=[]
  for(const [a,b] of [...ranges].sort((x,y)=>x[0]-y[0]||x[1]-y[1])) {
    if(b<=a)continue
    const last=result.at(-1)
    if(last&&a<=last[1])last[1]=Math.max(last[1],b)
    else result.push([a,b])
  }
  return result
}
function fragmentPart(f,start,end,ids,normalize=false) {
  const kept=ids.filter(id=>intersectRanges(cellRanges(f,id),start,end).length)
  if(end<=start||!kept.length)return null
  return createFragment(f.sourceBlock,start,end,kept,{
    x:f.x+start-f.start,y:f.y,
    slots:normalize?null:kept.map(id=>rowSlot(f,f.rowIds.indexOf(id))),
    coverage:Object.fromEntries(kept.map(id=>[id,intersectRanges(cellRanges(f,id),start,end)])),
  })
}
/** Cut rectangle; union of output cells exactly equals input cells, with no duplicates. */
export function cutFragment(fragment, selection) {
  const start=Math.max(fragment.start,selection.start),end=Math.min(fragment.end,selection.end)
  const selected=fragment.rowIds.filter(id=>selection.rowIds.includes(id))
  if(end<=start||!selected.length)return { remaining:[fragment], extracted:null }
  const remaining=[
    fragmentPart(fragment,fragment.start,fragment.end,fragment.rowIds.filter(id=>!selected.includes(id))),
    fragmentPart(fragment,fragment.start,start,selected),
    fragmentPart(fragment,end,fragment.end,selected),
  ].filter(Boolean)
  return {remaining,extracted:fragmentPart(fragment,start,end,selected,true)}
}
export function moveSelection(workspace,targetId,{copy=false,targetLayer=null,viewportWidth=1000}={}) {
  const source=workspace.layers.find(l=>l.id===workspace.active)
  if(!source||!workspace.selection.length)return workspace
  let fragments=source.fragments, extracted=[]
  // Several picks can land on one fragment now, so each is cut from what the
  // previous ones left rather than from the original. Cutting each from the
  // original would hand back overlapping chunks and lose cells from the source.
  const grouped=new Map()
  for(const pick of resolvePicks(workspace.selection)){
    if(!grouped.has(pick.fragmentId))grouped.set(pick.fragmentId,[])
    grouped.get(pick.fragmentId).push(pick)
  }
  for(const [fragmentId,picks] of grouped){
    const fragment=fragments.find(f=>f.id===fragmentId)
    if(!fragment)continue
    let remaining=[fragment]
    for(const pick of picks){
      const next=[],taken=[]
      for(const part of remaining){
        const cut=cutFragment(part,pick)
        if(cut.extracted)taken.push(cut.extracted)
        next.push(...cut.remaining)
      }
      // One pick is one chunk wherever its pieces sit side by side again.
      if(taken.length)extracted.push(...combineOverlaps(taken))
      remaining=next
    }
    if(!copy)fragments=fragments.flatMap(f=>f.id===fragmentId?remaining:[f])
  }
  if(!extracted.length)return workspace
  let layers=workspace.layers.map(l=>l.id===source.id?{...l,fragments}:l)
  if(targetLayer)layers=[...layers,targetLayer]
  const target=layers.find(l=>l.id===targetId)
  if(!target)return workspace
  const placed=insertChunks(target.fragments,extracted,chunkGap([...target.fragments,...extracted],viewportWidth))
  layers=layers.map(l=>l.id===targetId?{...l,fragments:placed}:l)
  return {...workspace,layers,active:targetId,original:false,selection:[],highlighted:'',camera:{...target.camera}}
}
/** Coalesce overlap in the same source block, retaining row-specific masks.
 * A row not selected at a column stays blank after merging; never reveal discarded cells. */
export function combineOverlaps(fragments, rowOrder=[]) {
  const groups=[]
  for(const f of [...fragments].sort(sourceOrder)) {
    const last=groups.at(-1)
    if(last&&last.sourceBlock===f.sourceBlock&&f.start<last.end){last.items.push(f);last.end=Math.max(last.end,f.end)}
    else groups.push({sourceBlock:f.sourceBlock,start:f.start,end:f.end,items:[f]})
  }
  return groups.map(g=>{
    if(g.items.length===1)return g.items[0]
    const ids=[...new Set(g.items.flatMap(f=>f.rowIds))].sort((a,b)=>rowOrder.indexOf(a)-rowOrder.indexOf(b))
    const coverage=Object.fromEntries(ids.map(id=>[id,unionRanges(g.items.filter(f=>f.rowIds.includes(id)).flatMap(f=>cellRanges(f,id)))]))
    return createFragment(g.sourceBlock,g.start,g.end,ids,{x:Math.min(...g.items.map(f=>f.x)),y:Math.min(...g.items.map(f=>f.y)),coverage})
  })
}
/** What the reader has picked, in one list.
 *
 * A pick is a rectangle over one fragment: `region` from a drag, `row` from a
 * sequence name, `block` from a block header. Keeping all three in one list is
 * what lets them be combined and dragged into a layer together, rather than a
 * name selection and a rectangle selection being separate ideas that cannot mix.
 */
export const pickId = pick => `${pick.kind}:${pick.fragmentId}:${pick.start}:${pick.end}:${[...pick.rowIds].sort().join(',')}`

export const blockPick = fragment =>
  ({kind:'block',fragmentId:fragment.id,start:fragment.start,end:fragment.end,rowIds:[...fragment.rowIds]})

/** A sequence picked by name covers its whole extent in every loaded fragment
 * holding it, so picking a name reaches the parts of the path off screen too. */
export function rowPicks(layer,rowId) {
  return layer.fragments.filter(f=>!f.aggregate&&f.rowIds.includes(rowId))
    .map(f=>({kind:'row',fragmentId:f.id,start:f.start,end:f.end,rowIds:[rowId]}))
}

/** Add picks, or remove them when every one is already picked, so a second click
 * on the same name or header takes it back out. */
export function togglePicks(selection,picks) {
  if(!picks.length)return selection
  const ids=new Set(picks.map(pickId)),present=new Set(selection.map(pickId))
  if(picks.every(p=>present.has(pickId(p))))return selection.filter(p=>!ids.has(pickId(p)))
  return [...selection.filter(p=>!ids.has(pickId(p))),...picks]
}

/** Drop every pick of a row, whatever it was picked from.
 *
 * togglePicks can only take back the picks it is handed, and the picks for a row
 * are built from the fragments currently loaded. Pan or zoom between the two
 * clicks and that set has changed, so the second click added rather than
 * removed and the row could not be unhighlighted at all. */
export const removeRowPicks = (selection,rowId) =>
  selection.filter(pick=>!(pick.kind==='row'&&pick.rowIds.includes(rowId)))

export const pickedRowIds = selection =>
  new Set(selection.filter(p=>p.kind==='row').flatMap(p=>p.rowIds))

/** Reduce picks to the chunks to extract.
 *
 * A picked block takes the whole block: the rows and regions picked inside it are
 * already part of it, and cutting them out separately would only fragment what
 * the reader asked for whole. Everywhere else rows and regions stay distinct
 * chunks, so sub-regions over different blocks arrive as the pieces they were. */
export function resolvePicks(selection) {
  const whole=new Set(selection.filter(p=>p.kind==='block').map(p=>p.fragmentId))
  const seen=new Set(),result=[]
  for(const pick of selection){
    if(pick.kind!=='block'&&whole.has(pick.fragmentId))continue
    const id=pickId(pick)
    if(seen.has(id))continue
    seen.add(id);result.push(pick)
  }
  return result
}
export function layerOverlap(source,target) {
  return source.fragments.some(a=>target.fragments.some(b=>overlap(a,b)))
}
/** Arrange chunks left to right, stacking any that share source columns.
 *
 * Chunks that overlap cannot sit side by side without their shared columns
 * landing at different places, which is the one thing the horizontal axis has to
 * mean here. Overlapping chunks are instead aligned on their source coordinates
 * and stacked into vertical bands that do not collide, so a column read across a
 * band is the same column in every chunk of it.
 *
 * Chunks that do not overlap keep being packed, so a layer of scattered pieces
 * does not inherit the empty megabases that lay between them in the source. */
export function tidyLayer(layer,rowOrder=[], gap=64) {
  const rows=[...new Set(layer.fragments.flatMap(f=>f.rowIds))].sort((a,b)=>rowOrder.indexOf(a)-rowOrder.indexOf(b))
  const clusters=[]
  for(const f of [...layer.fragments].sort(sourceOrder)){
    const last=clusters.at(-1)
    if(last&&last.sourceBlock===f.sourceBlock&&f.start<last.end){last.items.push(f);last.end=Math.max(last.end,f.end)}
    else clusters.push({sourceBlock:f.sourceBlock,start:f.start,end:f.end,items:[f]})
  }
  let x=0
  const fragments=[]
  for(const cluster of clusters){
    const bands=[]
    for(const f of cluster.items){
      let band=bands.findIndex(items=>items.every(o=>f.start>=o.end||f.end<=o.start))
      if(band<0){bands.push([]);band=bands.length-1}
      bands[band].push(f)
    }
    let y=0
    for(const band of bands){
      let height=0
      for(const f of band){
        const slots=f.rowIds.map(id=>rows.indexOf(id))
        fragments.push({...f,x:x+f.start-cluster.start,y,slots})
        height=Math.max(height,Math.max(...slots,-1)+1)
      }
      y+=height
    }
    x+=cluster.end-cluster.start+gap
  }
  return {...layer,fragments}
}
export function mergeLayers(workspace,sourceId,targetId,combine,rowOrder=[]) {
  const source=workspace.layers.find(l=>l.id===sourceId),target=workspace.layers.find(l=>l.id===targetId)
  if(!source||!target||sourceId===targetId)return workspace
  const fragments=combine?combineOverlaps([...target.fragments,...source.fragments],rowOrder):[...target.fragments,...source.fragments]
  const merged=tidyLayer({...target,fragments},rowOrder)
  return {...workspace,layers:workspace.layers.filter(l=>l.id!==sourceId).map(l=>l.id===targetId?merged:l),active:targetId,original:false,selection:[],camera:defaultCamera()}
}
/** The row order the view is using: a saved arrangement laid over whatever rows
 * the dataset actually has.
 *
 * A saved order can name rows that are gone and miss rows that arrived, since it
 * outlives metadata reloads and filters. Rows it does not mention keep their
 * natural order at the end rather than being dropped, so a reordering can never
 * make a sequence disappear from the alignment. */
export function resolveRowOrder(ids, custom) {
  if(!custom?.length)return ids
  const known=new Set(ids),seen=new Set(),ordered=[]
  for(const id of custom)if(known.has(id)&&!seen.has(id)){ordered.push(id);seen.add(id)}
  for(const id of ids)if(!seen.has(id))ordered.push(id)
  return ordered
}

/** Move one row to a position in the order, closing the gap it left behind. */
export function moveRow(order,id,toIndex) {
  const from=order.indexOf(id)
  if(from<0)return order
  const rest=order.filter(other=>other!==id)
  const at=clamp(Math.round(toIndex),0,rest.length)
  return [...rest.slice(0,at),id,...rest.slice(at)]
}

/** Move a row within one chunk, leaving every other chunk where it is.
 *
 * A chunk carries its own row order, and a name sits beside the chunk it belongs
 * to, so dragging that name moves the row among the rows of that block and
 * nothing else. Chunks further along keep their own arrangement; they are
 * reordered by dragging into them in turn.
 *
 * The slots already in use are kept and only redealt, so the chunk occupies the
 * same band it did and a move can never grow it or leave a hole in it. */
export function reorderFragmentRow(fragment,rowId,targetSlot) {
  if(!fragment?.rowIds?.includes(rowId))return fragment
  const positions=fragment.rowIds.map((_,i)=>i).sort((a,b)=>rowSlot(fragment,a)-rowSlot(fragment,b))
  const slotValues=positions.map(i=>rowSlot(fragment,i))
  const ordered=positions.map(i=>fragment.rowIds[i])
  const toIndex=ordered.filter(id=>id!==rowId).filter((_,i)=>slotValues[i]<targetSlot).length
  const next=moveRow(ordered,rowId,toIndex)
  const slotFor=new Map(next.map((id,i)=>[id,slotValues[i]]))
  return {...fragment,slots:fragment.rowIds.map(id=>slotFor.get(id))}
}

export function layerConnections(layer) {
  const byRow=new Map(), result=[]
  for(const f of layer.fragments)for(const id of f.rowIds){if(!byRow.has(id))byRow.set(id,[]);byRow.get(id).push(f)}
  byRow.forEach((fragments,rowId)=>{
    const sorted=[...fragments].sort(sourceOrder)
    for(let i=1;i<sorted.length;i++) {
      const from=sorted[i-1],to=sorted[i]
      const a=cellRanges(from,rowId).at(-1)?.[1]??from.end,b=cellRanges(to,rowId)[0]?.[0]??to.start
      result.push({id:`${from.id}:${to.id}:${rowId}`,rowId,from,to,columns:from.sourceBlock===to.sourceBlock?b-a:null,fromEnd:a,toStart:b})
    }
  })
  return result
}
/** Ends of the path that continue outside the blocks the view has loaded.
 *
 * layerConnections can only join fragments it has, so a sequence carrying on
 * beyond the loaded window looks like it stops at the window edge. `neighbours`
 * names the nearest block holding each sequence off each end; this turns those
 * into stubs anchored to the outermost loaded fragment holding the row, which
 * the painter runs off the side of the viewport.
 *
 * A stub is deliberately not a connection: the distance across it is unknown, so
 * it carries the block to jump to rather than a column count. */
export function offWindowLinks(layer,neighbours) {
  if(!neighbours)return []
  const {before={},after={}}=neighbours
  const outermost=new Map()
  for(const f of layer.fragments){
    if(f.aggregate)continue
    for(const id of f.rowIds){
      const seen=outermost.get(id)
      if(!seen)outermost.set(id,{first:f,last:f})
      else{
        if(sourceOrder(f,seen.first)<0)seen.first=f
        if(sourceOrder(f,seen.last)>0)seen.last=f
      }
    }
  }
  const result=[]
  outermost.forEach(({first,last},rowId)=>{
    if(before[rowId]!=null)result.push({id:`before:${first.id}:${rowId}`,rowId,fragment:first,block:before[rowId],direction:-1})
    if(after[rowId]!=null)result.push({id:`after:${last.id}:${rowId}`,rowId,fragment:last,block:after[rowId],direction:1})
  })
  return result
}
export function firstBlocks(layer) {
  const result=new Map()
  for(const f of [...layer.fragments].sort((a,b)=>a.x-b.x||a.y-b.y))for(const id of f.rowIds)if(!result.has(id))result.set(id,f.id)
  return result
}
/** Fragments that a source column number can address. Aggregate descriptors
 * stand for a run of source blocks, so their start/end are display units
 * spanning those blocks and the layout gaps between them — a column inside one
 * names no real alignment position. Drag selection already skips them below;
 * coordinate entry must use this. */
export function coordinateFragments(layer) {
  return (layer?.fragments||[]).filter(f=>!f.aggregate)
}
/** Separation drawn between adjacent source blocks, in screen pixels.
 *
 * Blocks are evenly spaced in the stored layout, but that spacing is measured in
 * alignment columns and block lengths span three orders of magnitude, so no
 * column count reads well beside both a 955-column and a 1,000,000-column block.
 * The separation the reader sees is therefore drawn here instead: each block's
 * body is compressed into its own rect minus this gap, leaving a constant pixel
 * channel before the next block at every zoom.
 *
 * The block's LEFT edge stays on its exact affine position, so camera.x keeps its
 * meaning and zoom anchoring, camera bounds and layout-region requests are all
 * unaffected. Only positions within a block shift, by at most this gap. */
/** Level of detail for the Original layout, chosen from the visible span.
 *
 * Individual blocks keep their headers, rulers and connecting chevrons up to
 * BLOCK_DETAIL_SPAN columns, and past it for as long as no more than
 * BLOCK_DETAIL_COUNT of them are in view (the server applies that second half,
 * since only it knows how many blocks a span holds). Merging earlier than that
 * produces merged blocks holding one or two blocks, which says less than the
 * blocks themselves and costs their headers, rulers and connections.
 *
 * The merge width tracks the span so roughly a dozen merged blocks are on screen
 * at any zoom, and is rounded to a power of two so the grid nests as you zoom:
 * merged blocks split in half rather than resegmenting into unrelated groups,
 * and every level stays cacheable. On a 43M-column file the widest level lands
 * near 4M columns per merged block. Returns 0 when individual blocks are wanted.
 */
export const BLOCK_DETAIL_SPAN=500_000
export const BLOCK_DETAIL_COUNT=40
export const MERGED_BLOCKS_ON_SCREEN=12
export function mergeWidth(span) {
  if(!(span>BLOCK_DETAIL_SPAN))return 0
  return 2**Math.ceil(Math.log2(Math.max(1,span/MERGED_BLOCKS_ON_SCREEN)))
}
/** The individual source block at a display position inside a merged block.
 *
 * A merged descriptor carries the edges of the blocks it covers, so pointing at
 * one is exact rather than an even division of the merge — which would be wrong
 * by orders of magnitude when block lengths vary as much as they do. Returns
 * null when the merge was too fine-grained to carry its edges. */
export function blockAtLayoutX(fragment,layoutX) {
  const edges=fragment?.aggregate?.edges
  if(!edges?.length)return null
  return edges.find(e=>layoutX>=e.x&&layoutX<e.end_x)||null
}
/** Whether a wheel event belongs to the row list rather than the track.
 *
 * The name gutter and the alignment share one vertical space, so scrolling the
 * list has to carry the tracks with it; a wheel there driving the horizontal
 * controls instead leaves the reader unable to move down a long row list at all.
 * Only a vertically dominant wheel counts, so a sideways trackpad swipe over the
 * gutter still pans the alignment as it does everywhere else. */
export function wheelScrollsRowList(pointX,descriptor,marginX) {
  if(!(pointX<marginX))return false
  const dy=descriptor?.dy||0,dx=descriptor?.dx||0
  return dy!==0&&Math.abs(dy)>Math.abs(dx)
}
export const BLOCK_EDGE_GAP=52
/** Never eat a narrow block to feed the channel beside it. */
export const blockGap=(f,camera)=>Math.min(BLOCK_EDGE_GAP,(f.end-f.start)*camera.scale*0.25)
/** Pixels per alignment column inside a block, slightly under camera.scale. */
export function columnScale(f,camera) {
  const span=Math.max(1,f.end-f.start)
  return Math.max(Number.EPSILON,(span*camera.scale-blockGap(f,camera))/span)
}
/** Inverse of the painter's column placement: an undistorted layer-space x back
 * to the source column actually drawn there. Without a camera this is the plain
 * linear mapping, which is what layer geometry tests describe. */
/** Where a path leaves one block and where it arrives in another, for links
 * that skip blocks in between.
 *
 * Drawing such a link as a line means routing it around every block it is not a
 * member of, which is a lot of ink for a relationship that is really just "this
 * continues over there". Each end becomes a marker on its own block edge instead:
 * a chevron out of the block it leaves, a chevron into the block it enters, each
 * labelled with the block at the other end and each a jump target.
 *
 * `edge` is the side of the fragment the marker sits on (1 right, -1 left) and
 * `flow` the direction the path travels, so both ends of one link point the same
 * way. A link whose far end is outside the loaded window contributes only the
 * end that exists. */
export function blockJumpMarkers(connections,offWindow,rects,everyBlockExists=false) {
  const markers=[]
  for(const c of connections){
    if(!pathIsOccluded(c,rects,everyBlockExists))continue
    const flow=c.to.sourceBlock>c.from.sourceBlock?1:-1
    markers.push({id:`${c.id}:out`,fragmentId:c.from.id,rowId:c.rowId,edge:flow,flow,block:c.to.sourceBlock})
    markers.push({id:`${c.id}:in`,fragmentId:c.to.id,rowId:c.rowId,edge:-flow,flow,block:c.from.sourceBlock})
  }
  for(const link of offWindow)
    markers.push({id:link.id,fragmentId:link.fragment.id,rowId:link.rowId,edge:link.direction,flow:link.direction,block:link.block})
  return markers
}
/** A string is buried whenever a block it does not belong to stands between its
 * endpoints. Comparing block numbers is not enough: only panels actually drawn
 * can occlude it, and the endpoints may be ordered either way on screen. */
export function pathIsOccluded(connection,rects,everyBlockExists=false) {
  const from=connection.from.sourceBlock,to=connection.to.sourceBlock
  const low=Math.min(from,to),high=Math.max(from,to)
  // Original holds every block of the file, so a link that skips one is buried
  // whether or not that block has loaded yet. Deciding from what is drawn made
  // the answer change as tiles arrived, and a link flicked between a curve and
  // a pair of markers while zooming. A layer holds only the chunks someone
  // chose, so there the blocks actually present are the whole truth.
  if(everyBlockExists)return high-low>1
  return rects.some(r=>r.sourceBlock>low&&r.sourceBlock<high)
}
export function panelGeometry(f,camera,marginX) {
  const scale=columnScale(f,camera)
  return {x:marginX+(f.x-camera.x)*camera.scale,width:(f.end-f.start)*scale,scale}
}
export function layerXToColumn(f,camera,x) {
  if(!camera)return x-f.x+f.start
  return f.start+(x-f.x)*camera.scale/columnScale(f,camera)
}
export function selectionRect(layer,rect,columnsOnly=false,camera=null) {
  const selected=[]
  for(const f of layer.fragments){
    if(f.aggregate)continue
    const start=Math.max(f.start,Math.floor(layerXToColumn(f,camera,rect.x1))),end=Math.min(f.end,Math.ceil(layerXToColumn(f,camera,rect.x2)))
    if(end<=start)continue
    const ids=f.rowIds.filter((id,i)=>{
      const y=f.y+rowSlot(f,i)
      return (columnsOnly||y+1>rect.y1&&y<rect.y2)&&intersectRanges(cellRanges(f,id),start,end).length
    })
    if(ids.length)selected.push({fragmentId:f.id,start,end,rowIds:ids})
  }
  return selected
}
export function layerBounds(layer) {
  if(!layer?.fragments.length)return null
  return {
    left:Math.min(...layer.fragments.map(f=>f.x)),
    right:Math.max(...layer.fragments.map(f=>f.x+f.end-f.start)),
    top:Math.min(...layer.fragments.map(f=>f.y))*ROW_HEIGHT,
    bottom:Math.max(...layer.fragments.map(f=>f.y+rowCount(f)))*ROW_HEIGHT,
  }
}
export function fitCamera(layer,width,_height) {
  const bounds=layerBounds(layer)
  if(!bounds)return defaultCamera()
  return {x:bounds.left,y:bounds.top,scale:clamp(Math.max(40,width-MARGIN_X-24)/Math.max(1,bounds.right-bounds.left),Number.EPSILON,18)}
}
/** Keep a useful whole-layer overview as the zoom-out limit, with small pan
 * margins. Horizontal magnification never changes row spacing or source layout. */
export function constrainCamera(layer,camera,size) {
  const b=layer.id==='original'&&layer.extent?{left:0,right:layer.extent,top:0,bottom:Math.max((layer.rowExtent||1)*ROW_HEIGHT,...layer.fragments.map(f=>f.y*ROW_HEIGHT+rowCount(f)*ROW_HEIGHT))}:layerBounds(layer)
  if(!b)return defaultCamera()
  const width=Math.max(40,size.width-MARGIN_X-24),height=Math.max(26,size.height-MARGIN_Y-12)
  const minScale=Math.min(18,width/Math.max(1,b.right-b.left))
  const scale=clamp(Number(camera.scale)||minScale,minScale,24),span=width/scale
  const x=span>=b.right-b.left?b.left-(span-(b.right-b.left))/2:clamp(Number(camera.x)||0,b.left-span*.1,b.right-span*.9)
  const y=b.bottom-b.top<=height?b.top:clamp(Number(camera.y)||0,b.top-height*.1,b.bottom-height*.9)
  return {x,y,scale}
}
export function validateLayerWorkspace(value,ids) {
  if(!value||value.version!==2||!Array.isArray(value.layers)||value.layers.length>100)throw new Error('This is not a layer workspace. Open an alignment to start a new one.')
  const known=new Set(ids),seen=new Set(),fragmentsSeen=new Set()
  const layers=value.layers.map((l,i)=>{
    if(typeof l.id!=='string'||l.id==='original'||seen.has(l.id)||!Array.isArray(l.fragments))throw new Error('Invalid layer identifiers')
    seen.add(l.id)
    const fragments=l.fragments.map(f=>{
      if(typeof f.id!=='string'||fragmentsSeen.has(f.id))throw new Error('Invalid or duplicate fragment identifiers')
      fragmentsSeen.add(f.id)
      if(!Number.isInteger(f.sourceBlock)||f.sourceBlock<1||!Number.isInteger(f.start)||!Number.isInteger(f.end)||f.start<0||f.end<=f.start||!Array.isArray(f.rowIds)||!f.rowIds.length||f.rowIds.some(id=>!known.has(id)))throw new Error('Workspace contains unavailable sequences or invalid alignment intervals')
      if(!Number.isFinite(f.x)||!Number.isFinite(f.y)||f.slots&&(!Array.isArray(f.slots)||f.slots.length!==f.rowIds.length||f.slots.some(v=>!Number.isInteger(v)||v<0)))throw new Error('Invalid fragment layout')
      if(f.coverage)for(const id of f.rowIds){if(!Array.isArray(f.coverage[id])||f.coverage[id].some(([a,b])=>!Number.isInteger(a)||!Number.isInteger(b)||a<f.start||b>f.end||b<=a))throw new Error('Invalid fragment coverage')}
      return {...f,rowIds:[...new Set(f.rowIds)]}
    })
    return {...l,camera:{x:Number(l.camera?.x)||0,y:Number(l.camera?.y)||0,scale:clamp(Number(l.camera?.scale)||2,Number.EPSILON,24)},name:String(l.name||`Layer ${i+1}`).slice(0,120),color:/^#[\da-f]{6}$/i.test(l.color)?l.color:PALETTE[i%PALETTE.length],fragments}
  })
  return {...emptyWorkspace(),...value,layers,rowOrder:Array.isArray(value.rowOrder)&&value.rowOrder.every(id=>typeof id==='string')?value.rowOrder:null,original:!!value.original||!layers.length,active:layers.some(l=>l.id===value.active)?value.active:layers[0]?.id||'',selection:[],camera:{x:Number(value.camera?.x)||0,y:Number(value.camera?.y)||0,scale:clamp(Number(value.camera?.scale)||2,Number.EPSILON,24)}}
}

/** Hit-test highlighted cells in layout coordinates, including sparse merged rows. */
export function selectedCellAt(layer, selections, point, camera = null) {
  return selections.some(selection => {
    const fragment = layer.fragments.find(f => f.id === selection.fragmentId)
    if (!fragment) return false
    const column = Math.floor(layerXToColumn(fragment, camera, point.x))
    if (column < selection.start || column >= selection.end) return false
    return selection.rowIds.some(id => {
      const index = fragment.rowIds.indexOf(id)
      if (index < 0) return false
      const y = fragment.y + rowSlot(fragment, index)
      return point.y >= y && point.y < y + 1 && hasCell(fragment, id, column)
    })
  })
}

/** Leave approximately 110 screen pixels for distance labels after fitting. */
export function chunkGap(fragments,width=1000) {
  const bases=fragments.reduce((n,f)=>n+f.end-f.start,0)
  return Math.max(6,110*bases/Math.max(240,width-MARGIN_X-24-110*Math.max(0,fragments.length-1)))
}
/** Insert by source order, moving only obstructing successors horizontally.
 * Existing vertical placements and row slots are deliberately preserved. */
export function insertChunks(existing,incoming,gap=64) {
  let result=existing.map(f=>({...f}))
  for(const f of [...incoming].sort(sourceOrder)) {
    const ordered=[...result].sort(sourceOrder),at=ordered.findIndex(other=>sourceOrder(f,other)<0)
    const next=at<0?null:ordered[at],prev=at<0?ordered.at(-1):ordered[at-1]
    const neighbour=[prev,next].find(n=>n&&n.rowIds.some(id=>f.rowIds.includes(id)))||prev||next
    const width=f.end-f.start,x=prev?prev.x+prev.end-prev.start+gap:next?next.x-width-gap:0
    if(next){let edge=x+width+gap;for(const successor of ordered.slice(at)){if(successor.x<edge)successor.x=edge;edge=successor.x+successor.end-successor.start+gap}}
    let slot=neighbour?rowCount(neighbour):0
    const slots=f.rowIds.map(id=>{const i=neighbour?.rowIds.indexOf(id)??-1;return i>=0?rowSlot(neighbour,i):slot++})
    result.push({...f,x,y:neighbour?.y||0,slots:neighbour?slots:null})
  }
  return result
}

/** FASTA preserves a chunk's rectangular span. Unselected or unavailable cells
 * are N, distinct from observed alignment gaps; source identities remain intact. */
export function chunkFasta(fragment,rows) {
  const byId=new Map(rows.map(r=>[r.id,r]))
  return fragment.rowIds.map(id=>{
    const row=byId.get(id),sequence=Array.from({length:fragment.end-fragment.start},(_,i)=>hasCell(fragment,id,fragment.start+i)?row?.sequence?.[i]||'N':'N').join('')
    const source=String(row?.source||id).replace(/[\r\n]/g,' ')
    return `>${id} source=${source} block=${fragment.sourceBlock} columns=${fragment.start+1}-${fragment.end}\n${sequence.match(/.{1,80}/g)?.join('\n')||''}\n`
  }).join('')
}

export function sourceViewAnchor(fragments,camera) {
  const distance=f=>Math.max(f.x-camera.x,0,camera.x-(f.x+f.end-f.start))
  return fragments.reduce((best,f)=>!best||distance(f)<distance(best)?f:best,null)
}
/** Which source blocks the Original view is actually showing. Zoomed in, the
 * anchor block is the current one. At overview scales every visible descriptor
 * stands for a run of blocks, so no single block is current: naming the anchor's
 * first block there claims the view is at block 1 while it shows the whole file.
 * Report the span the visible groups cover instead. */
export function visibleSourceRange(fragments,camera,viewportWidth) {
  const anchor=sourceViewAnchor(fragments,camera)
  if(!anchor)return null
  if(!anchor.aggregate)return {grouped:false,first:anchor.sourceBlock,last:anchor.sourceBlock}
  // A layout response groups uniformly, and useOriginalBlocks never overlays two
  // overview levels, so the visible descriptors are all aggregates here.
  const span=Math.max(40,viewportWidth-MARGIN_X-24)/Math.max(Number.EPSILON,camera.scale)
  const shown=fragments.filter(f=>f.aggregate&&f.x<camera.x+span&&f.x+(f.end-f.start)>camera.x)
  const pool=shown.length?shown:[anchor]
  return {grouped:true,first:Math.min(...pool.map(f=>f.aggregate.first)),last:Math.max(...pool.map(f=>f.aggregate.last))}
}
/** Store Original's camera relative to its visible source block, independent of
 * the disposable sliding strip and its current neighbours. */
export function workspaceForSave(state,originalFragments) {
  const anchor=state.original?sourceViewAnchor(originalFragments,state.camera):null
  return anchor?{...state,sourceBlock:anchor.sourceBlock,camera:{...state.camera,x:state.camera.x-anchor.x}}:state
}
