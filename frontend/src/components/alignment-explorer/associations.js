import { getGenomeKey, genomeKeyCandidates } from '../../utils/genomeIdentity.js'

/** Only assembly-qualified identifiers are automatic. Species resemblance is
 * insufficient evidence to project GFF coordinates into an alignment. */
export function exactGenomeLinks(rows,genomes) {
  const result=[]
  for(const row of rows){
    if(row.metadata?.genome_key)continue
    const matches=[]
    for(const genome of genomes){
      const candidates=[...genomeKeyCandidates(genome),genome.assembly,genome.gca].filter(Boolean)
      for(const candidate of candidates){
        if(row.source===candidate||row.source.startsWith(candidate+'.')){
          matches.push({id:row.id,genome_key:getGenomeKey(genome),chrom:row.metadata?.chrom||(row.source===candidate?'':row.source.slice(candidate.length+1)),assembly:genome.assembly||genome.gca,association:'exact_identifier'});break
        }
      }
    }
    if(matches.length===1)result.push(matches[0])
  }
  return result
}
