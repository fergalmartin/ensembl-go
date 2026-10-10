/**
 * Fit block headers to their own visible width.
 * Drop coordinates first, then actions, then the word Block; retain the number
 * as long as it fits. Wider space must never select a less detailed header.
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

/**
 * Place ruler ticks inside the block and labels inside the visible right edge.
 * Keep a tick when its label will not fit. from is the first visible column;
 * limit is the block or viewport edge the text must stay within.
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
