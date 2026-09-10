import { MARGIN_X, MARGIN_Y, ROW_HEIGHT } from './layout.js'
/** Alignment fragments reference immutable source columns. Layout never changes biology. */
export const PALETTE = ['#76cdb6', '#85b5ec', '#d4adeb', '#e8bd7e', '#ed98ac', '#9dc981']
export const clamp = (v, min, max) => Math.max(min, Math.min(max, v))
export const newId = () => crypto.randomUUID()
export const defaultCamera = () => ({ x: 0, y: 0, scale: 2 })
export const emptyWorkspace = () => ({ version: 2, layers: [], active: '', original: true, sourceBlock: 1, mode: 'pan', tilted: false, annotations: false, connectionUnit: 'columns', highlighted: '', selection: [], camera: defaultCamera() })
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
  for(const selection of workspace.selection) {
    const fragment=fragments.find(f=>f.id===selection.fragmentId)
    if(!fragment)continue
    const cut=cutFragment(fragment,selection)
    if(cut.extracted)extracted.push(cut.extracted)
    if(!copy)fragments=fragments.flatMap(f=>f.id===fragment.id?cut.remaining:[f])
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
export function layerOverlap(source,target) {
  return source.fragments.some(a=>target.fragments.some(b=>overlap(a,b)))
}
export function tidyLayer(layer,rowOrder=[], gap=64) {
  const rows=[...new Set(layer.fragments.flatMap(f=>f.rowIds))].sort((a,b)=>rowOrder.indexOf(a)-rowOrder.indexOf(b))
  let x=0
  const fragments=[...layer.fragments].sort(sourceOrder).map(f=>{
    const next={...f,x,y:0,slots:f.rowIds.map(id=>rows.indexOf(id))}
    x+=f.end-f.start+gap;return next
  })
  return {...layer,fragments}
}
export function mergeLayers(workspace,sourceId,targetId,combine,rowOrder=[]) {
  const source=workspace.layers.find(l=>l.id===sourceId),target=workspace.layers.find(l=>l.id===targetId)
  if(!source||!target||sourceId===targetId)return workspace
  const fragments=combine?combineOverlaps([...target.fragments,...source.fragments],rowOrder):[...target.fragments,...source.fragments]
  const merged=tidyLayer({...target,fragments},rowOrder)
  return {...workspace,layers:workspace.layers.filter(l=>l.id!==sourceId).map(l=>l.id===targetId?merged:l),active:targetId,original:false,selection:[],camera:defaultCamera()}
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
export function firstBlocks(layer) {
  const result=new Map()
  for(const f of [...layer.fragments].sort((a,b)=>a.x-b.x||a.y-b.y))for(const id of f.rowIds)if(!result.has(id))result.set(id,f.id)
  return result
}
export function selectionRect(layer,rect,columnsOnly=false) {
  const selected=[]
  for(const f of layer.fragments){
    if(f.aggregate)continue
    const start=Math.max(f.start,Math.floor(rect.x1-f.x+f.start)),end=Math.min(f.end,Math.ceil(rect.x2-f.x+f.start))
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
  return {...emptyWorkspace(),...value,layers,original:!!value.original||!layers.length,active:layers.some(l=>l.id===value.active)?value.active:layers[0]?.id||'',selection:[],camera:{x:Number(value.camera?.x)||0,y:Number(value.camera?.y)||0,scale:clamp(Number(value.camera?.scale)||2,Number.EPSILON,24)}}
}

/** Hit-test highlighted cells in layout coordinates, including sparse merged rows. */
export function selectedCellAt(layer, selections, point) {
  return selections.some(selection => {
    const fragment = layer.fragments.find(f => f.id === selection.fragmentId)
    if (!fragment) return false
    const column = fragment.start + Math.floor(point.x - fragment.x)
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
/** Store Original's camera relative to its visible source block, independent of
 * the disposable sliding strip and its current neighbours. */
export function workspaceForSave(state,originalFragments) {
  const anchor=state.original?sourceViewAnchor(originalFragments,state.camera):null
  return anchor?{...state,sourceBlock:anchor.sourceBlock,camera:{...state.camera,x:state.camera.x-anchor.x}}:state
}
