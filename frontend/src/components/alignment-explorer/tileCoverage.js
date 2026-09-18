import { renderResolution } from './renderResolution.js'

const indexes=new WeakMap()
export function rowIndex(data){let index=indexes.get(data);if(!index){index=new Map(data.rows.map(row=>[row.id,row]));indexes.set(data,index)}return index}

/** How fine a tile has to be before being finer stops meaning anything.
 *
 * Half a screen pixel, in columns. The painters merge everything below that
 * into one mark, so it is the finest distinction a tile can still be drawn
 * making. */
export const drawnUnit = scale => scale > 0 ? .5 / scale : 0

/** Which of two tiles a stretch is better drawn from, when both hold it.
 *
 * Finest first was the rule, and above what a pixel can show it still is:
 * there the difference between one tile and another can be seen, and the
 * sharper answer is the better one. Detail stays ahead of all of it, because a
 * sequence is a sequence at any zoom.
 *
 * Below `unit` it is not a preference any more, it is a coin toss with a bill
 * attached. A tile binned a tenth of a pixel and one binned half a pixel put
 * the same picture on screen - the painters collapse both to half a pixel - and
 * the finer one gets there by reading five times as many bins to do it. Zooming
 * out is where that bites: the levels the reader has just left are all still in
 * hand, every one of them finer than the level they are now looking at, and
 * finest-first picked the very finest of them every time.
 *
 * With no `unit` nothing is under it and this is the old rule exactly, which is
 * what a readout with no camera behind it still wants.
 */
const band = (data, unit) => data.detail ? 0 : data.bin_size <= unit ? 1 : 2
export const byDrawnResolution = (unit = 0) => (a, b) => {
  const ga = band(a, unit), gb = band(b, unit)
  if (ga !== gb) return ga - gb
  if (ga === 0) return 0
  // Already finer than a pixel: the coarsest is the cheapest road to the same
  // picture. Coarser than a pixel: the finest is the one worth drawing.
  return ga === 1 ? b.bin_size - a.bin_size : a.bin_size - b.bin_size
}

/** Resolve each row independently. An arriving partial tile must never erase
 * another tile's coverage. Returned spans do not overlap, so true missing rows
 * and gaps can paint over coarse presence without double blending. */
/** `focus` names the row these summaries must be relative to. Sequence is
 * sequence whoever it is being read against, so detail tiles are always kept;
 * a binned tile carries agreement with its own comparison row, and showing one
 * built against a previous reference would answer a question nobody asked. Such
 * a tile is dropped rather than drawn, leaving a hole that says "loading". */
export function rowCoverage(sources,rowId,start,end,scale,focus=undefined) {
  const spans=[]
  const candidates=sources.map(source=>renderResolution(source,scale)).filter(data=>data.end>start&&data.start<end&&rowIndex(data).has(rowId))
    .filter(data=>focus===undefined||data.detail||(data.focus??null)===focus)
    .sort(byDrawnResolution(drawnUnit(scale)))
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
