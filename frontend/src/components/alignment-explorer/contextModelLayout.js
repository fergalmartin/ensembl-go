import { ROW_HEIGHT } from './layout.js'

export const MODEL_PITCH = 30
export const MODEL_INSET = 8

/** Feature arrays are grouped by type, not position. First/last entries are
 * therefore not the transcript's extent, especially on reverse-strand rows. */
export function transcriptBounds(transcript) {
  const features=(transcript?.features||[]).filter(f=>f.end>f.start)
  return features.length?{start:Math.min(...features.map(f=>f.start)),end:Math.max(...features.map(f=>f.end))}:null
}

export function packModelIntervals(items) {
  const ends=[]
  const packed=[...items].sort((a,b)=>a.start-b.start||a.end-b.end||String(a.id).localeCompare(String(b.id))).map(item=>{
    let lane=ends.findIndex(end=>end<=item.start)
    if(lane<0)lane=ends.length
    ends[lane]=item.end
    return {...item,lane}
  })
  return {items:packed,count:ends.length}
}

export function annotationModels(entry) {
  return packModelIntervals((entry?.genes||[]).flatMap(gene=>(gene.transcripts||[]).flatMap(transcript=>{
    const bounds=transcriptBounds(transcript)
    return bounds?[{gene,transcript,id:transcript.transcript_id,...bounds}]:[]
  })))
}

export function annotationLaneCounts(features) {
  return Object.fromEntries(Object.entries(features||{}).map(([id,entry])=>{
    const count=annotationModels(entry).count
    return [id,count?Math.ceil((MODEL_INSET+count*MODEL_PITCH)/ROW_HEIGHT):1]
  }))
}

/** The feature wins over its containing transcript, but names remain on top. */
export const orderedContextHits = hits => [
  ...hits.filter(h=>h.kind==='transcript'),
  ...hits.filter(h=>h.kind!=='transcript'&&h.kind!=='label'),
  ...hits.filter(h=>h.kind==='label'),
]
