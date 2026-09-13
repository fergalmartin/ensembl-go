import { createFragment, highlightedRows, pickedRowIds } from './layers.js'

/** Hiding narrows Original to what the reader has picked out, and packs it.
 *
 * The rule is "anything I have marked, and nothing else": a block survives if it
 * was picked itself, or if a picked sequence runs through it. The second half is
 * why this cannot be answered from the blocks on screen — a sequence runs the
 * length of the file, and the blocks it visits are mostly not loaded — so the
 * sequences are sent to `blocks-with` and the answer unioned in here.
 */
export function hiddenSelection(selection=[],highlighted=[],fragments=[]) {
  const byId=new Map(fragments.filter(f=>!f.aggregate).map(f=>[f.id,f]))
  const blocks=new Set()
  for(const pick of selection){
    const fragment=byId.get(pick.fragmentId)
    if(fragment)blocks.add(fragment.sourceBlock)
  }
  const rows=new Set(pickedRowIds(selection))
  for(const id of highlightedRows(highlighted))rows.add(id)
  return {blocks:[...blocks].sort((a,b)=>a-b),rows:[...rows]}
}

/** Whether there is anything to hide down to. */
export const canHide=choice=>!!(choice.blocks.length||choice.rows.length)

/** Every block the choice keeps, in file order.
 *
 * `or` takes the union: each thing picked out brings its blocks with it, so
 * picking two blocks and three sequences keeps both blocks and every block any
 * of the three runs through. It answers "show me everything I marked".
 *
 * `and` reads the picks as conditions on one block, which is a different
 * question: not "where does any of this appear" but "where does all of it
 * coincide". Picked blocks become the candidates — nothing outside them is
 * considered — and each candidate has to hold every picked sequence. With no
 * sequences picked the blocks stand alone, and with no blocks picked the whole
 * file is the candidate list, so three sequences keep only the blocks holding
 * all three. A condition nothing satisfies keeps nothing, which is an answer
 * rather than a failure and is reported as one.
 */
export function keptBlocks(choice,membership=[],mode='or') {
  const order=blocks=>[...blocks].sort((a,b)=>a-b)
  if(mode!=='and'){
    const blocks=new Set(choice.blocks)
    for(const entry of membership)blocks.add(entry.block)
    return order(blocks)
  }
  if(!choice.rows.length)return order(new Set(choice.blocks))
  const wanted=new Set(choice.rows)
  const complete=new Set(membership
    .filter(entry=>new Set((entry.ids||[]).filter(id=>wanted.has(id))).size===wanted.size)
    .map(entry=>entry.block))
  if(!choice.blocks.length)return order(complete)
  return order(new Set(choice.blocks.filter(block=>complete.has(block))))
}

/** What a hide leaves standing: the blocks, and the rows if rows are being hidden.
 *
 * Every mode ends up hiding blocks, including the one that sets out to hide only
 * sequences. Hiding a sequence empties the blocks it was the only visible thing
 * in, and an empty block is not something to keep: it is the header of a block
 * whose contents were just hidden, standing between the blocks that do still
 * hold something and pushing them apart. So wherever sequences are being hidden,
 * a block has to still hold one of the survivors to stay.
 */
export function hideResult(choice,membership=[],{what='blocks',mode='or'}={}) {
  const rows=what==='blocks'?null:choice.rows
  const blocks=what==='sequences'
    ?keptBlocks({blocks:[],rows:choice.rows},membership,'or')
    :keptBlocks(choice,membership,mode)
  if(!rows?.length)return {blocks,rows:null}
  const holds=new Set(membership.map(entry=>entry.block))
  return {blocks:blocks.filter(block=>holds.has(block)),rows}
}

/** Which of a layer's blocks hold each picked sequence.
 *
 * Original has to ask the server this: a sequence runs the length of the file
 * and the blocks it visits are mostly not loaded. A layer neither can nor needs
 * to. It holds only the chunks taken into it, and those chunks are the whole
 * truth about which of its blocks carry which sequences - a block the layer
 * does not have is not a block the layer can keep.
 *
 * A block can be several chunks once pieces of it have been moved separately,
 * so what each of them holds is unioned under the one block number, and a block
 * holding none of the picks is left out entirely: `keptBlocks` reads an entry's
 * presence as "this block carries a pick" when it takes the union.
 */
