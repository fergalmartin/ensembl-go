import { MARGIN_X, MARGIN_Y, ROW_HEIGHT, HEADER_HEIGHT } from './layout.js'
import { BUILTIN_GENOME_COLOR_PALETTE } from '../../genomeColorSchemes.js'
import { schemeById, shadingById, COLOUR_SCHEMES } from './colourSchemes.js'
import { paletteById } from './palettes.js'
/** Alignment fragments reference immutable source columns. Layout never changes biology. */
/** Layers take the genome palette, so a colour means the same thing wherever it
 * is seen in the app and the picker offers exactly what is already on screen
 * elsewhere. New layers cycle it; editing a layer opens the same picker the
 * genome selector uses. */
export const PALETTE = BUILTIN_GENOME_COLOR_PALETTE
export const clamp = (v, min, max) => Math.max(min, Math.min(max, v))
export const newId = () => crypto.randomUUID()
export const defaultCamera = () => ({ x: 0, y: 0, scale: 2, plane: 1 })
/** A saved palette choice per scheme, each sanitised to a palette that exists
 * for that scheme's kind. A workspace saved before palettes existed, or one
 * naming a palette since removed, falls back rather than painting nothing. */
export function validPalettes(value) {
  const picked = {}
  for (const scheme of COLOUR_SCHEMES) {
    const chosen = value?.[scheme.id]
    if (typeof chosen === 'string') picked[scheme.id] = paletteById(scheme.palettes, chosen).id
  }
  return picked
}
export const emptyWorkspace = () => ({ version: 2, filter: null, filterOff: false, hidden: null, hideWhat: 'blocks', hideMode: 'or', hideMemory: null, rowOrder: null, layers: [], active: '', original: true, sourceBlock: 1, mode: 'pan', annotations: false, colourScheme: 'bases', palette: {}, shading: 'relative', legendOverlay: false, connectionUnit: 'columns', highlighted: [], selection: [], planeZoom: false, camera: defaultCamera() })
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
    const cuts=[]
    for(const pick of picks){
      const next=[]
      for(const part of remaining){
        const cut=cutFragment(part,pick)
        if(cut.extracted)cuts.push(cut.extracted)
        next.push(...cut.remaining)
      }
      remaining=next
    }
    // One pick is one chunk wherever its pieces sit side by side again - and so
    // are several picks over one block, which is what picking sequences by name
    // makes: one pick per row. Cutting a chunk per pick gave a block as many
    // one-row panels as rows picked, stacked at the same place, each painting
    // its own background over the ones above it, so all but one row of every
    // block went blank. A block is one chunk carrying the rows taken from it,
    // the shape it has in the alignment itself.
    if(cuts.length)extracted.push(...combineOverlaps(cuts,workspace.rowOrder||[]))
    if(!copy)fragments=fragments.flatMap(f=>f.id===fragmentId?remaining:[f])
  }
  if(!extracted.length)return workspace
  let layers=workspace.layers.map(l=>l.id===source.id?{...l,fragments}:l)
  if(targetLayer)layers=[...layers,targetLayer]
  const target=layers.find(l=>l.id===targetId)
  if(!target)return workspace
  const placed=insertChunks(target.fragments,extracted,chunkGap([...target.fragments,...extracted],viewportWidth))
  layers=layers.map(l=>l.id===targetId?{...l,fragments:placed}:l)
  return {...workspace,layers,active:targetId,original:false,selection:[],highlighted:[],camera:{...target.camera}}
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

/** The rows lit by clicking a cell, a string or a jump marker.
 *
 * One row at a time was the original idea - "follow this path" - and it held
 * only the last row clicked. But a row picked by name lights up in exactly the
 * same gold, so nothing on screen says which of the lit rows is the one slot.
 * Lighting a third row put out the second and read as a plain bug: picks add
 * up, as the sidebar promises, and there was no way to tell that these did not.
 * They accumulate now, and clicking a lit row again puts it out.
 *
 * A workspace saved before this held a single id, so a string still reads as the
 * one row it lit. */
