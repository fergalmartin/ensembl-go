/** A viewport is ready only when every requested chunk and row is covered. */
export function viewportCovered(tiles,requests) {
  return requests.every(({id,request})=>{
    const data=tiles[id]?.data
    return data&&data.start<=request.start&&data.end>=request.end&&request.ids.every(id=>data.rows.some(r=>r.id===id))&&(!request.summary||!data.detail)
  })
}
/** Camera state is independent of tile readiness. Cached data is reprojected
 * at the requested position; an earlier block can never take over navigation. */
export function transitionCamera(_layerId,camera,_ready,_covered) {
  return camera
}