export function layerMembership(fragments=[],rows=[]) {
  if(!rows.length)return []
  const wanted=new Set(rows),byBlock=new Map()
  for(const fragment of fragments){
    if(fragment.aggregate)continue
    const held=fragment.rowIds.filter(id=>wanted.has(id))
    if(!held.length)continue
    if(!byBlock.has(fragment.sourceBlock))byBlock.set(fragment.sourceBlock,new Set())
    for(const id of held)byBlock.get(fragment.sourceBlock).add(id)
  }
  return [...byBlock].map(([block,ids])=>({block,ids:[...ids]})).sort((a,b)=>a.block-b.block)
}

/** A layer's hide, applied where the layer is read rather than to the layer.
 *
 * Original answers a hide by fetching the survivors' layout and packing them
 * shoulder to shoulder, because its arrangement is the file's and the file's
 * order is all it has. A layer's arrangement is the reader's own work, so
 * hiding must not move anything: the chunks that go are simply not drawn, and
 * the ones that stay are exactly where they were left. Auto arrange is there
 * for closing the gaps, and it is a separate decision.
 *
 * Rows are a separate question, and `rowLayout` answers it. Compact, the
 * default, gives the survivors one slot each in the layer's row order - the
 * same numbering `tidyLayer` gives a whole layer - so they rise to the top of
 * every chunk and a row shared by two chunks still lines up with itself across
 * them. Renumbering each chunk on its own would also close the gaps, but it
 * would put that shared row on a different line in each chunk it appears in,
 * and those lines are what the connection strings are drawn along. Keep leaves
 * every survivor on the slot it had, gaps and all, for a layer whose vertical
 * arrangement means something.
 *
 * `layoutRows` is dropped either way, so a chunk whose lowest rows all went
 * hidden shrinks to what it is still showing.
 */
export function hideLayerFragments(fragments=[],hidden,rowOrder=[]) {
  if(!hidden)return fragments
  const blocks=hidden.blocks?.length?new Set(hidden.blocks):null
  const rows=hidden.rows?.length?new Set(hidden.rows):null
  if(!blocks&&!rows)return fragments
  const kept=[]
  for(const fragment of fragments){
    if(blocks&&!blocks.has(fragment.sourceBlock))continue
    if(!rows){kept.push(fragment);continue}
    const slots=[],ids=[]
    fragment.rowIds.forEach((id,index)=>{
      if(!rows.has(id))return
      ids.push(id);slots.push(fragment.slots?.[index]??index)
    })
    if(!ids.length)continue
    kept.push({...fragment,rowIds:ids,slots,layoutRows:null})
  }
  if(!rows||hidden.rowLayout==='keep')return kept
  const order=[...new Set(kept.flatMap(f=>f.rowIds))].sort((a,b)=>rowOrder.indexOf(a)-rowOrder.indexOf(b))
  return kept.map(fragment=>({...fragment,slots:fragment.rowIds.map(id=>order.indexOf(id))}))
}

/** The gap the file layout leaves between blocks, read off the blocks
 *  themselves rather than assumed: it is a server-side constant and the client
 *  has no business hard-coding a second copy of it. */
export function layoutGap(descriptors) {
  for(let i=1;i<descriptors.length;i++){
    const gap=descriptors[i].x-descriptors[i-1].end_x
    if(descriptors[i].block===descriptors[i-1].block+1&&gap>0)return gap
  }
  return 0
}

/** Lay the survivors out shoulder to shoulder.
 *
 * Each keeps its own number, its own columns and its own rows; only its place on
 * the sheet changes. The blocks between them are not drawn, so what were distant
 * neighbours become adjacent ones, and the connection strings — which pair each
 * sequence's chunks in block order — join them as they would any other pair.
 */
export function packBlocks(descriptors,gap=layoutGap(descriptors)) {
  let x=0
  return descriptors.map(descriptor=>{
    const width=Math.max(1,descriptor.end_x-descriptor.x)
    const fragment=createFragment(descriptor.block,0,width,descriptor.row_ids||[],{
      id:`original:${descriptor.block}`,x,
      sourceRowCount:descriptor.row_count,availableRows:descriptor.available_row_ids})
    x+=width+gap
    return fragment
  })
}

/** How wide the packed sheet is, for the camera's travel. */
export const packedExtent=fragments=>fragments.length
  ?fragments[fragments.length-1].x+(fragments[fragments.length-1].end-fragments[fragments.length-1].start)
  :1
