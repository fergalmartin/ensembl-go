import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { API_BASE } from '../../backendRuntime'
import { api } from './data'
import { packModelIntervals } from './contextModelLayout'
import { FEATURE_COLORS } from '../FeatureLegend'
import { monoFont } from '../../utils/typography'
import { activePair, clampContext, CONTEXT_MAX_BP } from './detail'
import { trackWindow, pairScale, coordinateToX, xToCoordinate, blockCoverage, rulerStep, exonSegments } from './genomicContext'

const TRACK_HEIGHT = 86
const RULER_HEIGHT = 17
const MODEL_TOP = 30
const EXON_HEIGHT = 11

/** The same region, at its own scale and on its own coordinates.
 *
 * The alignment above answers "what lines up"; this answers "how long is it
 * really, and what is on either side". Both are needed to read an indel: an
 * exon that occupies the same shared columns as its neighbour's may be a
 * different length, and that only shows here.
 */
export default function BlockContextGenomic({ dataset, detail, rowsById, rowLabel, theme, onChange, onOpenGenome, height }) {
  const canvas = useRef(null), host = useRef(null)
  const [models, setModels] = useState({})
  const [width, setWidth] = useState(800)
  const light = theme === 'light'
  const pair = useMemo(() => activePair(detail), [detail])
  const [mapped, setMapped] = useState(null)
  const shown = useMemo(() => {
    if (pair) return pair
    const only = detail?.rows?.find(id => rowsById?.get(id)?.genomic)
    return only ? [only] : []
  }, [pair, detail, rowsById])
  const context = clampContext(detail?.genomic?.context)

  const projectionKey=detail.genomic?.columns&&dataset?.id?JSON.stringify({dataset:dataset.id,block:detail.sourceBlock,ids:shown,...detail.genomic.columns}):null
  useEffect(()=>{
    if(!projectionKey)return
    const controller=new AbortController()
    const {dataset:datasetId,...body}=JSON.parse(projectionKey)
    api(`/datasets/${datasetId}/block-context`,body,controller.signal).then(result=>{
      if(!controller.signal.aborted)setMapped({key:projectionKey,rows:result.rows})
    }).catch(error=>{if(error.name!=='AbortError')setMapped({key:projectionKey,error:error.message})})
    return()=>controller.abort()
  },[projectionKey])

  // What each track is centred on: the reader's selection where there is one,
  // otherwise the whole of what this row contributes to the block.
  const selections = useMemo(() => shown.map(id => {
    const chosen = detail?.genomic?.selection
    if (chosen?.[id]) return chosen[id]
    if(projectionKey){
      if(mapped?.key!==projectionKey)return null
      return mapped.rows?.find(row=>row.id===id)?.selection||null
    }
    return rowsById?.get(id)?.genomic || null
  }), [shown, detail, rowsById,projectionKey,mapped])

  const bpPerPx = pairScale(selections, context, Math.max(1, width))
  const windows = useMemo(() => selections.map(selection =>
    selection ? trackWindow(selection, context, Math.max(1, width), bpPerPx) : null), [selections, context, width, bpPerPx])

  useEffect(() => {
    const element = host.current
    if (!element) return
    const observer = new ResizeObserver(entries => setWidth(Math.max(120, Math.floor(entries[0].contentRect.width))))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Models come from the genome browser's own range endpoint, keyed by the bare
  // assembly accession the alignment link carries. One query per track window.
  const modelRequestKey=JSON.stringify(shown.map((id,index)=>{
    const row=rowsById?.get(id),view=windows[index]
    if(!view||!row?.assembly||!row?.region)return null
    return {id,assembly:row.assembly,region:row.region,start:Math.max(0,view.start),end:Math.min(row.source_length||Infinity,view.end)}
  }).filter(request=>request&&request.end>request.start))
  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    const load = async () => {
      const next = {}
      for (const request of JSON.parse(modelRequestKey)) {
        const {id:rowId,...row}=request,window_=request
        const key = modelRequestKey
        try {
          const url = `${API_BASE}/api/browse/canonical_transcripts?genome=${encodeURIComponent(row.assembly)}`
            + `&chrom=${encodeURIComponent(row.region)}&start=${window_.start + 1}&end=${window_.end}&limit=200`
          const response = await fetch(url, { signal: controller.signal })
          next[rowId] = { key, entries: response.ok ? await response.json() : [], failed: !response.ok }
        } catch (problem) {
          if (problem?.name !== 'AbortError') next[rowId] = { key, entries: [], failed: true }
        }
      }
      if (!cancelled) setModels(next)
    }
    load()
    return () => { cancelled = true; controller.abort() }
  }, [modelRequestKey])

  const trackLayouts=shown.map(rowId=>{
    const entries=models[rowId]?.key===modelRequestKey?models[rowId].entries:[]
    const layout=packModelIntervals(entries.map(entry=>({entry,id:entry.transcript.id,start:entry.transcript.start-1,end:entry.transcript.end})))
    return {...layout,height:Math.max(TRACK_HEIGHT,MODEL_TOP+Math.min(12,layout.count)*28+24)}
  })
  const trackTops=trackLayouts.map((_,index)=>trackLayouts.slice(0,index).reduce((sum,t)=>sum+t.height,0))
  const paint = useCallback(() => {
    const element = canvas.current
    if (!element) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const total = Math.max(TRACK_HEIGHT, trackLayouts.reduce((sum,t)=>sum+t.height,0))
    if (element.width !== Math.floor(width * dpr) || element.height !== Math.floor(total * dpr)) {
      element.width = Math.floor(width * dpr); element.height = Math.floor(total * dpr)
    }
    element.style.height = `${total}px`
    const ctx = element.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const colors = light
      ? { background: '#f6f8fb', panel: '#fff', text: '#27394c', muted: '#738196', border: '#cbd5e1', outside: '#e6ebf2' }
      : { background: '#152032', panel: '#1c293d', text: '#e3eaf4', muted: '#8f9fb3', border: '#3a4d65', outside: '#101a29' }
    ctx.fillStyle = colors.background; ctx.fillRect(0, 0, width, total)
    shown.forEach((rowId, index) => {
      const window_ = windows[index], row = rowsById?.get(rowId)
      const top = trackTops[index],trackHeight=trackLayouts[index].height
      if (!window_ || !row) {
        ctx.fillStyle=colors.muted;ctx.font='11px Lato, sans-serif'
        ctx.fillText(`${rowLabel(rowId)} · ${projectionKey&&mapped?.key!==projectionKey?'Mapping selection…':mapped?.error||'No genomic bases mapped for this selection'}`,6,top+30)
        return
      }
      ctx.save();ctx.beginPath();ctx.rect(0,top,width,trackHeight);ctx.clip()
      const reverse = row.strand === '-'
      const x = coordinate => coordinateToX(coordinate, window_, width, reverse)
      // What the block covers, and what it does not. The shading says "the
      // alignment has nothing to say here", never "nothing is here".
      const coverage = blockCoverage(window_, row.genomic)
      ctx.fillStyle = colors.panel; ctx.fillRect(0, top, width, trackHeight - 1)
      for (const outside of [coverage.before, coverage.after]) {
        if (!outside) continue
        const a = x(outside.start), b = x(outside.end)
        ctx.fillStyle = colors.outside; ctx.fillRect(Math.min(a, b), top, Math.abs(b - a), trackHeight - 1)
      }
      if (coverage.inside) {
        const a = x(coverage.inside.start), b = x(coverage.inside.end)
        ctx.strokeStyle = FEATURE_COLORS.genomic?.bg || '#60a5fa'; ctx.lineWidth = 1
        ctx.strokeRect(Math.min(a, b) + .5, top + .5, Math.abs(b - a) - 1, trackHeight - 2)
      }
      // Ruler. Coordinates count down on a reverse-aligned row, and an arrow
      // says which way they run rather than leaving it to be inferred.
      const step = rulerStep(bpPerPx)
      ctx.fillStyle = colors.muted; ctx.font = monoFont(9); ctx.textAlign = 'left'
      for (let tick = Math.ceil(window_.start / step) * step; tick < window_.end; tick += step) {
        const tx = x(tick)
        ctx.fillRect(tx, top + RULER_HEIGHT - 4, 1, 4)
        ctx.fillText((tick+1).toLocaleString(), tx + 3, top + RULER_HEIGHT - 6)
      }
      ctx.fillStyle = colors.text; ctx.font = '10px Lato, sans-serif'
      const name = `${rowLabel(rowId)} · ${row.region}${reverse ? ' ◀ coordinates decrease' : ' ▶ coordinates increase'}`
      ctx.fillText(name, 4, top + trackHeight - 6)
      // Gene models, at their real lengths.
      for (const {entry,lane} of trackLayouts[index].items.filter(item=>item.lane<12)) {
        const transcript = entry.transcript
        const modelTop = top + MODEL_TOP + lane * 28
        const a = x(transcript.start - 1), b = x(transcript.end)
        ctx.fillStyle = colors.border
        ctx.fillRect(Math.min(a, b), modelTop + EXON_HEIGHT / 2, Math.abs(b - a), 1)
        // The gene's own strand, which is not the alignment row's: an arrow per
        // model rather than one for the track.
        const forward = (transcript.strand || '+') === '+'
        const pointRight = forward !== reverse
        ctx.fillStyle = colors.muted
        for (let mark = Math.max(0,Math.min(a,b)) + 14; mark < Math.min(width,Math.max(a,b)) - 4; mark += 34) {
          ctx.beginPath()
          ctx.moveTo(mark, modelTop + 2); ctx.lineTo(mark + (pointRight ? 4 : -4), modelTop + EXON_HEIGHT / 2)
          ctx.lineTo(mark, modelTop + EXON_HEIGHT - 2); ctx.stroke()
        }
        for (const exon of transcript.exons || []) {
          for (const segment of exonSegments(exon.start - 1, exon.end, transcript.cds_list)) {
            const sa = x(segment.start), sb = x(segment.end)
            const left = Math.min(sa, sb), pieceWidth = Math.max(1, Math.abs(sb - sa))
            if (segment.coding) { ctx.fillStyle = FEATURE_COLORS.cds?.bg || '#60a5fa'; ctx.fillRect(left, modelTop, pieceWidth, EXON_HEIGHT) }
            else {
              ctx.fillStyle = colors.panel; ctx.fillRect(left, modelTop, pieceWidth, EXON_HEIGHT)
              ctx.strokeStyle = FEATURE_COLORS.utr5?.bg || '#c4b5fd'; ctx.lineWidth = 1
              ctx.strokeRect(left + .5, modelTop + .5, Math.max(1, pieceWidth - 1), EXON_HEIGHT - 1)
            }
          }
        }
        if (Math.abs(b - a) > 48) {
          ctx.fillStyle = colors.text; ctx.font = monoFont(9); ctx.textAlign = 'left'
          const left=Math.max(0,Math.min(a,b)),right=Math.min(width,Math.max(a,b))
          ctx.save();ctx.beginPath();ctx.rect(left,modelTop-12,Math.max(0,right-left),12);ctx.clip()
          ctx.fillText(entry.gene?.name || entry.gene?.id || '', left + 2, modelTop - 2);ctx.restore()
        }
      }
      if (models[rowId]?.key===modelRequestKey&&models[rowId]?.failed) {
        ctx.fillStyle = colors.muted; ctx.font = '10px Lato, sans-serif'
        ctx.fillText('Annotation could not be read for this genome.', 6, top + MODEL_TOP + 10)
      }
      if(trackLayouts[index].count>12){ctx.fillStyle=colors.muted;ctx.fillText('Additional overlapping models omitted; narrow the region.',6,top+trackHeight-18)}
      ctx.restore()
    })
  }, [shown, windows, models, rowsById, rowLabel, width, bpPerPx, light,trackLayouts,trackTops,modelRequestKey,projectionKey,mapped])
  useEffect(paint, [paint])

  const setContext = value => onChange(d => ({ ...d, genomic: { ...d.genomic, context: clampContext(value) } }))
  const select = (event, index) => {
    const rowId = shown[index], window_ = windows[index], row = rowsById?.get(rowId)
    if (!window_ || !row) return
    const rect = canvas.current.getBoundingClientRect()
    const at = xToCoordinate(event.clientX - rect.left, window_, width, row.strand === '-')
    onChange(d => ({ ...d, genomic: { ...d.genomic, selection: { ...(d.genomic?.selection || {}), [rowId]: { start: at - 500, end: at + 500 } } } }))
  }

  return <div className="al-genomic" ref={host} style={height ? { height } : undefined}>
    <div className="al-genomic-bar">
      <strong>Genomic context</strong>
      <small>{pair ? `${rowLabel(pair[0])} and ${rowLabel(pair[1])}` : shown.length ? rowLabel(shown[0]) : 'No placed row to show'}</small>
      <label>Context
        <input type="number" min={0} max={CONTEXT_MAX_BP} step={500} value={context}
          aria-label="Genomic context either side, in bases"
          onChange={e => setContext(e.target.value)} /> bp
      </label>
      <small>{Math.round(bpPerPx * 100) / 100} bp per pixel, the same on both tracks</small>
      <span className="al-genomic-spacer" />
      <button onClick={() => onChange(d => ({ ...d, genomic: { ...d.genomic, selection: null, columns: null } }))}>Fit block</button>
      {!!onOpenGenome && <button onClick={() => onOpenGenome(shown,Object.fromEntries(shown.map((id,index)=>[id,windows[index]])))}>Open Genome Browser</button>}
      <button aria-label="Close genomic context" onClick={() => onChange(d => ({ ...d, genomic: { ...d.genomic, open: false } }))}>×</button>
    </div>
    <div className="al-genomic-tracks">
      <canvas ref={canvas} style={{ width: '100%' }} onClick={e => {
        const rect = canvas.current.getBoundingClientRect()
        select(e, trackTops.findIndex((top,index)=>e.clientY-rect.top>=top&&e.clientY-rect.top<top+trackLayouts[index].height))
      }} />
    </div>
    <p className="al-context-note">
      Shading marks regions outside this alignment block. Click a genomic track to centre it independently; select a feature above to map both tracks.
    </p>
  </div>
}
