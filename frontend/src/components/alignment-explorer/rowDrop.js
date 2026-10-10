import { panelGeometry, rowSlot } from './layers.js'
import { MARGIN_X, MARGIN_Y, ROW_HEIGHT } from './layout.js'

const rectOf=(f,camera)=>({...panelGeometry(f,camera,MARGIN_X),y:MARGIN_Y+f.y*ROW_HEIGHT-camera.y})

/**
 * Resolve row insertion from the block being targeted.
 * Compact blocks use their own visible rows; aligned blocks use the gutter's
 * file-wide slots, including empty ones. A dragged jump marker targets its
 * destination block, falling back to its source if the destination is unloaded.
 * Horizontal pointer movement must not switch that target.
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
