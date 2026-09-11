import { renderResolution } from './renderResolution.js'

const indexes=new WeakMap()
export function rowIndex(data){let index=indexes.get(data);if(!index){index=new Map(data.rows.map(row=>[row.id,row]));indexes.set(data,index)}return index}

/** Resolve each row independently. An arriving partial tile must never erase
 * another tile's coverage. Returned spans do not overlap, so true missing rows
 * and gaps can paint over coarse presence without double blending. */
export function rowCoverage(sources,rowId,start,end,scale) {
  const spans=[]
  const candidates=sources.map(source=>renderResolution(source,scale)).filter(data=>data.end>start&&data.start<end&&rowIndex(data).has(rowId))
    .sort((a,b)=>(a.detail?0:a.bin_size)-(b.detail?0:b.bin_size))
  let holes=[[start,end]]
  for(const data of candidates){
    const next=[]
    for(const [a,z] of holes){
      const lo=Math.max(a,data.start),hi=Math.min(z,data.end)
      if(hi<=lo){next.push([a,z]);continue}
      spans.push({start:lo,end:hi,data,row:rowIndex(data).get(rowId)})
      if(a<lo)next.push([a,lo]);if(hi<z)next.push([hi,z])
    }
    holes=next;if(!holes.length)break
  }
  return {spans:spans.sort((a,b)=>a.start-b.start),holes}
}
export function sampleBase(tile,rowId,column){
  for(const data of tile?.sources||[tile?.data].filter(Boolean)){
    const row=rowIndex(data).get(rowId)
    if(data.detail&&row?.sequence&&column>=data.start&&column<data.end)return row.sequence[column-data.start]
  }
}