export const highlightedRows = value =>
  Array.isArray(value)?value.filter(id=>typeof id==='string'&&id):typeof value==='string'&&value?[value]:[]
/** Light a row. Pressing a jump marker, or landing in the block it names, is a
 * move along that row rather than a verdict on whether it should be lit, so
 * this never puts one out. */
export const addHighlight = (value,rowId) => {
  const rows=highlightedRows(value)
  return rows.includes(rowId)?rows:[...rows,rowId]
}
export const removeHighlight = (value,rowId) => highlightedRows(value).filter(id=>id!==rowId)
/** Light a set of rows, or put them all out when every one is already lit, so a
 * second pass over the same names takes them back out - the same way picks
 * toggle, because to the reader these are the same act as picking a name whose
 * sequence happens to be on the sheet. */
export function toggleHighlights(value,ids) {
  const rows=highlightedRows(value)
  if(!ids?.length)return rows
  const wanted=new Set(ids)
  if(ids.every(id=>rows.includes(id)))return rows.filter(id=>!wanted.has(id))
  return [...rows,...ids.filter(id=>!rows.includes(id))]
}

/** Every row drawn in the picked gold, from both of the things that light one.
 *
 * Picking a name lights a row, and so does clicking one of its cells, and on
 * screen the two are the same gold. Nothing tells a reader which of them is
 * holding a row up, so both have to answer to a click on it: while a click on a
 * name only dropped the picks, a row lit by both kept its colour and could not
 * be put out at all - and a click on a cell of a picked row appeared to do
 * nothing, because it was toggling a highlight that was not what was lighting
 * the row.
 */
export function litRows(state) {
  const rows=pickedRowIds(state.selection||[])
  for(const id of highlightedRows(state.highlighted))rows.add(id)
  return rows
}
export const rowIsLit = (state,rowId) => litRows(state).has(rowId)
/** Put a row out, whichever of the two is lighting it: clicking something gold
 * means all of it, not the half this gesture happens to own. */
export const unlightRow = (state,rowId) => ({
  selection:removeRowPicks(state.selection||[],rowId),
  highlighted:removeHighlight(state.highlighted,rowId)})

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

/** Put a row where another one currently sits, pushing that one down.
 *
 * The drop is named by the row the reader let go over rather than by a number,
 * because the number a row is drawn at is not its number in the order: compact
 * rows list one block's sequences, a filter lists a subset, and either way an
 * index taken off the screen means something else in the order behind it. Naming
 * the row makes the two agree by construction. A null target appends. */
