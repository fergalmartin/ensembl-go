/** Columns removed from the drawing without being removed from the alignment.
 *
 * A fragment carries `collapsed`: source column ranges the reader has asked not
 * to be shown, because no sequence they are looking at has a base in them. The
 * fragment's `start` and `end` never move. Everything outside this module goes
 * on addressing columns by their real number — tiles, selections, exports,
 * annotations and connections are all still in source coordinates, and a
 * collapse cannot silently renumber what a reader is about to export.
 *
 * What changes is only where a column is drawn. The map is piecewise linear and
 * monotonic: `displayColumn` counts how far along the drawn panel a source
 * column falls, `sourceColumn` reads it back. A fragment with nothing collapsed
 * takes the identity path and allocates nothing, which is what keeps this
 * invisible to the overwhelming majority of sheets that never collapse anything.
 */

const cache=new WeakMap()

/** Kept runs, each with the number of collapsed columns that precede it.
 *
 * `hidden` is what a painter subtracts: the column's own offset minus the
 * columns removed before it is exactly its position in the drawn panel. Null
 * where nothing is collapsed, so every caller has one cheap test for the
 * identity case rather than a list that happens to hold one run.
 */
export function keptRuns(f) {
  if(!f?.collapsed?.length)return null
  const found=cache.get(f)
  if(found!==undefined)return found
  const runs=[];let cursor=f.start,hidden=0
  for(const [a,z] of f.collapsed){
    const start=Math.max(f.start,a),end=Math.min(f.end,z)
    if(end<=start)continue
    if(start>cursor)runs.push({a:cursor,z:start,hidden})
    hidden+=end-Math.max(cursor,start)
    cursor=Math.max(cursor,end)
  }
  if(cursor<f.end)runs.push({a:cursor,z:f.end,hidden})
  // A panel with nothing left to draw is not a collapse, it is a disappearance.
  // Refusing it here means no caller has to defend against a zero-width panel,
  // an empty run list or a scale divided by nothing.
  const value=runs.length?runs:null
  cache.set(f,value)
  return value
}

/** Columns the panel actually draws. */
export function displaySpan(f) {
  const runs=keptRuns(f)
  if(!runs)return Math.max(0,f.end-f.start)
  const last=runs[runs.length-1]
  return last.z-last.hidden-f.start
}

/** How many columns of the fragment are collapsed. */
export const collapsedColumns=f=>Math.max(0,(f.end-f.start)-displaySpan(f))

/** Kept runs merged until the joins between them are too fine to see.
 *
 * The map above is exact, and at any zoom where a column is a pixel or more
 * that is what a painter wants. Zoomed out it is the wrong question: a block
 * cut into four thousand runs draws four thousand pieces per row, each of them
 * a fraction of a pixel wide, and the cost of a sheet goes up with how gappy
 * the alignment is rather than with how much of it is on screen. The joins were
 * already drawn this way - marks nearer than they are wide are one mark - and
 * the cells they cut had simply never been given the same treatment.
 *
 * `tolerance` is how far a column may be drawn from its true place, in columns,
 * so a caller passes the columns a pixel covers and gets back a run list whose
 * error is under a pixel by construction. Drift is measured from the group's
 * own first run and never from the last one merged: closing on each join
 * separately would let a hundred half-pixel joins slide the far end of a group
 * fifty pixels off the map, which is the bug this parameter exists to avoid.
 *
 * A merged run spans the collapsed stretches inside it, so their columns are
 * drawn rather than skipped. At this zoom they are under a pixel and they are
 * gap in every row on screen - which is the one thing that makes them safe to
 * draw and unsafe to renumber around.
 */
const simplified=new WeakMap()
export function drawnRuns(f,tolerance=0) {
  const exact=keptRuns(f)
  if(!exact||!(tolerance>0))return exact
  let levels=simplified.get(f)
  if(!levels){levels=new Map();simplified.set(f,levels)}
  const found=levels.get(tolerance)
  if(found!==undefined)return found
  const runs=[]
  let group=null
  for(const run of exact){
    if(group&&run.hidden-group.hidden<=tolerance){group.z=run.z;continue}
    runs.push(group={a:run.a,z:run.z,hidden:run.hidden})
  }
  const value=runs.length<exact.length?runs:exact
  levels.set(tolerance,value)
  // Two zoom levels is what a reader moves between; a third is one they have
  // left. Bounded here because the key is a number and nothing else evicts it.
  while(levels.size>3)levels.delete(levels.keys().next().value)
  return value
}

function runAt(runs,column) {
  let lo=0,hi=runs.length-1
  while(lo<hi){const mid=(lo+hi+1)>>1;if(runs[mid].a<=column)lo=mid;else hi=mid-1}
  return runs[lo]
}

/** A source column's offset along the drawn panel.
 *
 * A collapsed column has no place of its own; it answers with the join it sits
 * in, which is where anything addressing it should be drawn. That keeps a
 * selection or a feature that runs into a collapsed stretch ending exactly at
 * the mark, rather than reaching past it into columns the reader cannot see.
 */
