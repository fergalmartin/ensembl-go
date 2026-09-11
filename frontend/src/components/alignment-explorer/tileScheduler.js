import { recordPerformance } from './performance.js'

/** Shared, bounded LRU request queue. Consumer leases keep previews from replacing
 * the main viewport's work. Navigation preserves useful in-flight requests. */
export class TileScheduler {
  constructor({concurrency=3,maxEntries=512,maxBytes=48*1024*1024,onChange=()=>{},onError=()=>{},retries=2}={}) {
    Object.assign(this,{concurrency,maxEntries,maxBytes,onChange,onError,retries})
    this.cache=new Map();this.running=new Map();this.queue=[];this.failed=new Map();this.generation=0;this.bytes=0;this.wanted=new Set()
    this.consumers=new Map();this.listeners=new Set();this.attempts=new Map();this.retryTimers=new Map();this.latency=150
  }
  get(key){const entry=this.cache.get(key);if(entry){this.cache.delete(key);this.cache.set(key,entry)}return entry?.value}
  values(){return [...this.cache.values()].map(x=>x.value)}
  subscribe(fn){this.listeners.add(fn);return()=>this.listeners.delete(fn)}
  publish(){this.onChange();for(const fn of this.listeners)fn()}
  setWanted(tasks,owner='default'){
    this.consumers.set(owner,tasks);this.refresh()
  }
  release(owner){this.consumers.delete(owner);this.refresh()}
  refresh(){
    const unique=new Map()
    for(const tasks of this.consumers.values())for(const task of tasks){
      if(!unique.has(task.key)||(task.priority||0)<(unique.get(task.key).priority||0))unique.set(task.key,task)
    }
    this.tasks=unique;this.wanted=new Set(unique.keys())
    if(unique.size)for(const [key,controller] of this.running){
      if(!unique.has(key)&&performance.now()-controller.started>200)controller.abort()
    }
    this.queue=[...unique.values()].filter(t=>!this.cache.has(t.key)&&!this.running.has(t.key)&&!this.failed.has(t.key)).sort((a,b)=>(a.priority||0)-(b.priority||0))
    this.pump()
  }
  evict(){
    while(this.cache.size>this.maxEntries||this.bytes>this.maxBytes&&this.cache.size>1){
      const keys=[...this.cache.keys()]
      const key=keys.find(k=>!this.wanted.has(k))??keys.find(k=>(this.tasks?.get(k)?.priority||0)>=3)??keys[0]
      this.bytes-=this.cache.get(key).bytes;this.cache.delete(key)
    }
    recordPerformance('cache',{entries:this.cache.size,bytes:this.bytes,queued:this.queue.length,running:this.running.size})
  }
  retryFailed(){
    for(const timer of this.retryTimers.values())clearTimeout(timer)
    this.retryTimers.clear();this.failed.clear();this.attempts.clear();this.refresh();this.publish()
  }
  pump(){
    while(this.running.size<this.concurrency&&this.queue.length){
      const task=this.queue.shift(),controller=new AbortController(),generation=this.generation,started=performance.now()
      controller.started=started
      this.running.set(task.key,controller)
      Promise.resolve().then(()=>task.run(controller.signal)).then(value=>{
        if(generation!==this.generation)return
        this.latency=this.latency*.8+(performance.now()-started)*.2
        const bytes=task.bytes?.(value)??JSON.stringify(value).length*2
        this.bytes-=this.cache.get(task.key)?.bytes||0
        this.cache.delete(task.key);this.cache.set(task.key,{value,bytes});this.bytes+=bytes
        this.attempts.delete(task.key);this.evict()
        recordPerformance('request',{ms:performance.now()-started,bytes})
      }).catch(error=>{
        if(generation!==this.generation||error.name==='AbortError')return
        this.failed.set(task.key,error)
        while(this.failed.size>this.maxEntries)this.failed.delete(this.failed.keys().next().value)
        const attempts=(this.attempts.get(task.key)||0)+1;this.attempts.set(task.key,attempts)
        if(error.retryable&&attempts<=this.retries){
          const timer=setTimeout(()=>{this.retryTimers.delete(task.key);this.failed.delete(task.key);this.refresh()},Math.min(8000,500*2**attempts))
          this.retryTimers.set(task.key,timer)
        }else if(this.wanted.has(task.key))this.onError(task.label?`${task.label}: ${error.message}`:error.message)
      }).finally(()=>{
        if(generation!==this.generation)return
        this.running.delete(task.key);this.publish();if(controller.signal.aborted&&this.wanted.has(task.key))this.refresh();else this.pump()
      })
    }
  }
  clear(){
    this.generation++;for(const controller of this.running.values())controller.abort()
    for(const timer of this.retryTimers.values())clearTimeout(timer)
    this.retryTimers.clear();this.running.clear();this.cache.clear();this.failed.clear();this.attempts.clear();this.queue=[];this.bytes=0;this.consumers.clear();this.wanted.clear()
  }
}
