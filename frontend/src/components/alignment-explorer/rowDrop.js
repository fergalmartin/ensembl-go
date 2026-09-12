import { panelGeometry, rowSlot } from './layers.js'
import { MARGIN_X, MARGIN_Y, ROW_HEIGHT } from './layout.js'

const rectOf=(f,camera)=>({...panelGeometry(f,camera,MARGIN_X),y:MARGIN_Y+f.y*ROW_HEIGHT-camera.y})

/** Where a row dragged over Original would land.
 *
 * The rows to aim between are the ones on screen where the cursor is, and that
 * is not always the gutter's list. The gutter names the file-wide row order, or,
 * once a compact block claims it, that one block's rows; every other compact
 * block packs the sequences it happens to hold from its own top. Reading the
 * drop off the gutter therefore offered a handful of positions belonging to a
 * different block and inserted the row before whichever sequence the gutter had
 * at that height, which is not the one under the cursor.
 *
 * An aligned block is the one case where the gutter is both right and richer: it
 * draws its rows on the file-wide slots the gutter is already publishing, and
 * the gutter also offers the empty slots between them, which belong to
 * sequences this block does not hold.
 *
 * A dragged jump marker names the block it points into, and that block alone
 * answers the drag. The cursor's height chooses the gap; its horizontal position
 * chooses nothing. A marker sits in the channel between blocks, so a drag from
 * one is usually over no block at all, and letting the cursor's column claim the
 * insertion meant the target changed under the hand as it crossed a neighbour.
 *
 * Markers are also drawn for blocks outside the loaded window — that is what
 * most of them are for — and those name a block with no rows on screen to aim
 * between. The drag falls back to the block the marker is drawn on, which does
 * hold the sequence, and never to whatever the cursor happens to be over: a
 * block that does not carry this row is never a place to put it.
 */
export function originalRowDropTarget({point,fragments=[],camera,gutterRows=[],gutterAnchor=null,order=[],jumpBlock=null,fragmentId=null,rowId=null}) {
  const blocks=fragments.filter(f=>!f.aggregate)
  const aimed=jumpBlock==null?null:blocks.find(f=>f.sourceBlock===jumpBlock)||blocks.find(f=>f.id===fragmentId)||null
  const under=jumpBlock!=null?null:point.x>=MARGIN_X?blocks.find(f=>{const r=rectOf(f,camera);return point.x>=r.x&&point.x<=r.x+r.width}):null
  const target=aimed||under
  const fromBlock=!!target&&(target.compact||gutterAnchor!=null)
  const rows=fromBlock
    ?target.rowIds.map((id,i)=>({rowId:id,y:rectOf(target,camera).y+rowSlot(target,i)*ROW_HEIGHT,height:ROW_HEIGHT}))
    :[...gutterRows].sort((a,b)=>a.y-b.y)
  const answer=(()=>{
    if(!rows.length)return {beforeId:null,lineY:point.y}
    const at=rows.findIndex(row=>point.y<row.y+row.height/2)
    if(at>=0)return {beforeId:rows[at].rowId,lineY:rows[at].y}
    const last=rows[rows.length-1]
    // Let go below the last row of a block, the row follows that row rather than
    // going to the end of a file-wide order the block does not show.
    const index=fromBlock?order.indexOf(last.rowId):-1
    return {beforeId:index<0?null:order[index+1]??null,lineY:last.y+last.height}
  })()
  return {...answer,spans:fromBlock?dropSpans({target,blocks,camera,order,rowId,beforeId:answer.beforeId}):null}
}

/** The blocks to mark, and where the row lands in each.
 *
 * The block being dragged into, and the blocks downstream of it that carry the
 * same sequence: a move is to one file-wide order, so the path this row takes
 * through the later blocks moves with it. Each is marked at its own gap, because
 * a compact block packs only the sequences it holds and the same position in the
 * order is a different height in each of them.
 */
function dropSpans({target,blocks,camera,order,rowId,beforeId}) {
  const rank=new Map(order.map((id,i)=>[id,i]))
  const limit=beforeId==null?Infinity:rank.get(beforeId)??Infinity
  const gapY=f=>{
    const top=rectOf(f,camera).y
    let last=-1
    for(let i=0;i<f.rowIds.length;i++){
      const id=f.rowIds[i]
      if(id===rowId)continue
      if((rank.get(id)??Infinity)>=limit)return top+rowSlot(f,i)*ROW_HEIGHT
      last=i
    }
    return top+(last<0?0:rowSlot(f,last)+1)*ROW_HEIGHT
  }
  return blocks
    .filter(f=>f.id===target.id||(f.sourceBlock>=target.sourceBlock&&rowId!=null&&f.rowIds.includes(rowId)))
    .map(f=>{const {x,width}=rectOf(f,camera);return {x,width,y:gapY(f),primary:f.id===target.id}})
}
