function covered(start,end,intervals){
  let cursor=start
  for(const [a,z] of [...intervals].sort((a,b)=>a[0]-b[0])){if(z<=cursor)continue;if(a>cursor)return false;cursor=Math.max(cursor,z);if(cursor>=end)return true}
  return cursor>=end
}
/** Keep an older representation until its whole interval has replacement layout.
 * Same-resolution pages are unioned; incompatible grouped layouts never overlap. */
export function layoutCoverage(values,start,end,mode){
  const candidates=values.filter(v=>v.blocks.some(b=>b.end_x>start&&b.x<end))
  const target=candidates.filter(v=>v.mode===mode)
  const intervals=target.map(v=>[v.cover_start??v.start,v.cover_end??v.end])
  const retained=new Map()
  for(const value of candidates.filter(v=>v.mode!==mode).reverse())for(const block of value.blocks){
    if(block.end_x<=start||block.x>=end||covered(Math.max(start,block.x),Math.min(end,block.end_x),intervals))continue
    if([...retained.values()].some(b=>b.x<block.end_x&&b.end_x>block.x))continue
    retained.set(block.block,block)
  }
  const records=new Map(retained)
  for(const value of target)for(const block of value.blocks){
    if(block.end_x<=start||block.x>=end||[...retained.values()].some(b=>b.x<block.end_x&&b.end_x>block.x))continue
    records.set(block.block,block)
  }
  return [...records.values()].sort((a,b)=>a.x-b.x)
}
