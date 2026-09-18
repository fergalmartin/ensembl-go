/** What a block header can say at the width it has.
 *
 * The block's number is what identifies it, so it is the last thing to go: the
 * coordinate interval drops first, then the header's actions, then the word
 * "Block" itself, down to the bare number. Nothing is ever drawn wider than the
 * room it was measured against, so a header cannot run over its own block's
 * edges into its neighbour.
 *
 * The rungs only ever improve as `room` grows, which is the property that keeps
 * zooming in from taking away a header a narrower block was already showing.
 *
 * Room is the block's own visible span and nothing else. How crowded the view is
 * as a whole has no say: one wide block among slivers has the room for all of it,
 * and used to be cut back to its number alone because its neighbours were small.
 */
export function blockHeaderPlan({room,actionsWidth,sourceBlock,interval,note='',compact=false,measure}) {
  const long=`Block ${sourceBlock}`,suffix=compact?` · compact`:''
  // `note` is a droppable piece of its own rather than part of the interval,
  // because it is the first thing that should go when the header narrows and
  // the last thing that should be abbreviated. A count of columns the panel is
  // not drawing has to be readable as a sentence or not be there at all - a
  // shortened form of it is a number the reader has to guess the meaning of.
  const plans=[
    ...(note?[{text:long+suffix,actions:true,interval:true,note:true}]:[]),
    {text:long+suffix,actions:true,interval:true},
    {text:long+suffix,actions:true,interval:false},
    {text:long,actions:true,interval:false},
    {text:long,actions:false,interval:false},
    {text:`Blk ${sourceBlock}`,actions:false,interval:false},
    {text:`${sourceBlock}`,actions:false,interval:false},
  ]
  const lineOf=plan=>plan.interval?(plan.note?`${interval} · ${note}`:interval):''
  const width=plan=>Math.max(measure(plan.text),plan.interval?measure(lineOf(plan)):0)
  const plan=plans.find(p=>width(p)+(p.actions?actionsWidth:0)<=room)
  return plan?{...plan,width:width(plan),line:lineOf(plan)}:null
}

/** Where a block's ruler puts its marks, and which of them can be named.
 *
 * A tick is inside the block by construction - the loop stops at its last
 * column - but the number beside it is not, and the panel is clipped at its own
 * edge. So the last tick of a block was labelled with half a number, and at the
 * edge of the viewport with half a number that continued nowhere. A mark whose
 * number does not fit is still worth drawing: it says where the column is, and
 * the two ends of the interval are already named in the header.
 *
 * `limit` is the right edge the text has to stay inside - the block's own edge,
 * or the viewport's where the block runs past it - and `from` is the first
 * column to consider, which is where the view starts rather than where the
 * block does.
 */
export function rulerTicks({from,end,x,start,scale,step,limit,viewport=Infinity,measure,pad=3}) {
  const ticks=[]
  if(!(step>0))return ticks
  for(let column=Math.ceil(from/step)*step;column<end;column+=step){
    const at=x+(column-start)*scale
    if(at>viewport)break
    const label=(column+1).toLocaleString()
    ticks.push({x:at,label:at+pad+measure(label)<=limit?label:null})
  }
  return ticks
}
