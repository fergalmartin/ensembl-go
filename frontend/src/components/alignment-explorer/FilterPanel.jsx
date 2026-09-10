import { useEffect, useMemo, useState } from 'react'
import { api } from './data'
import FilterGrid from './FilterGrid'
import { SEQUENCE_FILTER, BLOCK_FILTER, filterSequences, filterBlocks, effectiveChoice, filterChunks, rangeChunks, isDefaultFilter } from './filters'

const number = value => (value ?? 0).toLocaleString()

function Range({label,unit,from,to,onFrom,onTo}) {
  return <label className="al-filter-range"><span>{label}{unit?<small> {unit}</small>:null}</span>
    <input type="number" min="0" placeholder="min" value={from} onChange={e=>onFrom(e.target.value)}/>
    <input type="number" min="0" placeholder="max" value={to} onChange={e=>onTo(e.target.value)}/>
  </label>
}

/** Filter the alignment down to a working set of sequences and blocks.
 *
 * The two lists are not independent: narrowing sequences narrows the blocks on
 * offer to the ones that actually hold them, which is what makes "these eight
 * primates, wherever they appear" a single move rather than a manual hunt
 * through two hundred blocks. Block criteria still apply on top, so the reader
 * can say "those sequences, but only in blocks over 100kb".
 */
