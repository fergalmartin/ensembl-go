import { rowSlot, clamp, planeOf } from './layers.js'
import { displaySpan, sourceColumn } from './collapse.js'
import { MARGIN_X, MARGIN_Y, ROW_HEIGHT } from './layout.js'

/** The regional reads a fragment needs right now.
 *
 * A binned cell says how far a row has drifted from a comparison row, so which
 * row that is belongs in the request rather than being assumed to be the first
 * one in the block. `focusOf` answers it per row: block context reads every
 * target against a chosen reference, or each row against the one above it, and
 * those are different questions with different answers. Rows sharing a
 * comparator share a request; without `focusOf` there is exactly one, against
 * the block's first row, which is what every other view asks for. */
export function visibleRequests(fragment,camera,size,focusOf=null) {
  if(fragment.aggregate)return []
  const x=MARGIN_X+(fragment.x-camera.x)*camera.scale
  const y=MARGIN_Y+fragment.y*ROW_HEIGHT-(fragment.pinned?0:camera.y)
  const width=displaySpan(fragment)*camera.scale
  if(x>size.width+300||x+width<-300)return []
  const ids=fragment.rowIds.filter((_,i)=>{
    const pos=y+rowSlot(fragment,i)*ROW_HEIGHT
    return pos>=-ROW_HEIGHT*2&&pos<size.height+ROW_HEIGHT*2
  })
  if(!ids.length)return []
  // Geometry is in plane units; resolution is not. What a bin has to be worth
  // asking for is set by the pixels it actually lands on, which under plane zoom
  // is the scale times the plane factor.
  const onScreen=camera.scale*planeOf(camera)
  const step=Math.max(1,2**Math.ceil(Math.log2(4/Math.max(0.000001,onScreen))))
  const quantum=Math.max(256,step*128)
  // Through the collapse map, for the same reason the tile plan goes through
  // it: a drawn offset is not a column once anything between them is gone.
  const visibleStart=sourceColumn(fragment,Math.max(0,(0-x)/camera.scale))
  const visibleEnd=sourceColumn(fragment,Math.max(0,(size.width-x)/camera.scale))
  // Padded on both sides. With padding only after the view, panning back the way
  // you came immediately exposes columns the request never asked for, and they
  // stay blank until a whole new tile lands.
  const start=Math.max(fragment.start,Math.floor(visibleStart/quantum)*quantum-quantum)
  const end=Math.min(fragment.end,Math.ceil(visibleEnd/quantum)*quantum+quantum)
  if(end<=start)return []
  const bins=clamp(Math.ceil((end-start)/step),16,2048),summary=onScreen<0.65
  const groups=new Map()
  for(const id of ids){
    const focus=(focusOf?focusOf(id):fragment.rowIds[0])??fragment.rowIds[0]
    if(!groups.has(focus))groups.set(focus,[])
    groups.get(focus).push(id)
  }
  return [...groups].map(([focus,members])=>
    ({block:fragment.sourceBlock,start,end,ids:[...new Set([focus,...members])],bins,focus,summary}))
}
/** The single request every view but block context makes. */
export const visibleRequest = (fragment,camera,size) => visibleRequests(fragment,camera,size)[0]||null
