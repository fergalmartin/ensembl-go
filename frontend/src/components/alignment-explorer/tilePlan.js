import { planeOf, rowSlot } from './layers.js'
import { MARGIN_X, MARGIN_Y, ROW_HEIGHT } from './layout.js'

export function resolutionLevel(scale,previous){
  const proposed=Math.max(0,Math.ceil(Math.log2(4/Math.max(1e-9,scale))))
  if(previous!=null&&Math.abs(proposed-previous)===1){
    const pixelWidth=2**previous*scale
    if(pixelWidth>=2.5&&pixelWidth<=5.5)return previous
  }
  return proposed
}
/** Stable tile and row-batch keys are independent of camera envelopes and row
 * order. The comparison row remains explicit, even if outside the batch. */
export function planTiles(fragment,camera,size,level,lookahead=0) {
  if(fragment.aggregate||!fragment.rowIds.length)return []
  const x=MARGIN_X+(fragment.x-camera.x)*camera.scale
  const width=(fragment.end-fragment.start)*camera.scale
  const padding=300/planeOf(camera)
  if(x>size.width+padding||x+width<-padding||width*planeOf(camera)<2)return []
  const top=MARGIN_Y+fragment.y*ROW_HEIGHT-camera.y
  const visible=fragment.rowIds.filter((_,i)=>{const y=top+rowSlot(fragment,i)*ROW_HEIGHT;return y>=-ROW_HEIGHT*3&&y<size.height+ROW_HEIGHT*3})
  const sorted=[...fragment.rowIds].sort(),groups=new Map()
  for(const id of visible){const batch=Math.floor(sorted.indexOf(id)/16);groups.set(batch,sorted.slice(batch*16,batch*16+16))}
  const from=Math.max(fragment.start,fragment.start-x/camera.scale)
  const to=Math.min(fragment.end,fragment.start+(size.width-x)/camera.scale)
  if(to<=from)return []
  const summary=camera.scale*planeOf(camera)<.65,step=2**level
  const span=summary?Math.max(1024,step*256):2048
  const focus=fragment.rowIds[0],tasks=[]
  for(const ids of groups.values()){
    const rows=[...new Set([focus,...ids])].sort()
    // Cover the visible interval first, then one neighbour each way. The
    // leading side may grow by one tile, bounded even after a large jump.
    const first=Math.max(0,Math.floor(from/span)-1),last=Math.floor((to-1)/span)+1
    for(let i=first-(lookahead<0?1:0);i<=last+(lookahead>0?1:0);i++){
      if(i<0||i*span>=fragment.end||(i+1)*span<=fragment.start)continue
      const start=i*span,end=(i+1)*span
      const onscreen=end>from&&start<to
      tasks.push({request:{block:fragment.sourceBlock,start,end,ids:rows,bins:256,focus,summary},priority:onscreen?1:3})
    }
    // A fixed parent at the next coarse level gives cheap fallback coverage.
    const parentSpan=Math.max(span*4,16384)
    for(let start=Math.floor(from/parentSpan)*parentSpan;start<to;start+=parentSpan){
      tasks.push({request:{block:fragment.sourceBlock,start,end:start+parentSpan,ids:rows,bins:256,focus,summary:true},priority:0,coarse:true})
    }
  }
  return tasks
}
