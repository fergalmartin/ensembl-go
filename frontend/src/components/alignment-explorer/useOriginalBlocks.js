import { useEffect, useMemo, useRef, useState } from 'react'
import { api, MARGIN_X } from './data'
import { createFragment, mergeWidth, planeOf, BLOCK_DETAIL_COUNT } from './layers'
import { TileScheduler } from './tileScheduler'
import { layoutCoverage } from './layoutCoverage'

/** Fixed layout windows and incremental individual pages keep descriptor loading
 * ahead of the sequence pipeline, with compatible cached pages unioned. */
export default function useOriginalBlocks(dataset,source,camera,size,_total,enabled,onError,revision=0,panel=false) {
  const [tick,repaint]=useState(0),error=useRef(onError)
  error.current=onError
  const cache=useMemo(()=>new TileScheduler({concurrency:2,maxEntries:128,maxBytes:16*1024*1024,onChange:()=>repaint(n=>n+1),onError:message=>error.current(message)}),[dataset?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(()=>()=>cache.clear(),[cache])
  useEffect(()=>cache.retryFailed(),[cache,revision])
  const extent=dataset?.layout_end||source?.layout_end||source?.length||1
  const span=Math.max(1,size.width/camera.scale),quantum=2**Math.ceil(Math.log2(Math.max(1024,span/2)))
  const start=Math.max(0,Math.floor((camera.x-MARGIN_X/camera.scale-span*.5)/quantum)*quantum)
  const end=Math.min(extent,Math.max(start+1,Math.ceil((camera.x+span*1.5)/quantum)*quantum))
  const merge=panel?0:mergeWidth(Math.max(1,size.width*planeOf(camera)/camera.scale))
  const mode=panel?'panel':`alignment:${merge}`
  const tasks=[]
  if(dataset&&enabled)for(let from=start;from<end;from+=quantum){
    const to=Math.min(extent,from+quantum)
    let after=0
    do {
      const page=after,key=`${dataset.id}:${mode}:${from}:${to}:${page}`
      tasks.push({key,priority:from+quantum<camera.x||from>camera.x+span?2:0,run:async signal=>{
        const result=await api(`/datasets/${dataset.id}/layout?start=${from}&end=${to}&limit=256&merge=${merge}&detail=${BLOCK_DETAIL_COUNT}&individual=${panel}&after=${page}`,undefined,signal)
        return {...result,start:from,end:to,mode}
      }})
      after=panel?cache.get(key)?.next:0
    }while(after)
  }
  const signature=JSON.stringify(tasks.map(t=>[t.key,t.priority]))
  useEffect(()=>cache.setWanted(tasks),[cache,signature]) // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(()=>{
    const blocks=layoutCoverage(cache.values(),start,end,mode)
    const fragments=blocks.map(b=>createFragment(b.block,0,b.end_x-b.x,b.row_ids,{id:b.aggregate?`aggregate:${b.block}:${b.last_block}`:`original:${b.block}`,x:b.x,aggregate:b.aggregate?{first:b.block,last:b.last_block,count:b.count,presence:b.presence,edges:b.edges||[]}:null,sourceRowCount:b.row_count,availableRows:b.available_row_ids}))
    if(source&&!fragments.length)fragments.push(createFragment(source.block,0,source.length,source.rows.map(r=>r.id),{id:`original:${source.block}`,x:source.layout_start||0,availableRows:source.rows.filter(r=>!r.empty_status).map(r=>r.id)}))
    return fragments
  },[cache,tick,source,start,end,mode])
}
