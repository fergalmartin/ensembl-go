/** The largest cohort, and the largest rectangle of it, worth asking about.
 *
 * The answer is an intersection over every base of every row on screen, so its
 * cost is bounded by the rectangle's area - and usually far under it, because
 * the intersection only ever shrinks and a cohort that agrees nowhere is
 * finished after a few rows.
 *
 * Measured rather than guessed: on a 44-mammal EPO alignment the worst block in
 * the file - 576,256 columns by 83 rows, 48M cells - answers in 236ms, and a
 * million-column block by 43 rows in 310ms. The first figure here was eight
 * million cells, which is a fifth of that and well under what an ordinary
 * working layer asks: thirty-three sequences over a 421,559-column block is
 * 14M cells, so the commonest case of all was being refused, silently, while
 * the control went on saying gaps were hidden. */
const MAX_ROWS=500, MAX_CELLS=60_000_000

export const collapseKey=f=>`${f.sourceBlock}:${f.start}:${f.end}:${[...f.rowIds].sort().join(',')}`

/** Which fragments can be asked about, and what to ask.
 *
 * One request per distinct block, window and cohort, so the chunks of a block
 * that a layer holds separately - same rows, same columns - ask once between
 * them and are collapsed identically. Two chunks of one block that hold
 * different rows are different questions and stay so.
 */
export function collapseRequests(fragments=[],minRun=1,percent=100) {
  const wanted=new Map()
  for(const f of fragments){
    if(f.aggregate||!f.rowIds?.length)continue
    if(f.rowIds.length>MAX_ROWS)continue
    if((f.end-f.start)*f.rowIds.length>MAX_CELLS)continue
    const key=collapseKey(f)
    if(wanted.has(key))continue
    wanted.set(key,{block:f.sourceBlock,start:f.start,end:f.end,ids:[...f.rowIds].sort(),min_run:minRun,gap_percent:percent})
  }
  return wanted
}

/** The scheduler key for one block's answer.
 *
 * Both thresholds are part of it because both are part of the question: the
 * shortest run worth hiding and how much of the cohort has to be a gap are two
 * different answers over the same cohort, and a key that left either out served
 * one the other's. Clearing the cache on a change is not the alternative -
 * clearing also drops what the scheduler has been asked for, and what asks is
 * keyed on the set of keys, so nothing would ask again.
 */
export const collapseTaskKey=(datasetId,minRun,percent,key)=>`${datasetId}:${minRun}:${percent}:${key}`
