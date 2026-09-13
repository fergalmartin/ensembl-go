/** Filtering sequences and blocks down to a working set.
 *
 * Everything here is a pure function over the summary the server returns, so the
 * panel can show what a filter would keep before anything is applied to the view.
 */

export const SEQUENCE_FILTER = {include:[],exclude:[],minBlocks:'',maxBlocks:'',minBases:'',maxBases:'',genome:'any'}
export const BLOCK_FILTER = {numbers:'',include:[],exclude:[],minLength:'',maxLength:'',minRows:'',maxRows:''}

/** Terms, from either a list already collected or a box of words still being
 * typed. Commas and spaces both separate, because people type both and neither
 * is worth being strict about. */
export const parseTerms = value =>
  (Array.isArray(value)?value:String(value||'').split(/[\s,]+/))
    .map(term=>String(term).trim().toLowerCase()).filter(Boolean)

/** Include is any-of and exclude is none-of: "human gorilla" keeps either, and
 * an exclusion always wins, so a term can be taken back out of a broad include. */
export function matchesTerms(haystack,include,exclude) {
  const text=String(haystack||'').toLowerCase()
  if(exclude.some(term=>text.includes(term)))return false
  return !include.length||include.some(term=>text.includes(term))
}

/** "1-20, 44, 60-70" as inclusive ranges. Reversed ends are read the way round
 * they were meant; anything unparseable is ignored rather than filtering
 * everything out while the reader is still typing. */
export function parseNumberRanges(text) {
  const ranges=[]
  for(const part of String(text||'').split(/[,;\s]+/)){
    if(!part)continue
    const match=part.match(/^(\d+)(?:\s*[-–:]\s*(\d+))?$/)
    if(!match)continue
    const a=Number(match[1]),b=match[2]===undefined?a:Number(match[2])
    ranges.push([Math.min(a,b),Math.max(a,b)])
  }
  return ranges
}

export const inRanges = (value,ranges) => !ranges.length||ranges.some(([a,b])=>value>=a&&value<=b)

const bound = (value,text,compare) => {
  const limit=Number(text)
  if(text===''||text===null||text===undefined||!Number.isFinite(limit))return true
  return compare(value,limit)
}
const atLeast = (value,text) => bound(value,text,(v,l)=>v>=l)
const atMost = (value,text) => bound(value,text,(v,l)=>v<=l)

/** `genome`: 'any', 'linked' for sequences carrying an assembly link, 'unlinked'
 * for the rest. Ancestors and unplaced rows are the usual reason to want either. */
export function filterSequences(sequences,filter={}) {
  const f={...SEQUENCE_FILTER,...filter}
  const include=parseTerms(f.include),exclude=parseTerms(f.exclude)
  return (sequences||[]).filter(s=>{
    if(!matchesTerms(`${s.source||''} ${s.label||''} ${s.assembly||''} ${s.region||''}`,include,exclude))return false
    if(f.genome==='linked'&&!s.assembly)return false
    if(f.genome==='unlinked'&&s.assembly)return false
    return atLeast(s.blocks||0,f.minBlocks)&&atMost(s.blocks||0,f.maxBlocks)
      &&atLeast(s.bases||0,f.minBases)&&atMost(s.bases||0,f.maxBases)
  })
}

/** `within` limits the result to blocks holding the sequences already chosen, so
 * narrowing sequences narrows the blocks on offer without hiding that the block
 * filter is doing something separate. */
export function filterBlocks(blocks,filter={},within=null) {
  const f={...BLOCK_FILTER,...filter}
  const ranges=parseNumberRanges(f.numbers)
  const include=parseTerms(f.include),exclude=parseTerms(f.exclude)
  return (blocks||[]).filter(b=>{
    if(within&&!within.has(b.id))return false
    if(!inRanges(b.id,ranges))return false
    if((include.length||exclude.length)&&!matchesTerms(`block ${b.id}`,include,exclude))return false
    return atLeast(b.length||0,f.minLength)&&atMost(b.length||0,f.maxLength)
      &&atLeast(b.available??b.rows??0,f.minRows)&&atMost(b.available??b.rows??0,f.maxRows)
  })
}

export const isDefaultFilter = (filter,defaults) =>
  Object.keys(defaults).every(key=>{
    const base=defaults[key],value=filter?.[key]??base
    return Array.isArray(base)?parseTerms(value).length===0:value===base
  })

/** What a filter actually applies to.
 *
 * Ticking nothing means the filter itself is the choice, so a reader who narrows
 * to eight sequences does not then have to tick eight boxes. Ticking anything
 * makes the ticks the choice, and only among what the filter still shows, so a
 * tick left behind by an earlier filter cannot quietly come back. */
export function effectiveChoice(filtered,chosen,key='id') {
  const all=filtered.map(item=>item[key])
  if(!chosen||!chosen.size)return all
  const kept=all.filter(value=>chosen.has(value))
  return kept.length?kept:all
}

/** Chunks for a layer built from a filter: one per chosen block, holding only
 * the chosen sequences that block actually has. */
export function filterChunks(membership,blocks,sequenceIds,lengths) {
  const wanted=new Set(sequenceIds),chosen=new Set(blocks)
  const result=[]
  for(const entry of membership||[]){
    if(!chosen.has(entry.block))continue
    const ids=entry.ids.filter(id=>wanted.has(id))
    const length=lengths.get(entry.block)
    if(!ids.length||!length)continue
    result.push({sourceBlock:entry.block,start:0,end:length,rowIds:ids})
  }
  return result
}

/** Chunks for a coordinate filter.
 *
 * A genomic interval is read in each chosen sequence's own coordinates, so two
 * species asked for the same numbers are asked about two different places, and
 * within one block each matched row lands on its own column range. The chunk
 * therefore carries per-row coverage rather than one rectangle: taking the union
 * of the ranges would hand back columns that are outside the interval for every
 * row but the widest.
 *
 * A row whose interval falls where it has no aligned bases has no columns to
 * give and is left out, though its block still counts as overlapping.
 */
export function rangeChunks(matches,blocks) {
  const chosen=new Set(blocks),byBlock=new Map()
  for(const match of matches||[]){
    if(!chosen.has(match.block)||!match.columns)continue
    if(!byBlock.has(match.block))byBlock.set(match.block,[])
    byBlock.get(match.block).push(match)
  }
  const result=[]
  for(const [block,items] of [...byBlock].sort((a,b)=>a[0]-b[0])){
    const start=Math.min(...items.map(m=>m.columns[0])),end=Math.max(...items.map(m=>m.columns[1]))
    const coverage={}
    for(const m of items)coverage[m.id]=[[m.columns[0],m.columns[1]]]
    result.push({sourceBlock:block,start,end,rowIds:items.map(m=>m.id),coverage})
  }
  return result
}
