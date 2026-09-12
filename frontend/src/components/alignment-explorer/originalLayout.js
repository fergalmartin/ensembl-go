import { rowCount } from './layers.js'
import { MARGIN_X, MARGIN_Y, ROW_HEIGHT } from './layout.js'

/** Stable rows use sequence identity, never active-genome identity. Per-block
 * compaction preserves the first shared row as its vertical anchor. */
/** `filter` narrows what Original shows without touching the source: rows outside
 * it are not laid out and blocks outside it are dropped from the view. Original
 * stays the complete alignment; this is a lens over it, and clearing the filter
 * brings everything straight back. */
export function layoutOriginal(fragments,ids,mode='aligned',overrides={},_maxRows=undefined,filter=null) {
  const allowedRows=filter?.sequences?.length?new Set(filter.sequences):null
  const allowedBlocks=filter?.blocks?.length?new Set(filter.blocks):null
  const visible=allowedRows?ids.filter(id=>allowedRows.has(id)):ids
  const rank=new Map(visible.map((id,i)=>[id,i]))
  return fragments.filter(f=>{
    if(!allowedBlocks)return true
    if(f.aggregate)return true
    return allowedBlocks.has(f.sourceBlock)
  }).map(f=>{
    if(f.aggregate)return {...f,layoutRows:visible.length,slots:f.rowIds.map(id=>rank.get(id)??0)}
    const compact=(overrides[f.sourceBlock]||mode)==='compact'
    const ordered=f.rowIds.filter(id=>(!allowedRows||allowedRows.has(id))&&(!compact||!f.availableRows||f.availableRows.includes(id))).sort((a,b)=>(rank.get(a)??0)-(rank.get(b)??0))
    const slots=ordered.map(id=>rank.get(id)??0)
    const y=compact?(mode==='compact'?0:slots.length?Math.min(...slots):0):0
    return {...f,rowIds:ordered,y,slots:compact?null:slots,layoutRows:compact?ordered.length:visible.length,compact}
  })
}

/** Which line a sequence will occupy in a block once Original has laid it out.
 *
 * The same reading `layoutOriginal` takes: aligned rows sit on their file-wide
 * slot, compact rows pack the sequences the block actually holds, and a block
 * compacted on its own in an otherwise aligned view packs from its first slot
 * rather than from the top. Returns null for a sequence the block does not hold.
 */
export function blockRowLines(rowIds,ids,{compact=false,wholeView=true}={}) {
  const rank=new Map(ids.map((id,i)=>[id,i]))
  const present=rowIds.filter(id=>rank.has(id))
  if(!compact)return new Map(present.map(id=>[id,rank.get(id)]))
  const ordered=[...present].sort((a,b)=>rank.get(a)-rank.get(b))
  const top=wholeView||!ordered.length?0:rank.get(ordered[0])
  return new Map(ordered.map((id,i)=>[id,top+i]))
}
export function rowLineInBlock(rowIds,ids,rowId,options){return blockRowLines(rowIds,ids,options).get(rowId)??null}

/** Where to put the camera so a sequence sits in the middle of the window.
 *
 * As far as the block's own rows allow: a block that fits on screen is never
 * scrolled half off the top to centre one of its rows, which reads as a broken
 * jump rather than a considered one. Deep blocks, where the row really could be
 * anywhere, get the middle of the window.
 */
export function centreOnRow(line,lastLine,height) {
  const wanted=MARGIN_Y+line*ROW_HEIGHT+ROW_HEIGHT/2-height/2
  const lowest=MARGIN_Y+(lastLine+1)*ROW_HEIGHT-height
  return Math.max(0,Math.min(wanted,Math.max(0,lowest)))
}

export function hitCanvasItem(hit,point) {
  if(hit.points){
    for(let i=1;i<hit.points.length;i++){
      const a=hit.points[i-1],b=hit.points[i],dx=b.x-a.x,dy=b.y-a.y
      const t=Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/(dx*dx+dy*dy||1)))
      if(Math.hypot(point.x-a.x-t*dx,point.y-a.y-t*dy)<=5)return true
    }
    return false
  }
  return point.x>=hit.x&&point.x<hit.x+hit.width&&point.y>=hit.y&&point.y<hit.y+hit.height
}

/** Choose a small, labelled overview when individual block controls cannot fit.
 *
 * `plane` converts the width a block is drawn at into the width it is seen at:
 * under plane zoom a block can be hundreds of plane units wide and still far too
 * small on screen to carry a ruler and three buttons. */
export function denseOriginal(layer,camera,size,plane=1) {
  if(layer.id!=='original')return false
  const visible=layer.fragments.filter(f=>f.x<camera.x+size.width/camera.scale&&f.x+f.end-f.start>camera.x)
  return visible.length>12||visible.length>2&&visible.filter(f=>(f.end-f.start)*camera.scale*plane<90).length>visible.length/2
}
export const originalHeight=layer=>Math.max(1,...layer.fragments.map(rowCount))

/** The topmost hit region at a point, as the reader could actually reach it.
 *
 * Original paints its name gutter *over* the blocks, so every hit region behind
 * that gutter - block headers, connectors, jump markers - is a target nobody
 * can see. A press there used to find whichever of them lay underneath: above
 * the first name, that was the header of a block whose drawn header is far off
 * to the right, and the press was taken as a click on it. Under the gutter only
 * the gutter's own names answer.
 *
 * Last-published wins, which is what the reverse walk is for: the painter draws
 * in order, so the region pushed last is the one on top.
 */
export function hitAtPoint(hits, point, { original = false, marginX = MARGIN_X, filter = null } = {}) {
  const buried = original && point.x < marginX
  for (let i = (hits?.length || 0) - 1; i >= 0; i--) {
    const hit = hits[i]
    if (buried && hit.kind !== 'label') continue
    if (filter && !filter(hit)) continue
    if (hitCanvasItem(hit, point)) return hit
  }
  return null
}
