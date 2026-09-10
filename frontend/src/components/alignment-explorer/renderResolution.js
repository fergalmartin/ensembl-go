const summaries=new WeakMap()
/** Cached detail can become a valid summary immediately, without drawing
 * thousands of subpixel letters or switching back to stripes while fetching. */
export function renderResolution(data,scale) {
  if(!data?.detail||scale>=.65)return data
  const step=2**Math.ceil(Math.log2(4/Math.max(Number.EPSILON,scale)))
  let levels=summaries.get(data)
  if(!levels){levels=new Map();summaries.set(data,levels)}
  if(levels.has(step))return levels.get(step)
  const reference=(data.focus?data.rows.find(row=>row.id===data.focus)?.sequence:data.rows[0]?.sequence)||''
  const canonical=base=>base==='A'||base==='C'||base==='G'||base==='T'
  const rows=data.rows.map(row=>{
    if(!row.sequence)return {...row,sequence:null,bins:[],divergence_bins:[]}
    const bins=[],divergence_bins=[]
    for(let start=0;start<row.sequence.length;start+=step){
      const bin={};let comparable=0,different=0
      for(let i=start;i<Math.min(row.sequence.length,start+step);i++){
        const base=row.sequence[i],ref=reference[i];bin[base]=(bin[base]||0)+1
        if(canonical(base)&&canonical(ref)){comparable++;if(base!==ref)different++}
      }
      bins.push(bin);divergence_bins.push({comparable,different,fraction:comparable?different/comparable:null})
    }
    return {...row,sequence:null,bins,divergence_bins}
  })
  const result={...data,rows,detail:false,bin_size:step}
  levels.set(step,result);while(levels.size>2)levels.delete(levels.keys().next().value)
  return result
}
