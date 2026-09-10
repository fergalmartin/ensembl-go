/** Persistent requests and independently published tiles, like browser tracks.
 * Navigation replaces queued work, not useful in-flight requests. */
export class TileScheduler {
  constructor({concurrency=3,maxEntries=96,maxBytes=48*1024*1024,onChange=()=>{},onError=()=>{}}={}) {
    Object.assign(this,{concurrency,maxEntries,maxBytes,onChange,onError})
    this.cache=new Map();this.running=new Map();this.queue=[];this.failed=new Map();this.generation=0;this.bytes=0;this.wanted=new Set()
  }
  get(key){return this.cache.get(key)?.value}
  values(){return [...this.cache.values()].map(x=>x.value)}
  setWanted(tasks){
    const unique=new Map(tasks.map(t=>[t.key,t]))
    this.wanted=new Set(unique.keys())
    this.queue=[...unique.values()].filter(t=>!this.cache.has(t.key)&&!this.running.has(t.key)&&!this.failed.has(t.key)).sort((a,b)=>(a.priority||0)-(b.priority||0))
    this.pump()
  }
  pump(){
    while(this.running.size<this.concurrency&&this.queue.length){
      const task=this.queue.shift(),controller=new AbortController(),generation=this.generation
      this.running.set(task.key,controller)
      Promise.resolve().then(()=>task.run(controller.signal)).then(value=>{
        if(generation!==this.generation)return
        const bytes=task.bytes?.(value)??JSON.stringify(value).length*2
        this.cache.set(task.key,{value,bytes});this.bytes+=bytes
        while(this.cache.size>this.maxEntries||this.bytes>this.maxBytes&&this.cache.size>1){const key=this.cache.keys().next().value;this.bytes-=this.cache.get(key).bytes;this.cache.delete(key)}
      }).catch(error=>{
        if(generation!==this.generation||error.name==='AbortError')return
        this.failed.set(task.key,error);while(this.failed.size>this.maxEntries)this.failed.delete(this.failed.keys().next().value);if(this.wanted.has(task.key))this.onError(task.label?`${task.label}: ${error.message}`:error.message)
      }).finally(()=>{
        if(generation!==this.generation)return
        this.running.delete(task.key);this.onChange();this.pump()
      })
    }
  }
  clear(){
    this.generation++;for(const controller of this.running.values())controller.abort()
    this.running.clear();this.cache.clear();this.failed.clear();this.queue=[];this.bytes=0
  }
}
