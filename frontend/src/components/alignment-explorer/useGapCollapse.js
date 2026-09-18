import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './data'
import { TileScheduler } from './tileScheduler'
import { clipRuns, packCollapsed } from './collapse.js'
import { collapseKey, collapseRequests, collapseTaskKey } from './collapsePlan.js'

/** Fragments with their uninformative columns marked, and nothing else changed.
 *
 * Collapsing is derived, never stored. What is uninformative is a fact about
 * the cohort on screen and not about the alignment, so it is recomputed from
 * whatever is being drawn: showing a sequence again changes the cohort, which
 * changes the key, which fetches a different answer and puts the columns that
 * sequence fills back. Nothing has to notice the reversal and undo it, because
 * nothing ever recorded it.
 *
 * Until an answer arrives a fragment is drawn whole. A collapse that guessed
 * from the last cohort's answer would hide columns the reader has just asked to
 * see, which is the one mistake this must not make.
 */
export default function useGapCollapse(dataset,layer,enabled,minRun,percent,onError,pack=false) {
  const [tick,repaint]=useState(0)
  const error=useRef(onError);error.current=onError
  const scheduler=useRef(null)
  if(!scheduler.current)scheduler.current=new TileScheduler({concurrency:2,maxEntries:256,
    onChange:()=>repaint(n=>n+1),onError:message=>error.current?.(message)})
  const cache=scheduler.current
  useEffect(()=>()=>cache.clear(),[cache])
  useEffect(()=>{cache.clear()},[cache,dataset?.id])
  const fragments=layer?.fragments
  // Panels that could carry an answer at all, which is not the same as panels.
  // Zoomed out, every panel on Original stands for a run of blocks rather than
  // for columns, so there is nothing to ask about - and reading that silence as
  // "no request was made" made the control say the sheet was too large to check
  // when the sheet was merely too small to draw. Two different things to say,
  // and only one of them has a way out the reader can act on.
  const askable=useMemo(()=>(fragments||[]).filter(f=>!f.aggregate&&f.rowIds?.length).length,[fragments])
  const requests=useMemo(()=>enabled&&dataset?collapseRequests(fragments,minRun,percent):new Map(),[enabled,dataset,fragments,minRun,percent])
  // The threshold belongs in the key. It changes the answer, so two thresholds
  // are two different questions about the same cohort, and sharing a key let
  // one be served the other's answer. Clearing the cache instead was worse than
  // wrong: clearing also drops what the scheduler has been asked for, and the
  // effect that asks is keyed on this signature, so a threshold change wiped
  // every answer and then re-requested none of them - which is exactly what
  // left this saying "0 of 4 blocks checked" for ever.
  const keyOf=useCallback(key=>collapseTaskKey(dataset?.id,minRun,percent,key),[dataset?.id,minRun,percent])
  const tasks=useMemo(()=>[...requests].map(([key,request])=>({key:keyOf(key),
    label:`Block ${request.block}`,
    run:signal=>api(`/datasets/${dataset.id}/gap-columns`,request,signal)})),[requests,keyOf,dataset])
  const signature=useMemo(()=>tasks.map(t=>t.key).join('|'),[tasks])
  useEffect(()=>{
    cache.setWanted(tasks)
  },[cache,signature]) // eslint-disable-line react-hooks/exhaustive-deps
  const result=useMemo(()=>{
    if(!enabled||!layer||!requests.size)return {layer,columns:0,truncated:false,done:0,failed:0,total:0,
      unavailable:!!(enabled&&layer?.fragments.length&&!askable),
      skipped:!!(enabled&&askable&&!requests.size)}
    let columns=0,truncated=false,changed=false
    // Counted rather than inferred from "some fragment has no answer yet". A
    // request that has failed for good is never going to have one, and reading
    // its absence as work still in progress is what left this saying it was
    // checking columns for ever.
    let done=0,failed=0
    for(const key of requests.keys()){
      if(cache.get(keyOf(key))!==undefined)done++
      else if(cache.failed.has(keyOf(key)))failed++
    }
    const next=layer.fragments.map(f=>{
      if(f.aggregate||!f.rowIds?.length)return f
      if(!requests.has(collapseKey(f)))return f
      const value=cache.get(keyOf(collapseKey(f)))
      if(!value)return f
      if(value.truncated)truncated=true
      const collapsed=clipRuns(value.runs,f.start,f.end)
      if(!collapsed.length)return f
      // A panel with nothing left is not collapsed at all: a cohort that is gap
      // from end to end of a block says the block holds nothing for this reader,
      // which is a matter for Hide, not for a zero-width panel.
      if(collapsed.reduce((n,[a,z])=>n+z-a,0)>=f.end-f.start)return f
      changed=true;columns+=collapsed.reduce((n,[a,z])=>n+z-a,0)
      return {...f,collapsed}
    })
    // Packing is Original's answer and not a layer's, so it is asked for rather
    // than assumed here.
    const packed=changed&&pack?packCollapsed(next):next
    return {layer:changed?{...layer,fragments:packed}:layer,columns,truncated,done,failed,
      total:requests.size,skipped:false,unavailable:false}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[layer,enabled,requests,tick,keyOf,pack,askable])
  const pending=result.total>result.done+result.failed
  // Work worth showing a bar for, told apart from work that is over before a
  // reader could read a word about it. Most cohorts answer in well under a
  // second and a bar that flashed up for every one of them would be noise; the
  // ones that do not are the large blocks this exists for.
  const [slow,setSlow]=useState(false)
  useEffect(()=>{
    if(!pending){setSlow(false);return}
    const timer=setTimeout(()=>setSlow(true),1200)
    return()=>clearTimeout(timer)
  },[pending,signature])
  // An answer that is wanted, absent, and that nothing is on its way to fetch.
  // The scheduler is a bounded cache, so an entry can be evicted after the
  // effect above has already asked for it, and that effect only runs again when
  // the set of keys changes. Without this the sheet would wait on a request
  // nobody was going to make.
  useEffect(()=>{
    if(!pending||cache.running.size||cache.queue.length)return
    cache.setWanted(tasks)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[pending,tick,cache,signature])
  // A failed answer is a fact the reader can act on, not a state to sit in. The
  // scheduler gives up after its retries - a cancelled read is not even
  // retryable - and without a way back the sheet would keep those blocks whole
  // with nothing said about why.
  const retry=useCallback(()=>cache.retryFailed(),[cache])
  // Stopping means stopping: the requests in flight are aborted and the ones
  // queued are dropped. The caller switches the collapse off as well, which is
  // what keeps it stopped - left on, the next render would ask the same
  // questions again and the reader would have cancelled nothing.
  const cancel=useCallback(()=>cache.clear(),[cache])
  return useMemo(()=>({...result,pending,slow:slow&&pending,retry,cancel}),[result,pending,slow,retry,cancel])
}