export function displayColumn(f,column) {
  const runs=keptRuns(f)
  if(!runs)return column-f.start
  if(column<=runs[0].a)return 0
  const run=runAt(runs,column)
  return Math.min(run.z,Math.max(run.a,column))-run.hidden-f.start
}

/** The source column drawn at an offset along the panel. */
export function sourceColumn(f,offset) {
  const runs=keptRuns(f)
  if(!runs)return f.start+offset
  const target=f.start+offset
  let lo=0,hi=runs.length-1
  while(lo<hi){const mid=(lo+hi+1)>>1;if(runs[mid].a-runs[mid].hidden<=target)lo=mid;else hi=mid-1}
  const run=runs[lo]
  return Math.min(run.z,Math.max(run.a,target+run.hidden))
}

/** The drawn pieces of a source interval, each with the columns removed before
 *  it. Painters keep their straight-line loops and only shift their origin.
 *
 * `tolerance` is passed straight to `drawnRuns`: zero, and the pieces are the
 * map exactly; a pixel's worth of columns, and neighbouring runs come back as
 * one piece wherever the join between them is too fine to draw. */
export function columnPieces(f,start,end,tolerance=0) {
  const runs=drawnRuns(f,tolerance)
  if(!runs)return start<end?[{start,end,hidden:0}]:[]
  const pieces=[]
  // Found rather than scanned to. This runs per row per span per frame, and a
  // block cut into thousands of runs would otherwise walk all of them to reach
  // the handful a row's visible span actually crosses.
  let lo=0,hi=runs.length-1
  while(lo<hi){const mid=(lo+hi+1)>>1;if(runs[mid].z<=start)lo=mid;else hi=mid-1}
  for(let i=lo;i<runs.length;i++){
    const run=runs[i]
    if(run.a>=end)break
    const a=Math.max(start,run.a),z=Math.min(end,run.z)
    if(z>a)pieces.push({start:a,end:z,hidden:run.hidden})
  }
  return pieces
}

/** Where the collapsed stretches were, in panel offsets, for the marks that say
 *  so. One per join between kept runs; the count is what was taken out there.
 *
 * Bounded by a window of panel offsets, because a block can be cut into
 * thousands of runs and a painter wants the handful under the viewport. Built
 * whole and filtered afterwards, this was walking every run of every block on
 * screen on every frame. */
export function collapseJoins(f,fromOffset=-Infinity,toOffset=Infinity) {
  const runs=keptRuns(f)
  if(!runs)return []
  const offsetOf=run=>run.a-run.hidden-f.start
  let lo=1,hi=runs.length-1
  if(fromOffset>-Infinity){
    while(lo<hi){const mid=(lo+hi)>>1;if(offsetOf(runs[mid])<fromOffset)lo=mid+1;else hi=mid}
  }
  const joins=[]
  for(let i=Math.max(1,lo);i<runs.length;i++){
    const offset=offsetOf(runs[i])
    if(offset>toOffset)break
    if(offset<fromOffset)continue
    joins.push({offset,columns:runs[i].hidden-runs[i-1].hidden,start:runs[i-1].z,end:runs[i].a})
  }
  return joins
}

/** Server runs narrowed to one fragment's columns, as the fragment stores them.
 *
 * Runs arrive for a whole block and a fragment is often a piece of one, so a
 * run overhanging either edge is trimmed rather than dropped: the part inside
 * the fragment is collapsed and the part outside is not this fragment's to
 * answer for. */
export function clipRuns(runs,start,end) {
  const out=[]
  for(const [a,z] of runs||[]){
    const lo=Math.max(start,a),hi=Math.min(end,z)
    if(hi>lo)out.push([lo,hi])
  }
  return out
}

/** Close the space a collapse frees between panels.
 *
 * A collapsed panel is narrower but starts where it always did, so what it
 * gives up opens as a channel before the next block rather than as room to
 * read in. On Original that is the wrong answer: its arrangement is the file's
 * own order and nothing about it is the reader's to preserve, so the blocks
 * after a collapsed one move up by exactly what was taken out of it and every
 * channel keeps the width it had. A layer is the opposite case - its
 * arrangement is the reader's own work - and is left alone, with Auto arrange
 * there for closing gaps when that is what they want.
 *
 * Each fragment carries how far it moved as `packShift`, which is what lets the
 * camera be moved by the same amount and the sheet stay still under it. Order
 * is by position, not by block number: a packed sheet's blocks are already laid
 * out in file order and a merged group sits where its own span puts it.
 */
export function packCollapsed(fragments) {
  if(!fragments?.some(f=>f.collapsed?.length))return fragments
  const shifts=new Map()
  let shift=0
  for(const f of [...fragments].sort((a,b)=>a.x-b.x||a.sourceBlock-b.sourceBlock)){
    shifts.set(f.id,shift)
    shift+=collapsedColumns(f)
  }
  return fragments.map(f=>{
    const moved=shifts.get(f.id)||0
    return moved?{...f,x:f.x-moved,packShift:moved}:f
  })
}
