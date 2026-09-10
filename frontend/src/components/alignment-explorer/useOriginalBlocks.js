import { useEffect, useMemo, useRef, useState } from 'react'
import { api, MARGIN_X } from './data'
import { createFragment, mergeWidth, BLOCK_DETAIL_COUNT } from './layers'
import { TileScheduler } from './tileScheduler'

/** Stable source coordinates with indexed viewport lookup. No sequential walk
 * from block 1, changing layout origin, or finite neighbour-window boundary. */
export default function useOriginalBlocks(dataset,source,camera,size,_total,enabled,onError,revision=0) {
  const [tick,repaint]=useState(0),error=useRef(onError),scheduler=useRef(null)
  error.current=onError
  if(!scheduler.current)scheduler.current=new TileScheduler({concurrency:2,maxEntries:24,onChange:()=>repaint(n=>n+1),onError:message=>error.current(message)})
  const cache=scheduler.current
  useEffect(()=>{cache.clear();return()=>cache.clear()},[cache,dataset?.id,revision])
  const extent=dataset?.layout_end||source?.layout_end||source?.length||1
  const span=Math.max(1,size.width/camera.scale),quantum=2**Math.ceil(Math.log2(span))
  const start=Math.max(0,Math.floor((camera.x-MARGIN_X/camera.scale-span*.5)/quantum)*quantum)
  const end=Math.min(extent,Math.max(start+1,Math.ceil((camera.x+span*1.5)/quantum)*quantum))
  const merge=mergeWidth(span)
  const key=`${dataset?.id}:${start}:${end}:${merge}`
  useEffect(()=>{
    if(!dataset||!enabled||end<=start){cache.setWanted([]);return}
    cache.setWanted([{key,label:'Source block layout',run:signal=>api(`/datasets/${dataset.id}/layout?start=${start}&end=${end}&limit=96&merge=${merge}&detail=${BLOCK_DETAIL_COUNT}`,undefined,signal)}])
  },[cache,dataset,key,start,end,merge,enabled,revision])
  const exact=cache.get(key)
  const fragments=useMemo(()=>{
    // Cached overlapping regions continue to render immediately during a pan.
    const records=new Map()
    const candidates=cache.values().filter(result=>result.blocks.some(b=>b.end_x>=start&&b.x<=end))
    const best=candidates.sort((a,b)=>{
      const score=result=>Math.abs(Math.log(Math.max(1,result.blocks.at(-1).end_x-result.blocks[0].x)/Math.max(1,end-start)))
      return score(a)-score(b)
    })[0]
    // Never overlay layouts from different overview levels during a transition.
    for(const result of exact?[exact]:best?[best]:[])for(const b of result.blocks){
      if(b.end_x<start||b.x>end)continue
      const id=b.aggregate?`aggregate:${b.block}:${b.last_block}`:`original:${b.block}`
      records.set(id,createFragment(b.block,0,b.end_x-b.x,b.row_ids,{id,x:b.x,aggregate:b.aggregate?{first:b.block,last:b.last_block,count:b.count,presence:b.presence,edges:b.edges||[]}:null,sourceRowCount:b.row_count,availableRows:b.available_row_ids}))
    }
    // The directly jumped-to block is already available without a layout round trip.
    if(source&&!exact&&!best){const id=`original:${source.block}`;records.set(id,createFragment(source.block,0,source.length,source.rows.map(r=>r.id),{id,x:source.layout_start||0,availableRows:source.rows.filter(r=>!r.empty_status).map(r=>r.id)}))}
    return [...records.values()].sort((a,b)=>a.x-b.x)
    // Cache notifications rerender and recompute this small bounded descriptor list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[exact,tick,source,start,end])
  return fragments
}
