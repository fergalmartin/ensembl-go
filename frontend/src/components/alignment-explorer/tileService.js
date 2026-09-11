import { TileScheduler } from './tileScheduler.js'
import { createGapMemory, rememberGaps } from './gapMemory.js'

// Two recent datasets survive remounts; previews share the active dataset's
// budgets. Coarse reads have their own slot and cannot wait behind detail.
const datasets=new Map()
export function datasetTiles(id){
  if(datasets.has(id)){const service=datasets.get(id);datasets.delete(id);datasets.set(id,service);return service}
  const service={fine:new TileScheduler({concurrency:2,maxEntries:512,maxBytes:48*1024*1024}),coarse:new TileScheduler({concurrency:1,maxEntries:512,maxBytes:16*1024*1024}),gaps:createGapMemory(),users:0}
  service.ingest=value=>{rememberGaps(service.gaps,value.request.block,value.data);return value}
  datasets.set(id,service)
  for(const [key,old] of datasets){if(datasets.size<=2)break;if(old.users||key===id)continue;old.fine.clear();old.coarse.clear();datasets.delete(key)}
  return service
}
