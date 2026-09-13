import { getAssemblyAccession } from '../../utils/genomeIdentity.js'

export const assemblyToken = value => String(value || '').trim().toUpperCase()

export function genomeForAssembly(genomes, assembly) {
  const wanted=assemblyToken(assembly)
  return wanted ? (genomes||[]).find(genome=>assemblyToken(getAssemblyAccession(genome))===wanted) || null : null
}

export function genomeDisplayName(genome, fallback='') {
  return genome?.common_name||genome?.display_name||genome?.scientific_name||genome?.name||fallback
}

/** Resolve a link without ever serialising the application's internal genome
 * key. The public mapping remains portable; local/top-bar state is derived. */
export function classifyGenomeLink(row, topBarGenomes=[], localGenomes=[]) {
  const assembly=row?.metadata?.assembly||row?.assembly
  const regionName=row?.metadata?.region||row?.region
  const start=row?.metadata?.genomic_start,end=row?.metadata?.genomic_end
  const region=start&&end?`${regionName}:${Number(start).toLocaleString('en-GB')}-${Number(end).toLocaleString('en-GB')}`:regionName
  if(!assembly||!region)return {status:'unresolved',assembly,region,genome:null}
  const topbar=genomeForAssembly(topBarGenomes,assembly)
  if(topbar)return {status:'topbar',assembly,region,genome:topbar}
  const local=genomeForAssembly(localGenomes,assembly)
  if(local)return {status:'local',assembly,region,genome:local}
  return {status:'unavailable',assembly,region,genome:null}
}

/** Only assembly-qualified identifiers are automatic. Species resemblance is
 * insufficient evidence to project GFF coordinates into an alignment. */
export function exactGenomeLinks(rows,genomes) {
  const assemblies=new Map()
  for(const genome of genomes||[]){
    const accession=getAssemblyAccession(genome)
    if(accession&&!assemblies.has(assemblyToken(accession)))assemblies.set(assemblyToken(accession),accession)
  }
  const result=[]
  for(const row of rows||[]){
    if(row.metadata?.assembly)continue
    const source=String(row.source||'')
    const matches=[]
    for(const accession of assemblies.values()){
      if(source.startsWith(accession+'.')&&source.length>accession.length+1){
        matches.push({id:row.id,assembly:accession,region:source.slice(accession.length+1),strand:'+'})
      }
    }
    if(matches.length===1)result.push(matches[0])
  }
  return result
}