export function moveRowBefore(order,id,beforeId) {
  // Moving a row the order does not have must not add one.
  if(beforeId===id||!order.includes(id))return order
  const rest=order.filter(other=>other!==id)
  if(beforeId==null)return [...rest,id]
  const at=rest.indexOf(beforeId)
  return at<0?order:[...rest.slice(0,at),id,...rest.slice(at)]
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

/** The rows a fragment actually carries sequence for.
 *
 * A source block lists rows it holds no sequence in - the MAF `e` lines, saying
 * the sequence exists in that genome but has nothing in this block - and those
 * are drawn as an empty band on an aligned sheet. They are not part of the path:
 * a string out of one says this sequence continues from here, when there is
 * nothing here for it to continue from. A chunk cut into a layer inherits the
 * list, so the answer is always narrowed by the rows the fragment has. */
export function presentRows(fragment) {
  if(!fragment.availableRows)return fragment.rowIds
  const has=new Set(fragment.availableRows)
  return fragment.rowIds.filter(id=>has.has(id))
}

export function layerConnections(layer) {
  const byRow=new Map(), result=[]
  for(const f of layer.fragments)for(const id of presentRows(f)){if(!byRow.has(id))byRow.set(id,[]);byRow.get(id).push(f)}
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
    for(const id of presentRows(f)){
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
 * gutter still pans the alignment as it does everywhere else.
 *
 * `scrollable` is what stops the gutter taking a wheel it has no use for. Left
 * of the gutter edge is not by itself a row list: a layer that draws no gutter
 * has sequence there, and a list wholly on screen has nowhere to scroll to, so
 * in both cases the notch was a zoom near the left edge and swallowing it turned
 * that zoom into a scroll — or into nothing at all.
 *
 * A modified wheel is never the list's either. Ctrl is an explicit zoom or pinch
 * and Shift a deliberate second axis; both mean over the names what they mean
 * over the sequence. */
export function wheelScrollsRowList(pointX,descriptor,marginX,scrollable) {
  if(!scrollable)return false
  if(!(pointX<marginX))return false
  if(descriptor?.ctrl||descriptor?.shift||descriptor?.alt)return false
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
 * `edge` is the side of the fragment the marker sits on (1 right, -1 left), and
 * it always faces the block named on the label - forward to where the path goes,
 * back to where it came from - so the chevron drawn along it points at whatever
 * clicking the marker would open. A link whose far end is outside the loaded
 * window contributes only the end that exists. */
export function blockJumpMarkers(connections,offWindow,rects,buried={}) {
  const markers=[]
  for(const c of connections){
    if(!linkIsBuried(c,rects,buried))continue
    const flow=c.to.sourceBlock>c.from.sourceBlock?1:-1
    markers.push({id:`${c.id}:out`,fragmentId:c.from.id,rowId:c.rowId,edge:flow,block:c.to.sourceBlock})
    markers.push({id:`${c.id}:in`,fragmentId:c.to.id,rowId:c.rowId,edge:-flow,block:c.from.sourceBlock})
  }
  // Off-window stubs stand for blocks outside the loaded window, which a packed
  // sheet does not have: everything it holds is on it.
  if(!buried.packed)for(const link of offWindow)
    markers.push({id:link.id,fragmentId:link.fragment.id,rowId:link.rowId,edge:link.direction,block:link.block})
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
/** Whether a link is buried by what is drawn over it, and so has to be carried
 * by edge markers instead of a line.
 *
 * One rule for both passes. The painter draws the lines first and the panels
 * over them, then adds markers for the buried ones; when the two passes asked
 * this question differently, a link could be dropped from the first as buried
 * and from the second as not, and vanish from the picture altogether.
 *
 * A packed sheet answers from what it draws, the way a layer does. Hiding is
 * what put the gaps in its numbering, so a path from 7 to 9 over a hidden 8 is
 * an ordinary line: the reader asked for the blocks that are left to sit
 * together. A block still standing between the ends is a different matter and
 * still buries the link - drawn as a line it would run behind that block and
 * read as a sequence passing through one it is not in.
 */
export const linkIsBuried=(connection,rects,{original=false,packed=false}={})=>
  pathIsOccluded(connection,rects,original&&!packed)

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
  return {x:bounds.left,y:bounds.top,scale:clamp(Math.max(40,width-MARGIN_X-24)/Math.max(1,bounds.right-bounds.left),Number.EPSILON,18),plane:1}
}
/** Where the camera may travel: the whole file for Original, whatever has been
 * arranged for a layer. */
export function viewBounds(layer) {
  if(layer?.id==='original'&&layer.extent)return {left:0,right:layer.extent,top:0,
    bottom:Math.max((layer.rowExtent||1)*ROW_HEIGHT,...layer.fragments.map(f=>f.y*ROW_HEIGHT+rowCount(f)*ROW_HEIGHT))}
  return layerBounds(layer)
}
/** Zooming the whole arrangement as one flat sheet.
 *
 * The ordinary zoom is horizontal: it changes how many columns a pixel covers
 * and leaves rows 26 pixels tall, because that is what reading an alignment
 * wants. It can never answer "what does all of this look like", since the rows
 * always outrun the window however far out it goes.
 *
 * Plane zoom shrinks the drawing instead of the biology. Nothing in the layout
 * changes: the painter keeps working in exactly the units it always did and the
 * canvas is scaled once at the end, so blocks, names, labels, strings and every
 * hit region shrink together and stay in register. Dragging, picking and
 * reordering therefore need no special case; a pointer position is divided by
 * the plane factor and everything downstream is unchanged. The viewport the
 * painter is told about grows by the same factor, and that is where the
 * whitespace around the edges comes from. */
/** How far out the sheet may be pushed. One limit for everything, so a layer
 * offers the same travel as Original rather than stopping early because it
 * happens to be small.
 *
 * Past roughly this point the drawing stops being an overview and becomes
 * noise: rows fall under a pixel, a block is a few pixels of bar, and what is
 * left is a scatter of marks that cannot be read or clicked. Ending here keeps
 * every zoom in the range workable. */
export const PLANE_MIN=0.15
export const planeOf=camera=>clamp(Number(camera?.plane)||1,PLANE_MIN,1)
/** The viewport the painter is given: real pixels over the plane factor, so
 * shrinking the sheet shows more of the world rather than less of it. */
export const planeViewport=(size,camera)=>{const plane=planeOf(camera);return {width:size.width/plane,height:size.height/plane}}
/** The scale at which the thing being looked at fills the width - one source
 * block in Original, the whole arrangement in a layer - but never past the point
 * where blocks would start being merged. Panel zoom no longer moves the column
 * scale at all, so this is left for callers that still want that limit.
 *
 * That second half matters because a source block can be twice the width at
 * which merging begins, so fitting one to the window is enough on its own to
 * ask the server for an overview. Panel mode is a view of individual blocks;
 * the sheet shrinking is what shows more of them, not a coarser summary. */
export function blockFitScale(layer,camera,size) {
  const solid=(layer?.fragments||[]).filter(f=>!f.aggregate)
  const anchor=layer?.id==='original'?sourceViewAnchor(solid,camera):null
  const target=anchor?{fragments:[anchor]}:layer?.id==='original'?null:layer
  const fit=target?.fragments?.length?fitCamera(target,size.width,size.height).scale:Math.max(Number.EPSILON,Number(camera?.scale)||1)
  return layer?.id==='original'?Math.max(fit,size.width/BLOCK_DETAIL_SPAN):fit
}
/** One zoom step in panel mode: the panel, and nothing else.
 *
 * Always the sheet, never the columns. Spending the column magnification first
 * made the mode a hybrid - zooming out over the alignment behaved exactly like
 * Alignment mode until that magnification ran out, which is not what a control
 * called Panel should do. One gesture, one meaning: out shrinks the sheet from
 * the first step, in gives its size back and stops at full size, because going
 * closer than that is what Alignment mode is for.
 *
 * Always about the middle of the window, never the cursor. That is what centres
 * the view: every zoom out pulls the drawing toward the middle, so whitespace
 * opens above and below it instead of the blocks staying pinned under the ruler. */
export function panelZoom(camera,factor,{size,floor=PLANE_MIN}) {
  const plane=planeOf(camera)
  return zoomPlane(camera,factor,{x:size.width/plane/2,y:size.height/plane/2},floor)
}
/** A zoom-in that panel mode cannot answer: the sheet is already full size, and
 * closer than that is what Alignment mode is for.
 *
 * Panel mode stops here on purpose, but a stop is silent - the gesture simply
 * does nothing, which reads as a broken control rather than a boundary. Naming
 * the attempt lets the view say where the rest of the zoom lives. Only zoom-in
 * counts: stopping at the far end is the overview limit, a different boundary
 * with nowhere else to send the reader. */
export function panelZoomBlocked(camera,factor) {
  return factor>1&&planeOf(camera)>=1
}
/** Blocked gestures before the hint appears. One is an ordinary overshoot at the
 * end of a zoom and saying anything about it would be nagging; repeating the
 * gesture is someone expecting more zoom than this mode has. */
export const PANEL_ZOOM_HINT_ATTEMPTS=2
/** How long the hint stays over the panel before it fades out on its own.
 *
 * Long enough to read a sentence and reach the button, short enough that it is
 * gone before it becomes part of the furniture. The fade itself is the tail of
 * this same span, so the element is removed exactly as it finishes. */
export const ZOOM_HINT_MS=5000
/** Entering panel mode lands on blocks.
 *
 * A merged overview is not something to shrink: those bars are already a summary
 * of a summary, and scaling them down is where the drawing fell apart. Coming
 * from one, the columns are magnified until individual blocks are drawn again.
 * Coming from sequence detail nothing moves, because zooming out is about to
 * walk down to the same place. */
export function enterPanelZoom(camera,size) {
  const span=Math.max(1,size.width/Math.max(Number.EPSILON,camera.scale))
  if(!(span>BLOCK_DETAIL_SPAN))return {...camera,plane:1}
  const scale=size.width/BLOCK_DETAIL_SPAN
  return {...camera,plane:1,scale,x:camera.x+(size.width/2-MARGIN_X)*(1/camera.scale-1/scale)}
}
/** Leaving it puts the sheet back to full size with the rows against the top
 * edge, keeping whatever column was in the middle of the window in the middle. */
export function exitPanelZoom(camera,layer,size) {
  const plane=planeOf(camera),b=viewBounds(layer)
  const column=camera.x+(size.width/plane/2-MARGIN_X)/camera.scale
  return {...camera,plane:1,x:column-(size.width/2-MARGIN_X)/camera.scale,y:b?b.top:0}
}
/** Plane zoom about a point, which stays where it is on screen. The point is in
 * plane units, the same ones the painter and every hit region use. */
export function zoomPlane(camera,factor,point,floor=PLANE_MIN) {
  const from=planeOf(camera),to=clamp(from*factor,clamp(floor,PLANE_MIN,1),1)
  if(to===from)return camera
  const shift=1-from/to
  return {...camera,plane:to,x:camera.x+point.x*shift/camera.scale,y:camera.y+point.y*shift}
}
/** Keep a useful whole-layer overview as the zoom-out limit, with small pan
 * margins. Horizontal magnification never changes row spacing or source layout.
 *
 * The floor under scale is the one the window gives at full size, whatever the
 * plane is doing. Carrying on past it is plane zoom's job, and taking the floor
 * from the shrunken window instead would drive the columns straight back out to
 * the edges, so there would never be any whitespace to see. */
/** The vertical room the sheet is given inside the window. */
const windowRows=view=>Math.max(26,view.height-MARGIN_Y-12)
/** Whether there is a row list to scroll at all.
 *
 * A sheet shorter than the window is pinned by `constrainCamera`, so a wheel
 * spent on it moves nothing at all — and a dead wheel over the names is worse
 * than the zoom the reader was asking for. */
export function rowListScrolls(layer,camera,size) {
  const b=viewBounds(layer)
  return !!b&&b.bottom-b.top>windowRows(planeViewport(size,{plane:planeOf(camera)}))
}
export function constrainCamera(layer,camera,size) {
  const b=viewBounds(layer)
  if(!b)return defaultCamera()
  const minScale=Math.min(18,Math.max(40,size.width-MARGIN_X-24)/Math.max(1,b.right-b.left))
  const scale=clamp(Number(camera.scale)||minScale,minScale,24)
  const plane=planeOf(camera)
  const view=planeViewport(size,{plane})
  const width=Math.max(40,view.width-MARGIN_X-24),height=windowRows(view),span=width/scale
  const x=span>=b.right-b.left?b.left-(span-(b.right-b.left))/2:clamp(Number(camera.x)||0,b.left-span*.1,b.right-span*.9)
  // Shrunken, the sheet is held in the middle of the window: it may sit up to
  // half a window down, which is what lets whitespace open above it. At full
  // size it stays against the top edge, which is where reading starts.
  // Sideways the old margins hold either way, so the first block still begins
  // near the gutter rather than out in the middle of an empty window.
  const room=plane<1?.5:.1,tail=plane<1?.5:.9
  const y=b.bottom-b.top<=height?b.top-(plane<1?(height-(b.bottom-b.top))/2:0):clamp(Number(camera.y)||0,b.top-height*room,b.bottom-height*tail)
  return {x,y,scale,plane}
}
/** What a hide was asked for: the picks, and the settings that read them. */
function hideSettings(value) {
  const picks=value?.choice
  if(!picks||!Array.isArray(picks.blocks)||!Array.isArray(picks.rows))return null
  return {choice:{blocks:picks.blocks.filter(b=>Number.isInteger(b)&&b>0).slice(0,4000),
    rows:picks.rows.filter(id=>typeof id==='string').slice(0,5000)},
    what:['blocks','sequences','both'].includes(value.what)?value.what:'blocks',
    mode:value.mode==='and'?'and':'or'}
}
/** What a hide did: the blocks and rows left standing, and the view to return to. */
function hiddenState(value) {
  if(!value)return null
  const blocks=Array.isArray(value.blocks)&&value.blocks.every(b=>Number.isInteger(b)&&b>0)?value.blocks.slice(0,4000):null
  const rows=Array.isArray(value.rows)&&value.rows.every(id=>typeof id==='string')?value.rows.slice(0,5000):null
  if(!blocks?.length&&!rows?.length)return null
  const settings=hideSettings(value)
  return {blocks,rows,camera:value.camera?{...defaultCamera(),...value.camera}:null,
    what:settings?.what||(blocks?.length?'blocks':'sequences'),mode:settings?.mode||'or',choice:settings?.choice||null}
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
    return {...l,camera:{x:Number(l.camera?.x)||0,y:Number(l.camera?.y)||0,scale:clamp(Number(l.camera?.scale)||2,Number.EPSILON,24),plane:planeOf(l.camera)},name:String(l.name||`Layer ${i+1}`).slice(0,120),color:/^#[\da-f]{6}$/i.test(l.color)?l.color:PALETTE[i%PALETTE.length],fragments}
  })
  // A hidden set is a list of block numbers and the view to come back to.
  const hidden=hiddenState(value.hidden),hideMemory=hideSettings(value.hideMemory)
  return {...emptyWorkspace(),...value,hidden,hideMemory,layers,colourScheme:schemeById(value.colourScheme).id,palette:validPalettes(value.palette),shading:shadingById(value.shading).id,legendOverlay:!!value.legendOverlay,highlighted:highlightedRows(value.highlighted).filter(id=>known.has(id)),rowOrder:Array.isArray(value.rowOrder)&&value.rowOrder.every(id=>typeof id==='string')?value.rowOrder:null,original:!!value.original||!layers.length,active:layers.some(l=>l.id===value.active)?value.active:layers[0]?.id||'',selection:[],camera:{x:Number(value.camera?.x)||0,y:Number(value.camera?.y)||0,scale:clamp(Number(value.camera?.scale)||2,Number.EPSILON,24),plane:planeOf(value.camera)}}
}

/** The names a selection rectangle covers.
 *
 * Inclusive on every edge, so a press that never travelled still covers the
 * name under it: in Select mode a click on a name has to go on meaning that
 * name, and a rectangle of no width is what a click looks like here.
 *
 * Columns mode ignores the vertical extent, exactly as it does over sequence:
 * the names are one column, so touching it takes all of them.
 */
export function namesInRect(labels, rect, columnsOnly = false) {
  const covers = box => rect.x1 <= box.x + box.width && rect.x2 >= box.x
    && (columnsOnly || (rect.y1 <= box.y + box.height && rect.y2 >= box.y))
  return [...new Set(labels.filter(covers).map(label => label.rowId))]
}

/** Whether a rectangle reached past the names into the sequence itself.
 *
 * A drag that starts on the names and carries on into the alignment is an
 * ordinary region selection; only one that stays among the names is about the
 * names. `left` is where sequence actually becomes visible - the Original keeps
 * an opaque name gutter drawn over the blocks behind it, so a block scrolled
 * under that gutter is not something the reader can see or mean.
 */
export function rectEntersCells(panels, rect, left = 0) {
  return panels.some(panel => {
    const x = Math.max(panel.x, left)
    return rect.x2 > x && rect.x1 < panel.x + panel.width
      && rect.y2 > panel.y && rect.y1 < panel.y + panel.height
  })
}

/** Drop a chunk from a working layer.
 *
 * Only ever a working layer. The Original alignment is a derived view of the
 * source, so there is nothing there to take away: removing a block from it
 * would have to mean either hiding it, which the Hide control already does and
 * remembers, or editing the file, which this app never does.
 */
export function removeFragment(layer, fragmentId) {
  const fragments = layer.fragments.filter(f => f.id !== fragmentId)
  return fragments.length === layer.fragments.length ? layer : { ...layer, fragments: compactSlots(fragments) }
}

/** Drop a sequence from every chunk in a working layer.
 *
 * A chunk left holding no sequences is removed rather than kept as an empty
 * panel: it has no rows to show and nothing to drag anywhere.
 */
export function removeRowFromLayer(layer, rowId) {
  const fragments = []
  let changed = false
  for (const fragment of layer.fragments) {
    const index = fragment.rowIds.indexOf(rowId)
    if (index < 0) { fragments.push(fragment); continue }
    changed = true
    const rowIds = fragment.rowIds.filter(id => id !== rowId)
    if (!rowIds.length) continue
    const next = { ...fragment, rowIds }
    // slots runs parallel to rowIds, so it loses the same position; coverage and
    // availableRows are keyed by row and lose the entry.
    if (fragment.slots) next.slots = fragment.slots.filter((_, i) => i !== index)
    if (fragment.coverage) { const coverage = { ...fragment.coverage }; delete coverage[rowId]; next.coverage = coverage }
    if (fragment.availableRows) next.availableRows = fragment.availableRows.filter(id => id !== rowId)
    fragments.push(next)
  }
  return changed ? { ...layer, fragments: compactSlots(fragments) } : layer
}

/** Close the lanes nothing is left in.
 *
 * A row keeps one slot for the whole layer, so a slot freed by a removal is
 * freed everywhere. Left as it was, every remaining chunk would carry a blank
 * lane where the sequence used to be, and the layer would keep growing taller
 * the more was taken out of it. Renumbering preserves the shared slots that
 * make rows line up across chunks: only the empty lanes close.
 */
function compactSlots(fragments) {
  const used = new Set()
  for (const fragment of fragments) fragment.rowIds.forEach((_, i) => used.add(rowSlot(fragment, i)))
  const mapping = new Map([...used].sort((a, b) => a - b).map((slot, i) => [slot, i]))
  if ([...mapping].every(([from, to]) => from === to)) return fragments
  return fragments.map(fragment => {
    const slots = fragment.rowIds.map((_, i) => mapping.get(rowSlot(fragment, i)))
    const next = { ...fragment, slots }
    if (fragment.layoutRows != null) next.layoutRows = slots.length ? Math.max(...slots) + 1 : 0
    return next
  })
}

/** Hit-test highlighted cells in layout coordinates, including sparse merged rows. */
export function selectedCellAt(layer, selections, point, camera = null) {
  return !!pickAt(layer, selections, point, camera)
}

/** Which pick the pointer is inside, rather than merely whether it is inside one.
 *
 * Returned by reference, so a caller can hold on to it across a repaint and know
 * it is still the same pick. Indices cannot do that: the selection can change
 * between the paint that drew a control and the click that presses it, and an
 * index would then name whichever pick had moved into that position.
 */
export function pickAt(layer, selections, point, camera = null) {
  for (const selection of selections) {
    const fragment = layer.fragments.find(f => f.id === selection.fragmentId)
    if (!fragment) continue
    const column = Math.floor(layerXToColumn(fragment, camera, point.x))
    if (column < selection.start || column >= selection.end) continue
    const inside = selection.rowIds.some(id => {
      const index = fragment.rowIds.indexOf(id)
      if (index < 0) return false
      const y = fragment.y + rowSlot(fragment, index)
      return point.y >= y && point.y < y + 1 && hasCell(fragment, id, column)
    })
    if (inside) return selection
  }
  return null
}

/** The rows a pick actually covers in this fragment, topmost slot first, so a
 * control can be put on the corner of the region rather than of the block. */
export function pickSlots(fragment, selection) {
  const slots = selection.rowIds.map(id => fragment.rowIds.indexOf(id)).filter(i => i >= 0).map(i => rowSlot(fragment, i))
  return slots.length ? { top: Math.min(...slots), bottom: Math.max(...slots) } : null
}

/** Leave approximately 110 screen pixels for distance labels after fitting. */
export function chunkGap(fragments,width=1000) {
  if(!fragments.length)return 6
  const bases=fragments.reduce((n,f)=>n+f.end-f.start,0)
  // Room for one label per gap runs out quickly: past a dozen or so chunks the
  // subtraction goes negative, and clamping the divisor rather than giving up
  // turned the answer into a void hundreds of times wider than the chunks it
  // separates. Moving three sequences of a whole file - 480 chunks - asked for
  // 220,000 columns between 1,000-column chunks, and fitting that put the whole
  // layer on a single hairline. Where the labels cannot all fit anyway, this
  // stops bidding for them and just spaces the chunks apart.
  const room=width-MARGIN_X-24-110*Math.max(0,fragments.length-1)
  return Math.max(6,room>=240?110*bases/room:bases/fragments.length/4)
}
/** Insert by source order, moving only obstructing successors horizontally.
 * Existing vertical placements and row slots are deliberately preserved.
 *
 * A row keeps one slot across the whole layer. Each chunk used to take its rows
 * from the neighbour it was placed beside and put anything the neighbour did not
 * hold on a fresh slot below it, which is right for one chunk and ruinous for a
 * batch: chained down a run of blocks whose membership varies - most files - the
 * same three sequences stepped one row lower at every chunk, and moving them out
 * of a 200-block alignment drew a staircase hundreds of rows deep instead of
 * three straight lines. */
export function insertChunks(existing,incoming,gap=64) {
  let result=existing.map(f=>({...f}))
  // Rows already placed keep the slot they have; rows arriving with the batch
  // take the next ones, in the order the blocks introduce them.
  const slotOf=new Map()
  for(const f of existing)f.rowIds.forEach((id,i)=>{if(!slotOf.has(id))slotOf.set(id,rowSlot(f,i))})
  let free=slotOf.size?Math.max(...slotOf.values())+1:0
  for(const f of [...incoming].sort(sourceOrder))for(const id of f.rowIds)if(!slotOf.has(id))slotOf.set(id,free++)
  for(const f of [...incoming].sort(sourceOrder)) {
    const ordered=[...result].sort(sourceOrder),at=ordered.findIndex(other=>sourceOrder(f,other)<0)
    const next=at<0?null:ordered[at],prev=at<0?ordered.at(-1):ordered[at-1]
    const neighbour=[prev,next].find(n=>n&&n.rowIds.some(id=>f.rowIds.includes(id)))||prev||next
    const width=f.end-f.start,x=prev?prev.x+prev.end-prev.start+gap:next?next.x-width-gap:0
    if(next){let edge=x+width+gap;for(const successor of ordered.slice(at)){if(successor.x<edge)successor.x=edge;edge=successor.x+successor.end-successor.start+gap}}
    result.push({...f,x,y:neighbour?.y||0,slots:f.rowIds.map(id=>slotOf.get(id))})
  }
  return result
}

/** FASTA preserves a chunk's rectangular span. Unselected or unavailable cells
 * are N, distinct from observed alignment gaps; source identities remain intact. */
export function chunkFasta(fragment,rows) {
  const byId=new Map(rows.map(r=>[r.id,r]))
  // Each row is written under its own source name, because the file is read by
  // whatever tool it is pasted into. Copies of one source within a block are
  // suffixed so the names stay unique, matching the server's export.
  const seen=new Map()
  return fragment.rowIds.map(id=>{
    const row=byId.get(id),sequence=Array.from({length:fragment.end-fragment.start},(_,i)=>hasCell(fragment,id,fragment.start+i)?row?.sequence?.[i]||'N':'N').join('')
    const source=String(row?.source||id).replace(/\s+/g,'_')
    const count=seen.get(source)||0
    seen.set(source,count+1)
    const name=count?`${source}/copy${count+1}`:source
    return `>${name} block=${fragment.sourceBlock} columns=${fragment.start+1}-${fragment.end}\n${sequence.match(/.{1,80}/g)?.join('\n')||''}\n`
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