export default function FilterPanel({dataset,genomes,onClose,onNewLayer,onApplyToOriginal,filterApplied,onClearFilter,onError}) {
  const [tab,setTab]=useState('sequences'),[wide,setWide]=useState(false)
  const [summary,setSummary]=useState(null)
  const [sequenceFilter,setSequenceFilter]=useState(SEQUENCE_FILTER)
  const [blockFilter,setBlockFilter]=useState(BLOCK_FILTER)
  const [chosenSequences,setChosenSequences]=useState(new Set())
  const [chosenBlocks,setChosenBlocks]=useState(new Set())
  const [membership,setMembership]=useState(null)
  const [range,setRange]=useState({start:'',end:''})
  const [ranged,setRanged]=useState(null)

  useEffect(()=>{
    if(!dataset)return
    let cancelled=false
    api(`/datasets/${dataset.id}/summary`).then(value=>{if(!cancelled)setSummary(value)})
      .catch(e=>{if(!cancelled)onError(e.message)})
    return()=>{cancelled=true}
  },[dataset,onError])

  const sequences=useMemo(()=>filterSequences(summary?.sequences||[],sequenceFilter),[summary,sequenceFilter])
  const chosenSequenceIds=useMemo(()=>effectiveChoice(sequences,chosenSequences),[sequences,chosenSequences])
  const narrowed=!isDefaultFilter(sequenceFilter,SEQUENCE_FILTER)||chosenSequences.size>0

  // Which blocks hold the chosen sequences. Asked for only while the sequence
  // side is actually narrowing something, so the untouched panel costs nothing.
  const wanted=dataset&&narrowed&&chosenSequenceIds.length?chosenSequenceIds:null
  useEffect(()=>{
    if(!wanted)return
    let cancelled=false
    api(`/datasets/${dataset.id}/blocks-with`,{ids:wanted.slice(0,5000)})
      .then(value=>{if(!cancelled)setMembership({for:wanted,blocks:value.blocks})})
      .catch(e=>{if(!cancelled)onError(e.message)})
    return()=>{cancelled=true}
  },[dataset,wanted,onError])
  // Only the answer to the current selection counts; an older one is ignored
  // rather than briefly narrowing the block list by the wrong sequences.
  const known=membership?.for===wanted?membership.blocks:null

  // A genomic interval is read in each chosen sequence's own coordinates, so it
  // is only asked for once a bounded set of sequences has been chosen.
  const interval=useMemo(()=>{
    const from=Number(range.start),to=Number(range.end)
    if(range.start===''||range.end===''||!Number.isFinite(from)||!Number.isFinite(to)||to<from)return null
    if(!chosenSequenceIds.length||chosenSequenceIds.length>200)return null
    return {ids:chosenSequenceIds,start:Math.max(0,from-1),end:to}
  },[range,chosenSequenceIds])
  useEffect(()=>{
    if(!dataset||!interval)return
    let cancelled=false
    api(`/datasets/${dataset.id}/blocks-in-range`,interval)
      .then(value=>{if(!cancelled)setRanged({for:interval,matches:value.matches})})
      .catch(e=>{if(!cancelled)onError(e.message)})
    return()=>{cancelled=true}
  },[dataset,interval,onError])
  const matches=ranged?.for===interval?ranged.matches:null

  const within=useMemo(()=>{
    const byMembership=known?new Set(known.map(m=>m.block)):null
    if(!matches)return byMembership
    const byRange=new Set(matches.map(m=>m.block))
    return byMembership?new Set([...byRange].filter(b=>byMembership.has(b))):byRange
  },[known,matches])
  const blocks=useMemo(()=>filterBlocks(summary?.blocks||[],blockFilter,within),[summary,blockFilter,within])
  const chosenBlockIds=useMemo(()=>effectiveChoice(blocks,chosenBlocks),[blocks,chosenBlocks])
  const lengths=useMemo(()=>new Map((summary?.blocks||[]).map(b=>[b.id,b.length])),[summary])
  const chunks=useMemo(()=>matches?rangeChunks(matches,chosenBlockIds):filterChunks(known,chosenBlockIds,chosenSequenceIds,lengths),
    [matches,known,chosenBlockIds,chosenSequenceIds,lengths])
  const cells=chunks.reduce((n,c)=>n+(c.end-c.start)*c.rowIds.length,0)

  const genomeLabel=key=>{
    if(!key)return null
    const match=genomes.find(g=>[g.species_key,g.assembly,g.name].includes(key))
    return match?.common_name||match?.scientific_name||key
  }

  const sequenceColumns=useMemo(()=>[
    {key:'name',title:'Sequence',width:'minmax(150px,2fr)',value:s=>s.label||s.source},
    {key:'blocks',title:'Blocks',width:'70px',numeric:true,value:s=>s.blocks||0,render:s=>number(s.blocks)},
    {key:'columns',title:'Columns',width:'104px',numeric:true,value:s=>s.columns||0,render:s=>number(s.columns)},
    {key:'bases',title:'Bases',width:'104px',numeric:true,value:s=>s.bases||0,
      render:s=>s.placed?number(s.bases):'—'},
    {key:'absent',title:'Absent',width:'70px',numeric:true,value:s=>s.empty||0,render:s=>s.empty?number(s.empty):'—'},
    {key:'genome',title:'Local genome',width:'minmax(110px,1fr)',value:s=>genomeLabel(s.genome_key)||'',
      render:s=>s.genome_key?`${genomeLabel(s.genome_key)}${s.chrom?` · ${s.chrom}`:''}`:'—'},
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ],[genomes])
  const blockColumns=useMemo(()=>[
    {key:'block',title:'Block',width:'80px',numeric:true,value:b=>b.id,render:b=>`Block ${b.id}`},
    {key:'length',title:'Columns',width:'110px',numeric:true,value:b=>b.length||0,render:b=>number(b.length)},
    {key:'rows',title:'Sequences',width:'90px',numeric:true,value:b=>b.available||0,render:b=>number(b.available)},
    {key:'absent',title:'Absent',width:'70px',numeric:true,value:b=>(b.rows||0)-(b.available||0),
      render:b=>b.rows>b.available?number(b.rows-b.available):'—'},
  ],[])
  const ready=!!summary

  return <aside className={`al-filter ${wide?"wide":""}`} aria-label="Filter sequences and blocks">
    <div className="al-filter-head">
      <strong>Filter</strong>
      <div className="al-filter-tabs" role="tablist">
        <button role="tab" aria-selected={tab==='sequences'} className={tab==='sequences'?'selected':''} onClick={()=>setTab('sequences')}>Sequences</button>
        <button role="tab" aria-selected={tab==='blocks'} className={tab==='blocks'?'selected':''} onClick={()=>setTab('blocks')}>Blocks</button>
      </div>
      <button aria-pressed={wide} title={wide?'Narrow the panel':'Expand to the full grid'} onClick={()=>setWide(v=>!v)}>{wide?'⇤':'⇥'}</button>
      <button className="al-close" aria-label="Close filter" onClick={onClose}>×</button>
    </div>

    {!ready&&<p className="al-hint">Reading the alignment inventory…</p>}
    {ready&&summary.truncated?.sequences&&<p className="al-hint">Showing the first {number(summary.sequences.length)} of {number(summary.total.sequences)} sequences.</p>}

    {ready&&tab==='sequences'&&<div className="al-filter-body">
      <div className="al-filter-controls">
      <label>Include <small>any of these words</small>
        <input placeholder="human gorilla" value={sequenceFilter.include} onChange={e=>setSequenceFilter({...sequenceFilter,include:e.target.value})}/></label>
      <label>Exclude <small>none of these words</small>
        <input placeholder="ancestor" value={sequenceFilter.exclude} onChange={e=>setSequenceFilter({...sequenceFilter,exclude:e.target.value})}/></label>
      <label>Local genome
        <select value={sequenceFilter.genome} onChange={e=>setSequenceFilter({...sequenceFilter,genome:e.target.value})}>
          <option value="any">Linked or not</option><option value="linked">Linked only</option><option value="unlinked">Not linked</option>
        </select></label>
      <Range label="Blocks" from={sequenceFilter.minBlocks} to={sequenceFilter.maxBlocks}
        onFrom={v=>setSequenceFilter({...sequenceFilter,minBlocks:v})} onTo={v=>setSequenceFilter({...sequenceFilter,maxBlocks:v})}/>
      <Range label="Aligned bases" from={sequenceFilter.minBases} to={sequenceFilter.maxBases}
        onFrom={v=>setSequenceFilter({...sequenceFilter,minBases:v})} onTo={v=>setSequenceFilter({...sequenceFilter,maxBases:v})}/>
      <div className="al-filter-actions">
        <span>{number(sequences.length)} of {number(summary.sequences.length)} match</span>
        <button onClick={()=>setChosenSequences(new Set(sequences.map(s=>s.id)))}>Tick all shown</button>
        <button disabled={!chosenSequences.size} onClick={()=>setChosenSequences(new Set())}>Untick all</button>
      </div>
      </div>
      <FilterGrid rows={sequences} columns={sequenceColumns} rowKey={s=>s.id} chosen={chosenSequences}
        onChosen={setChosenSequences} label="Sequences" empty="Nothing matches these words."/>
    </div>}

    {ready&&tab==='blocks'&&<div className="al-filter-body">
      <div className="al-filter-controls">
      {within&&<p className="al-hint">Limited to the {number(within.size)} blocks holding the {number(chosenSequenceIds.length)} chosen sequences.</p>}
      <div className="al-filter-coords">
        <span>Genomic range <small>in each chosen sequence's own coordinates, 1-based</small></span>
        <div className="al-filter-range">
          <span/>
          <input type="number" min="1" placeholder="from" value={range.start} onChange={e=>setRange({...range,start:e.target.value})}/>
          <input type="number" min="1" placeholder="to" value={range.end} onChange={e=>setRange({...range,end:e.target.value})}/>
        </div>
        {chosenSequenceIds.length>200&&<small className="al-hint">Narrow to 200 sequences or fewer to filter on coordinates.</small>}
        {matches&&<small className="al-hint">{number(matches.length)} rows overlap, in {number(new Set(matches.map(m=>m.block)).size)} blocks. A layer takes just the overlapping columns.</small>}
        {interval&&!matches&&<small className="al-hint">Looking up the interval…</small>}
      </div>
      <label>Block numbers <small>e.g. 1-20, 44, 60-70</small>
        <input placeholder="all" value={blockFilter.numbers} onChange={e=>setBlockFilter({...blockFilter,numbers:e.target.value})}/></label>
      <Range label="Columns" from={blockFilter.minLength} to={blockFilter.maxLength}
        onFrom={v=>setBlockFilter({...blockFilter,minLength:v})} onTo={v=>setBlockFilter({...blockFilter,maxLength:v})}/>
      <Range label="Sequences in block" from={blockFilter.minRows} to={blockFilter.maxRows}
        onFrom={v=>setBlockFilter({...blockFilter,minRows:v})} onTo={v=>setBlockFilter({...blockFilter,maxRows:v})}/>
      <div className="al-filter-actions">
        <span>{number(blocks.length)} of {number(summary.blocks.length)} match</span>
        <button onClick={()=>setChosenBlocks(new Set(blocks.map(b=>b.id)))}>Tick all shown</button>
        <button disabled={!chosenBlocks.size} onClick={()=>setChosenBlocks(new Set())}>Untick all</button>
      </div>
      </div>
      <FilterGrid rows={blocks} columns={blockColumns} rowKey={b=>b.id} chosen={chosenBlocks}
        onChosen={setChosenBlocks} label="Blocks" empty="No blocks match."/>
    </div>}

    {ready&&<div className="al-filter-foot">
      <strong>{number(chosenSequenceIds.length)} sequences · {number(chosenBlockIds.length)} blocks</strong>
      {chunks.length?<small>{number(chunks.length)} chunks · {number(cells)} cells</small>
        :<small>Narrow the sequences to build a layer from the result.</small>}
      <button className="primary" disabled={!chunks.length} onClick={()=>onNewLayer(chunks)}>New layer from filter</button>
      <button onClick={()=>onApplyToOriginal({sequences:chosenSequenceIds,blocks:chosenBlockIds})}>Show only these in Original</button>
      {filterApplied&&<button onClick={onClearFilter}>Clear filter from Original</button>}
    </div>}
  </aside>
}
