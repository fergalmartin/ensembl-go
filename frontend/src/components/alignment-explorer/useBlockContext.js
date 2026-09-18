import { useEffect, useMemo, useState } from 'react'
import { api } from './data'
import { TileScheduler } from './tileScheduler'
import { contextWindow, contextRows, contextPairs, requestBatches, CONTEXT_MAX_COLUMNS } from './detail.js'

/** Context has its own bounded request budget. Every visible row gets a batch;
 * the per-request row limit must never become a limit on the displayed rows. */
export default function useBlockContext(dataset,detail,layer,camera,size,revision,onError) {
  const [tick,repaint]=useState(0)
  const queue=useMemo(()=>new TileScheduler({concurrency:1,maxEntries:128,
    onChange:()=>repaint(n=>n+1),onError}),[onError])
  const generation=`${dataset?.id||''}:${detail?.sourceBlock??''}:${revision}`
  useEffect(()=>{queue.clear();return()=>queue.clear()},[queue,generation])

  const window_=detail?contextWindow(layer?.fragments?.[0],camera,size):null
  // Smaller padding and up to one bin per column at base zoom. Annotation's
  // 16k padding made bands look precisely placed when each bin covered 64 bases.
  const compareWindow=detail?contextWindow(layer?.fragments?.[0],camera,size,256):null
  const rows=contextRows(detail,layer,camera,size)
  const pairs=contextPairs(detail,layer,camera,size)
  const selected=detail?.feature||null
  const zoomRequired=!!window_&&window_.end-window_.start>CONTEXT_MAX_COLUMNS
  const requests=[]
  const add=(kind,body,priority)=>requests.push({kind,body,priority,key:`${kind}:${generation}:${JSON.stringify(body)}`})
  if(detail)add('block-context',{block:detail.sourceBlock},0)
  if(detail&&window_&&!zoomRequired){
    for(const ids of requestBatches(rows))add('block-features',{
      block:detail.sourceBlock,...window_,ids,expand:detail.expandedGenes||{},
    },1)
  }
  if(detail&&compareWindow&&compareWindow.end-compareWindow.start<=CONTEXT_MAX_COLUMNS){
    for(const batch of requestBatches(pairs))add('block-comparison',{
      block:detail.sourceBlock,...compareWindow,pairs:batch,bins:4096,
    },2)
    // Measurements use the selected feature's actual owner and extent, not
    // whichever reference or viewport happens to be active at the time.
    if(selected?.pieces?.length){
      const start=Math.min(...selected.pieces.map(p=>p.start)),end=Math.max(...selected.pieces.map(p=>p.end))
      if(end-start<=CONTEXT_MAX_COLUMNS)for(const batch of requestBatches(rows.filter(id=>id!==selected.rowId).map(id=>[selected.rowId,id])))add('measurement',{
        block:detail.sourceBlock,start,end,pairs:batch,bins:16,
        feature:{type:selected.type,pieces:selected.pieces},
      },3)
    }
  }
  const signature=JSON.stringify(requests)
  useEffect(()=>{
    queue.setWanted(JSON.parse(signature).map(({key,kind,body,priority})=>({key,priority,
      run:signal=>api(`/datasets/${dataset.id}/${kind==='measurement'?'block-comparison':kind}`,body,signal)})))
  },[queue,dataset?.id,signature])

  const values=kind=>requests.filter(r=>r.kind===kind).map(r=>queue.get(r.key)).filter(Boolean)
  const context=values('block-context')[0]||null
  const rowsById=useMemo(()=>new Map((context?.rows||[]).map(row=>[row.id,row])),[context])
  // Cache reads are refreshed by the scheduler's repaint subscription.
  void tick
  const features=values('block-features')
  const failures=requests.filter(r=>queue.failed.has(r.key))
  const pending=requests.some(r=>r.priority<2&&!queue.get(r.key)&&!queue.failed.has(r.key))
  return {
    context,rowsById,
    features:features.length?Object.assign({},...features.map(f=>f.rows)):null,
    window:features.length?window_:null,
    truncated:features.some(f=>f.truncated),zoomRequired,
    comparison:new Map(values('block-comparison').flatMap(value=>value.pairs.map(pair=>[pair.target,pair]))),
    measurements:new Map(values('measurement').flatMap(value=>value.pairs.map(pair=>[pair.target,pair]))),
    comparisonPending:requests.some(r=>r.kind==='block-comparison'&&!queue.get(r.key)&&!queue.failed.has(r.key)),
    warnings:[...features.flatMap(f=>f.warnings||[]),...failures.map(r=>({message:queue.failed.get(r.key).message}))],
    limits:context?.limits||null,pending,
  }
}
