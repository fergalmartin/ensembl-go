import { rowCount } from './layers.js'

/** Stable rows use sequence identity, never active-genome identity. Per-block
 * compaction preserves the first shared row as its vertical anchor. */
export function layoutOriginal(fragments,ids,mode='aligned',overrides={}) {
  const rank=new Map(ids.map((id,i)=>[id,i]))
  return fragments.map(f=>{
    if(f.aggregate)return {...f,layoutRows:ids.length,slots:f.rowIds.map(id=>rank.get(id)??0)}
    const compact=(overrides[f.sourceBlock]||mode)==='compact'
    const ordered=f.rowIds.filter(id=>!compact||!f.availableRows||f.availableRows.includes(id)).sort((a,b)=>(rank.get(a)??0)-(rank.get(b)??0))
    const slots=ordered.map(id=>rank.get(id)??0)
    const y=compact?(mode==='compact'?0:slots.length?Math.min(...slots):0):0
    return {...f,rowIds:ordered,y,slots:compact?null:slots,layoutRows:compact?ordered.length:ids.length,compact}
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

/** Choose a small, labelled overview when individual block controls cannot fit. */
export function denseOriginal(layer,camera,size) {
  if(layer.id!=='original')return false
  const visible=layer.fragments.filter(f=>f.x<camera.x+size.width/camera.scale&&f.x+f.end-f.start>camera.x)
  return visible.length>12||visible.length>2&&visible.filter(f=>(f.end-f.start)*camera.scale<90).length>visible.length/2
}
export const originalHeight=layer=>Math.max(1,...layer.fragments.map(rowCount))
