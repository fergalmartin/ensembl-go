import { useEffect, useMemo, useRef, useState } from 'react'
import { api, visibleRequest, requestKey } from './data'
import { layerConnections, offWindowLinks } from './layers'
import { TileScheduler } from './tileScheduler'
import { datasetTiles } from './tileService'
import { planTiles, resolutionLevel } from './tilePlan'
import { planConservationTiles } from './conservationPlan'
import { conservationScale, DEFAULT_SCALE } from './conservation'
import { planeOf } from './layers'
import { recordPerformance } from './performance'

/** Independent, persistent tile requests. A slow block never prevents another
 * block rendering and camera movement never waits for the data pipeline. */
export default function useLayerData(dataset,layer,camera,size,showAnnotations,revision,onError,preview=false,cohort=null) {
  const [tick,repaint]=useState(0),error=useRef(onError),owner=useRef(Symbol('alignment')),level=useRef(null),motion=useRef(null)
  error.current=onError
  const service=useMemo(()=>datasetTiles(dataset?.id||'empty'),[dataset?.id])
  const cache=service.fine,coarseCache=service.coarse
  useEffect(()=>{
    service.users++
    let frame=null
    const changed=()=>{if(frame==null)frame=requestAnimationFrame(()=>{frame=null;repaint(n=>n+1)})}
    const off=cache.subscribe(changed),offCoarse=coarseCache.subscribe(changed),consumer=owner.current
    return()=>{off();offCoarse();if(frame!=null)cancelAnimationFrame(frame);cache.release(consumer);coarseCache.release(consumer);service.users--}
  },[service,cache,coarseCache])
  useEffect(()=>{cache.retryFailed();coarseCache.retryFailed()},[cache,coarseCache,revision])
  level.current=resolutionLevel(camera.scale*planeOf(camera),level.current)
  const previous=motion.current,now=performance.now()
  const dx=previous?camera.x-previous.x:0
  const lookahead=previous&&now-previous.time<Math.min(600,Math.max(200,cache.latency))&&Math.abs(dx)<size.width/camera.scale*2?(Math.sign(dx)||previous.direction||0):0
  if(!previous||previous.x!==camera.x)motion.current={x:camera.x,time:now,direction:Math.sign(dx)}
  const requests=useMemo(()=>layer?.fragments.map(f=>({id:f.id,request:visibleRequest(f,camera,size),x:f.x})).filter(x=>x.request)||[],[layer,camera,size])
  const signature=useMemo(()=>JSON.stringify(requests),[requests])
  const selectedLevel=level.current
  const plans=useMemo(()=>(layer?.fragments||[]).flatMap(f=>planTiles(f,camera,size,selectedLevel,lookahead)),[layer,camera,size,selectedLevel,lookahead])
  const planSignature=useMemo(()=>JSON.stringify(plans),[plans])
  useEffect(()=>{
    const tasks=dataset?JSON.parse(planSignature).map(({request,priority,coarse})=>({key:dataset.id+requestKey(request),priority:priority+(preview?10:0),coarse,label:`Block ${request.block}`,run:async signal=>service.ingest({data:await api(`/datasets/${dataset.id}/region`,request,signal),request})})):[]
    cache.setWanted(tasks.filter(t=>!t.coarse),owner.current)
    coarseCache.setWanted(tasks.filter(t=>t.coarse),owner.current)
  },[service,cache,coarseCache,dataset,planSignature,preview])
  const tiles={},annotations={},warnings=[];let pending=false
  const byBlock=useMemo(()=>{
    const result=new Map()
    for(const item of [...cache.values(),...coarseCache.values()]){const key=`${item.request.block}:${item.request.focus}`;if(!result.has(key))result.set(key,[]);result.get(key).push(item.data)}
    return result
  },[cache,coarseCache,tick]) // eslint-disable-line react-hooks/exhaustive-deps
  for(const {id,request} of requests){
    const sources=(byBlock.get(`${request.block}:${request.focus}`)||[]).filter(data=>data.end>request.start&&data.start<request.end)
    if(sources.length)tiles[id]={data:sources.find(data=>data.detail)||sources[0],sources}
  }
  for(const {request,priority,coarse} of plans){
    if(priority>1)continue
    const target=coarse?coarseCache:cache,key=dataset?.id+requestKey(request)
    if(!target.get(key)&&!target.failed.has(key)&&(target.running.has(key)||target.queue.some(t=>t.key===key)))pending=true
    if(target.failed.has(key)){
      for(const {id,request:visible} of requests)if(visible.block===request.block)tiles[id]={...tiles[id],error:target.failed.get(key).message}
    }
  }
  const failure=Object.values(tiles).find(tile=>tile.error)?.error
  useEffect(()=>{if(failure&&!preview)error.current(failure)},[failure,preview])
  recordPerformance('coverage',{fragments:requests.length,represented:Object.keys(tiles).length,pending})
  // Annotation and distance reads have separate budgets, so they cannot occupy
  // the sequence-tile workers or hold up the alignment itself.
  const extras=useRef(null)
  if(!extras.current)extras.current=new TileScheduler({concurrency:2,maxEntries:64,onChange:()=>repaint(n=>n+1),onError:message=>error.current(message)})
  const extraCache=extras.current
  useEffect(()=>{extraCache.clear();return()=>extraCache.clear()},[extraCache,dataset?.id,revision])
  // A third budget, beside annotations and distances. Cohort statistics must
  // never queue ahead of the sequence tiles the alignment itself is made of.
  const cohortRef=useRef(null)
  if(!cohortRef.current)cohortRef.current=new TileScheduler({concurrency:2,maxEntries:256,onChange:()=>repaint(n=>n+1),onError:message=>error.current(message)})
  const cohortCache=cohortRef.current
  useEffect(()=>{cohortCache.clear();return()=>cohortCache.clear()},[cohortCache,dataset?.id,revision])
  const cohortPlans=useMemo(()=>cohort?(layer?.fragments||[]).flatMap(f=>planConservationTiles(f,camera,size,selectedLevel,cohort)):[],[layer,camera,size,selectedLevel,cohort])
  const conservation={cohort:cohort?.ids.length||0,sources:{},scale:DEFAULT_SCALE}
  const cohortTasks=[]
  for(const {request,cohortKey,priority} of cohortPlans){
    const key=`conservation:${dataset?.id}:${request.block}:${request.start}:${request.end}:${request.bins}:${cohortKey}`
    const value=cohortCache.get(key)
    if(value)for(const f of layer.fragments)if(f.sourceBlock===request.block)(conservation.sources[f.id]??=[]).push(value)
    cohortTasks.push({key,priority,run:signal=>api(`/datasets/${dataset.id}/conservation`,request,signal)})
  }
  // Fitted once per tile set, never per paint. Over every loaded tile rather
  // than the viewport alone, so panning within a block does not restate the
  // scale and repaint what was already read.
  const cohortTiles=Object.values(conservation.sources).flat()
  conservation.scale=useMemo(()=>cohort?conservationScale(cohortTiles):DEFAULT_SCALE,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cohort,cohortTiles.length,cohortTiles[0]])
  const cohortSignature=JSON.stringify(cohortTasks.map(t=>t.key))
  useEffect(()=>{cohortCache.setWanted(dataset&&cohort?cohortTasks:[])},[cohortCache,dataset?.id,cohortSignature]) // eslint-disable-line react-hooks/exhaustive-deps
  const connections=useMemo(()=>layer?layerConnections({...layer,fragments:layer.fragments.filter(f=>!f.aggregate)}):[],[layer])
  const extraTasks=[]
  // Where the loaded window ends, the path does not. Ask only for the nearest
  // occurrence off each end, so this stays two indexed lookups whatever the
  // dataset's size, and re-ask only when the window itself moves.
  // Only Original. A working layer holds the chunks someone chose, so the blocks
  // beyond its edges are not part of it and pointing at them says nothing about
  // the layer; the markers only crowded the chunk labels sharing that space.
  // Nor for a packed sheet: the blocks beyond its edges are the ones just
  // hidden, and pointing the reader back at them is no help at all.
  const solid=layer?.id==='original'&&!layer.packed?layer.fragments.filter(f=>!f.aggregate):[]
  const loaded=solid.length?{lo:Math.min(...solid.map(f=>f.sourceBlock)),hi:Math.max(...solid.map(f=>f.sourceBlock)),
    ids:[...new Set(solid.flatMap(f=>f.rowIds))].sort()}:null
  let neighbours=null
  if(dataset&&loaded&&loaded.ids.length&&loaded.ids.length<=500){
    const key=`neighbours:${dataset.id}:${loaded.lo}:${loaded.hi}:${JSON.stringify(loaded.ids)}:${revision}`
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
  return useMemo(()=>({tiles,annotations,connections,offWindow,counts,pending,warnings,conservation,gaps:service.gaps,displayCamera:camera}),[tick,signature,extraSignature,cohortSignature,camera,layer,showAnnotations,dataset?.id,revision])
}
