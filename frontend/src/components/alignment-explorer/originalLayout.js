import { rowCount } from './layers.js'

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
