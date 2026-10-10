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

/**
 * Return kept blocks in file order.
 * or unions picked blocks with blocks containing any picked sequence.
 * and uses picked blocks as candidates, then requires every picked sequence.
 * With no block picks, all blocks are candidates; with no sequence picks, keep
 * the picked blocks. No matching candidate produces an empty result.
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

/**
 * Find picked-sequence membership from a layer's own chunks.
 * Union membership when several chunks share a source block, and omit blocks
 * holding none of the picks. Original needs server membership because most
 * source blocks are not loaded; a layer already holds its complete membership.
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

/**
 * Derive a layer's hidden view without moving its saved chunks.
 * Compact rows share one slot per surviving identity across the layer; Keep
 * preserves existing slots. Drop layoutRows so chunks shrink to visible rows.
 * Auto arrange remains a separate action.
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
