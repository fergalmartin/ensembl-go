import { useEffect, useMemo, useRef, useState } from 'react'
import { api, visibleRequest, requestKey } from './data'
import { layerConnections, offWindowLinks } from './layers'
import { TileScheduler } from './tileScheduler'
import { createGapMemory, rememberGaps } from './gapMemory'

/** Independent, persistent tile requests. A slow block never prevents another
 * block rendering and camera movement never waits for the data pipeline. */
export default function useLayerData(dataset,layer,camera,size,showAnnotations,revision,onError) {
  const [tick,repaint]=useState(0),error=useRef(onError),scheduler=useRef(null)
  error.current=onError
  if(!scheduler.current)scheduler.current=new TileScheduler({onChange:()=>repaint(n=>n+1),onError:message=>error.current(message)})
  const cache=scheduler.current
  useEffect(()=>{cache.clear();return()=>cache.clear()},[cache,dataset?.id,revision])
  const requests=layer?.fragments.map(f=>({id:f.id,request:visibleRequest(f,camera,size),x:f.x})).filter(x=>x.request)||[]
  const signature=JSON.stringify(requests)
  useEffect(()=>{
    if(!dataset){cache.setWanted([]);return}
    const tasks=[]
    for(const {id,request,x} of JSON.parse(signature)){
      const key=dataset.id+requestKey(request)+revision
      tasks.push({key,label:`Block ${request.block}`,priority:Math.max(0,x-camera.x-size.width/camera.scale,camera.x-x-(layer.fragments.find(f=>f.id===id)?.end||request.end)+(layer.fragments.find(f=>f.id===id)?.start||0)),run:async signal=>({data:await api(`/datasets/${dataset.id}/region`,request,signal),request})})
      // A bounded coarse fallback for this block is warmed independently of exact
      // rows. It covers a wider region so edges do not disappear during zoom-out.
      // At every zoom, not only close in. A wide coarse tile is what covers the
      // ground a pan opens up before its own tile arrives; without one, zoomed
      // out, whatever the pan exposed simply stayed blank.
      {
        const length=layer.fragments.find(f=>f.sourceBlock===request.block)?.end||request.end
        const width=Math.max(4096,request.end-request.start),start=Math.max(0,request.start-width*2),end=Math.min(length,request.end+width*2)
        const coarse={...request,start,end,summary:true,bins:128}
        tasks.push({key:dataset.id+requestKey(coarse)+revision,priority:1e15+Math.abs(x-camera.x),run:async signal=>({data:await api(`/datasets/${dataset.id}/region`,coarse,signal),request:coarse})})
      }
    }
    cache.setWanted(tasks)
    // Geometry changes within a quantized tile don't cancel running requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[cache,dataset?.id,signature,revision])
  // Gaps are remembered across resolutions so one resolved at any zoom is never
  // filled back in by a coarser tile driving a later repaint.
  const gaps=useRef(null)
  if(!gaps.current)gaps.current=createGapMemory()
  useEffect(()=>{gaps.current=createGapMemory()},[dataset?.id,revision])
  const tiles={},annotations={},warnings=[];let pending=false
  const values=cache.values()
  for(const {id,request} of requests){
    const key=dataset?.id+requestKey(request)+revision
    const exact=cache.get(key)
    const matching=values.filter(item=>item.request?.block===request.block&&item.request.focus===request.focus&&item.data.end>request.start&&item.data.start<request.end)
    const overview=matching.filter(item=>!item.data.detail).sort((a,b)=>(b.data.end-b.data.start)-(a.data.end-a.data.start))[0]
    const fallback=matching.filter(item=>item.data.detail).sort((a,b)=>(b.data.end-b.data.start)-(a.data.end-a.data.start))[0]
    const item=exact||(request.summary?overview||fallback:fallback||overview)
    if(item)tiles[id]={data:item.data,overview:overview?.data}
    for(const seen of matching)rememberGaps(gaps.current,seen.request.block,seen.data)
    if(cache.failed.has(key))tiles[id]={...tiles[id],error:cache.failed.get(key).message}
    if(!exact&&!cache.failed.has(key))pending=true
  }
  // Annotation and distance reads have separate budgets, so they cannot occupy
  // the sequence-tile workers or hold up the alignment itself.
  const extras=useRef(null)
  if(!extras.current)extras.current=new TileScheduler({concurrency:2,maxEntries:64,onChange:()=>repaint(n=>n+1),onError:message=>error.current(message)})
  const extraCache=extras.current
  useEffect(()=>{extraCache.clear();return()=>extraCache.clear()},[extraCache,dataset?.id,revision])
  const connections=useMemo(()=>layer?layerConnections({...layer,fragments:layer.fragments.filter(f=>!f.aggregate)}):[],[layer])
  const extraTasks=[]
  // Where the loaded window ends, the path does not. Ask only for the nearest
  // occurrence off each end, so this stays two indexed lookups whatever the
  // dataset's size, and re-ask only when the window itself moves.
  // Only Original. A working layer holds the chunks someone chose, so the blocks
  // beyond its edges are not part of it and pointing at them says nothing about
  // the layer; the markers only crowded the chunk labels sharing that space.
  const solid=layer?.id==='original'?layer.fragments.filter(f=>!f.aggregate):[]
  const loaded=solid.length?{lo:Math.min(...solid.map(f=>f.sourceBlock)),hi:Math.max(...solid.map(f=>f.sourceBlock)),
    ids:[...new Set(solid.flatMap(f=>f.rowIds))].sort()}:null
  let neighbours=null
  if(dataset&&loaded&&loaded.ids.length&&loaded.ids.length<=500){
    const key=`neighbours:${dataset.id}:${loaded.lo}:${loaded.hi}:${loaded.ids.length}:${revision}`
    neighbours=extraCache.get(key)||null
    extraTasks.push({key,run:signal=>api(`/datasets/${dataset.id}/neighbours`,{ids:loaded.ids,lo:loaded.lo,hi:loaded.hi},signal)})
  }
  const offWindow=useMemo(()=>layer&&neighbours?offWindowLinks({...layer,fragments:solid},neighbours):[],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layer,neighbours])
  for(const {id,request} of requests){
    if(!showAnnotations||request.summary||!tiles[id]?.data.detail)continue
    const key=`annotations:${dataset?.id}:${requestKey(request)}:${revision}`,value=extraCache.get(key)
    if(value){annotations[id]=value.rows;warnings.push(...value.warnings)}
    extraTasks.push({key,run:signal=>api(`/datasets/${dataset.id}/annotations`,request,signal)})
  }
  const counts={}
  for(let i=0;i<connections.length;i+=100){
    const pairs=connections.slice(i,i+100).filter(c=>c.columns!==null).map(c=>({id:c.id,rowId:c.rowId,from:{sourceBlock:c.from.sourceBlock,start:c.from.start,end:c.fromEnd},to:{sourceBlock:c.to.sourceBlock,start:c.toStart,end:c.to.end}}))
    if(!pairs.length)continue
    const key=`counts:${dataset?.id}:${JSON.stringify(pairs)}`
    for(const c of extraCache.get(key)?.connections||[])counts[c.id]=c
    extraTasks.push({key,run:signal=>api(`/datasets/${dataset.id}/connections`,{pairs},signal)})
  }
  const extraSignature=JSON.stringify(extraTasks.map(t=>t.key))
  useEffect(()=>{extraCache.setWanted(dataset?extraTasks:[])},[extraCache,dataset?.id,extraSignature]) // eslint-disable-line react-hooks/exhaustive-deps
  // Hover-only parent updates do not invalidate the canvas texture.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(()=>({tiles,annotations,connections,offWindow,counts,pending,warnings,gaps:gaps.current,displayCamera:camera}),[tick,signature,extraSignature,camera,layer,showAnnotations,dataset?.id,revision])
}
