import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getGenomeKey, genomeKeyCandidates, genomeKeyDisplayLabels } from '../../utils/genomeIdentity'
import DrawerChevron from '../DrawerChevron'
import FeatureLegend from '../FeatureLegend'
import LayerCanvas from './LayerCanvas'
import LayerCycle from './LayerCycle'
import { layoutOriginal } from './originalLayout'
import useOriginalBlocks from './useOriginalBlocks'
import useLayerData from './useLayerData'
import { exactGenomeLinks } from './associations'
import { api, download, demoAlignment } from './data'
import { emptyWorkspace, createLayer, createFragment, moveSelection, mergeLayers, layerOverlap, tidyLayer, fitCamera, validateLayerWorkspace, constrainCamera, chunkGap, chunkFasta, sourceViewAnchor, workspaceForSave, coordinateFragments, visibleSourceRange } from './layers'
import { NUCLEOTIDE_COLORS, NUCLEOTIDE_LETTER_THRESHOLD } from '../../utils/nucleotideStyle'
import './explorer.css'

export default function AlignmentExplorerView({theme='dark',config,genomes=[],incoming,onIncomingConsumed}) {
  const [dataset,setDataset]=useState(null),[inventory,setInventory]=useState([]),[blocks,setBlocks]=useState({blocks:[],total:0}),[source,setSource]=useState(null)
  const [state,setState]=useState(emptyWorkspace),[size,setSize]=useState({width:900,height:500}),[job,setJob]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
  const [dialog,setDialog]=useState(null),[path,setPath]=useState(''),[merge,setMerge]=useState(null),[layerName,setLayerName]=useState(''),[target,setTarget]=useState('new'),[inspect,setInspect]=useState(null),[fallback,setFallback]=useState(false),[revision,setRevision]=useState(0)
  const [selectionDrag,setSelectionDrag]=useState(null)
  const explorerRoot=useRef(null)
  const [rowQuery,setRowQuery]=useState(''),[selectRows,setSelectRows]=useState([]),[range,setRange]=useState({fragment:'',start:1,end:100}),[link,setLink]=useState({row:'',genome:'',chrom:''})
  const history=useRef({past:[],future:[]}),stateRef=useRef(state),canvas=useRef(null),file=useRef(null),metadata=useRef(null),workspace=useRef(null),epoch=useRef(0),blockNav=useRef(0),incomingHandled=useRef(null),genomesRef=useRef(genomes)
  genomesRef.current=genomes
  stateRef.current=state
  const patch=useCallback(value=>setState(s=>({...s,...value})),[])
  const commit=useCallback(fn=>{const prev=stateRef.current,next=typeof fn==='function'?fn(prev):{...prev,...fn};if(next===prev)return;history.current.past.push(prev);history.current.past=history.current.past.slice(-50);history.current.future=[];stateRef.current=next;setState(next)},[])
  const undo=useCallback(redo=>{const from=redo?history.current.future:history.current.past,to=redo?history.current.past:history.current.future;if(from.length){to.push(stateRef.current);const next=from.pop();stateRef.current=next;setState(next)}},[])
  
  const sourceFragments=useOriginalBlocks(dataset,source,state.camera,size,blocks.total,state.original,setError,revision)
  const originalFragments=useMemo(()=>layoutOriginal(sourceFragments,inventory.map(r=>r.id),state.originalRows||'aligned',state.blockRows||{},dataset?.max_source_rows),[sourceFragments,inventory,state.originalRows,state.blockRows,dataset?.max_source_rows])
  const original=useMemo(()=>({id:'original',name:'Original alignment',color:'#b9c5d9',fragments:originalFragments,rowExtent:Math.max(inventory.length,2*(dataset?.max_source_rows||0)+3),extent:dataset?.layout_end||source?.layout_end||source?.length||1}),[originalFragments,dataset?.layout_end,source?.layout_end,source?.length,inventory.length,dataset?.max_source_rows])
  const allLayers=useMemo(()=>[original,...state.layers],[original,state.layers])
  const active=state.original?original:state.layers.find(l=>l.id===state.active)||original
  const layer=active
  const camera=useCallback(value=>setState(s=>{const bounded=constrainCamera(s.original?original:s.layers.find(l=>l.id===s.active)||original,value,size);return {...s,camera:bounded,layers:s.layers.map(l=>l.id===s.active&&!s.original?{...l,camera:bounded}:l)}}),[original,size])
  const renderState=useMemo(()=>({...state,original:layer.id==='original',camera:constrainCamera(layer,state.camera,size),placedOverlay:state.original&&state.overlay?state.layers.flatMap(l=>l.fragments.map(f=>({...f,color:l.color,name:l.name}))):[]}),[state,layer,size])
  const {tiles,annotations,connections,offWindow,counts,pending,warnings,gaps,displayCamera}=useLayerData(dataset,layer,renderState.camera,size,state.annotations,revision,setError)
  const canvasState=useMemo(()=>({...renderState,camera:displayCamera}),[renderState,displayCamera])
  const ids=useMemo(()=>inventory.map(r=>r.id),[inventory])
  const displayInventory=useMemo(()=>inventory.map(row=>{
    const key=row.metadata?.genome_key
    if(!key)return row
    const genome=genomes.find(g=>genomeKeyCandidates(g).includes(key)),fallback=genomeKeyDisplayLabels(key)
    const name=genome?.common_name||genome?.scientific_name||fallback.displayName
    const label=row.label===key?genome?.assembly_name||fallback.displayAssembly:row.label
    return {...row,label:`${name} · ${label}`}
  }),[inventory,genomes])
  const switchLayer=useCallback(id=>{setInspect(null);setState(s=>({...s,original:id==='original',active:id==='original'?s.active:id,selection:[],camera:id==='original'?fitCamera({fragments:original.fragments.filter(f=>f.sourceBlock===s.sourceBlock&&!f.aggregate).slice(0,1)},size.width,size.height):s.layers.find(l=>l.id===id)?.camera||s.camera}))},[original,size])
  const fit=()=>camera(fitCamera(state.original?{fragments:[sourceViewAnchor(originalFragments,state.camera)].filter(Boolean)}:active,size.width,size.height))

  const load=useCallback(async id=>{
    const token=++epoch.current;setBusy(true);setError('')
    try {
      const data=await api(`/datasets/${id}`),rows=[]
      for(let offset=0;;offset+=5000){const page=await api(`/datasets/${id}/sequences?offset=${offset}&limit=5000`);rows.push(...page.rows);if(rows.length>=page.total)break}
      const links=exactGenomeLinks(rows,genomesRef.current)
      if(links.length){await api(`/datasets/${id}/metadata`,{entries:links});for(const entry of links){const row=rows.find(r=>r.id===entry.id);row.metadata={...row.metadata,...entry}}}
      const blockList=await api(`/datasets/${id}/blocks`)
      if(!blockList.blocks.length)throw new Error('This dataset has no alignment blocks. Open a MAF or aligned FASTA to explore layers.')
      let saved;try{saved=JSON.parse(localStorage.getItem(`alignment-layers:${id}`)||'null')}catch{/* local storage is optional */}
      if(!saved)saved=await api(`/datasets/${id}/workspace?version=2`)
      let next=saved?validateLayerWorkspace(saved,rows.map(r=>r.id)):emptyWorkspace()
      const first=await api(`/datasets/${id}/blocks/${next.sourceBlock||blockList.blocks[0].id}/rows`)
      if(!saved){const fragment=createFragment(first.block,0,first.length,first.rows.map(r=>r.id),{x:first.layout_start||0});next={...next,original:true,sourceBlock:first.block,camera:fitCamera({fragments:[fragment]},900,500)}}
      else if(next.original)next={...next,camera:{...next.camera,x:next.camera.x+(first.layout_start||0)}}
      if(token!==epoch.current)return
      // A block jump still in flight belongs to the previous dataset.
      blockNav.current++
      history.current={past:[],future:[]};setDataset(data);setInventory(rows);setBlocks(blockList);setSource(first);setState(next);setDialog(null);setInspect(null);setNotice('');setRevision(v=>v+1)
      try{localStorage.setItem('alignment-layers:last',id)}catch{/* optional */}
    }catch(e){if(token===epoch.current)setError(e.message)}finally{if(token===epoch.current)setBusy(false)}
  },[])
  const startImport=useCallback(async payload=>{
    setBusy(true);setError('')
    try{const result=await api('/datasets',payload);if(result.status==='ready')await load(result.dataset_id);else setJob(result)}catch(e){setError(e.message)}finally{setBusy(false)}
  },[load])
  useEffect(()=>{
    if(incoming&&incomingHandled.current!==incoming){incomingHandled.current=incoming;startImport({name:'MAFFT alignment',rows:incoming.rows});onIncomingConsumed?.()}
  },[incoming,onIncomingConsumed,startImport])
  useEffect(()=>{
    if(incoming)return
    try{const last=localStorage.getItem('alignment-layers:last');if(last)load(last)}catch{/* optional */}
    // Restore only once; later imports explicitly replace the dataset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[])
  useEffect(()=>{
    if(!job||!['queued','running'].includes(job.status))return
    const controller=new AbortController(),timer=setTimeout(async()=>{
      try{const next=await api(`/jobs/${job.id}`,undefined,controller.signal);setJob(next);if(next.status==='ready'){setJob(null);await load(next.dataset_id)}else if(['failed','cancelled'].includes(next.status)){setError(next.error||'Import cancelled');setJob(null)}}catch(e){if(e.name!=='AbortError')setError(e.message)}
    },400)
    return()=>{clearTimeout(timer);controller.abort()}
  },[job,load])
  useEffect(()=>{
    if(!dataset)return
    const persist=()=>{try{localStorage.setItem(`alignment-layers:${dataset.id}`,JSON.stringify(workspaceForSave(state,originalFragments)))}catch{/* Save workspace remains available */}}
    const timer=setTimeout(persist,300)
    return()=>{clearTimeout(timer);persist()}
  },[dataset,state,originalFragments])
  useEffect(()=>{
    const key=e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'&&!['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)){e.preventDefault();undo(e.shiftKey)}}
    window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key)
  },[undo])
  useEffect(()=>{
    if(!dataset||source?.block===state.sourceBlock)return
    const token=++blockNav.current
    api(`/datasets/${dataset.id}/blocks/${state.sourceBlock}/rows`).then(value=>{if(token===blockNav.current)setSource(value)}).catch(e=>{if(token===blockNav.current)setError(e.message)})
  },[dataset,source?.block,state.sourceBlock])
  async function sourceBlock(id){
    // Every path that fetches a block's rows takes a token from the same
    // counter, so a slow earlier response can never replace the block the user
    // asked for last. Without this, rapid ‹ / › clicks or repeated Enter in the
    // block input resolve out of order and the view silently settles on an
    // earlier request instead of the most recent one.
    const token=++blockNav.current
    try{
      const result=await api(`/datasets/${dataset.id}/blocks/${id}/rows`)
      if(token!==blockNav.current)return
      setSource(result);patch({sourceBlock:Number(id),original:true,selection:[],camera:fitCamera({fragments:[createFragment(result.block,0,result.length,result.rows.map(r=>r.id),{x:result.layout_start||0})]},size.width,size.height)})
    }catch(e){if(token===blockNav.current)setError(e.message)}
  }
  function transfer(copy=false,destinationId=target){
    const newLayer=destinationId==='new'?createLayer(layerName.trim()||`Layer ${state.layers.length+1}`,state.layers.length):null
    commit(s=>{
      // Original is immutable. Extracting from it creates working cells without
      // removing any source data or storing a duplicate of the full alignment.
      const input=s.original?{...s,layers:[...s.layers,original],active:'original'}:s
      const next=moveSelection(input,newLayer?.id||destinationId,{copy:copy||s.original,targetLayer:newLayer,viewportWidth:size.width})
      const layers=next.layers.filter(l=>l.id!=='original'),destination=layers.find(l=>l.id===next.active)
      const view=fitCamera(destination,size.width,size.height)
      return {...next,layers:layers.map(l=>l.id===next.active?{...l,camera:view}:l),camera:view}
    });setLayerName('');setTarget('new');setInspect(null)
  }
  function selectionDropTarget(point){
    const element=document.elementFromPoint(point.x,point.y)?.closest('[data-selection-drop]')
    if(!element||!explorerRoot.current?.contains(element))return null
    const id=element.dataset.selectionDrop
    return id==='new'||state.layers.some(l=>l.id===id&&(state.original||l.id!==state.active))?id:null
  }
  function dragSelection(point){
    if(!point){setSelectionDrag(null);return}
    const sidebar=explorerRoot.current?.querySelector('.al-sidebar'),rect=sidebar?.getBoundingClientRect()
    if(rect&&point.x>=rect.left&&point.x<=rect.right){
      if(point.y<rect.top+35)sidebar.scrollTop-=18
      else if(point.y>rect.bottom-35)sidebar.scrollTop+=18
    }
    setSelectionDrag({...point,target:selectionDropTarget(point)})
  }
  function dropSelection(point){
    const id=selectionDropTarget(point)
    setSelectionDrag(null)
    if(id)transfer(false,id)
  }
  function requestMerge(from,to){if(from===to||from==='original'||to==='original')return;const a=state.layers.find(l=>l.id===from),b=state.layers.find(l=>l.id===to);if(!a||!b)return;if(layerOverlap(a,b))setMerge({from,to});else finishMerge(from,to,false)}
  function finishMerge(from,to,combine){commit(s=>{const next=mergeLayers(s,from,to,combine,ids),view=fitCamera(next.layers.find(l=>l.id===to),size.width,size.height);return {...next,camera:view,layers:next.layers.map(l=>l.id===to?{...l,camera:view}:l)}});setMerge(null)}
  async function copyChunk(fragment){
    try{
      if((fragment.end-fragment.start)*fragment.rowIds.length>2_000_000)throw new Error('Select a smaller chunk to copy (up to 2 million alignment cells).')
      const data=await api(`/datasets/${dataset.id}/region`,{block:fragment.sourceBlock,start:fragment.start,end:fragment.end,ids:fragment.rowIds})
      if(!data.detail)throw new Error('Select a smaller chunk to copy exact bases.')
      await navigator.clipboard.writeText(chunkFasta(fragment,data.rows))
      setNotice(`Copied ${fragment.rowIds.length} sequences as aligned FASTA. Unselected or unavailable cells use N.`)
    }catch(e){setError(e.message)}
  }
  function blockToLayer(fragment){
    const next=createLayer(`Block ${fragment.sourceBlock}`,state.layers.length,[createFragment(fragment.sourceBlock,fragment.start,fragment.end,fragment.rowIds)])
    next.camera=fitCamera(next,size.width,size.height)
    commit(s=>({...s,layers:[...s.layers,next],active:next.id,original:false,selection:[],camera:next.camera}))
  }
  async function save(){try{const value={...workspaceForSave(state,originalFragments),source:{id:dataset.id,name:dataset.name}};await api(`/datasets/${dataset.id}/workspace`,value,undefined,'PUT');download(`${dataset.name||'alignment'}.layers.json`,JSON.stringify(value,null,2),'application/json');setNotice('Layer workspace saved.')}catch(e){setError(e.message)}}
  async function applyMetadata(content,suffix){await api(`/datasets/${dataset.id}/metadata`,{content,suffix});const rows=[];for(let offset=0;;offset+=5000){const page=await api(`/datasets/${dataset.id}/sequences?offset=${offset}&limit=5000`);rows.push(...page.rows);if(rows.length>=page.total)break}setInventory(rows);setRevision(v=>v+1);setNotice('Genome links updated; all alignment rows remain available.')}
  async function chooseFile(){
    if(window.electronAPI?.selectFile){try{const selected=await window.electronAPI.selectFile(path||undefined);if(selected)startImport({path:selected})}catch(e){setError(e.message)}}
    else file.current.click()
  }
  const baseColors=NUCLEOTIDE_COLORS[theme==='light'?'light':'dark']
  const selectionCells=state.selection.reduce((n,s)=>n+(s.end-s.start)*s.rowIds.length,0)
  const selectionRows=new Set(state.selection.flatMap(s=>s.rowIds)).size
  const namedRow=inspect?.rowId?displayInventory.find(r=>r.id===inspect.rowId):null
  const sourceRange=visibleSourceRange(originalFragments,renderState.camera,size.width)
  const visibleSourceBlock=(sourceRange&&!sourceRange.grouped?sourceRange.first:null)||state.sourceBlock
  const selectableFragments=useMemo(()=>coordinateFragments(active),[active])
  const selectedFragment=selectableFragments.find(f=>f.id===range.fragment)||selectableFragments[0]
  const rowChoices=useMemo(()=>{
    if(!selectedFragment)return []
    const members=new Set(selectedFragment.rowIds),query=rowQuery.trim().toLowerCase()
    return inventory.filter(r=>members.has(r.id)&&(r.label||r.source).toLowerCase().includes(query))
  },[inventory,selectedFragment,rowQuery])
  return <section className={`alignment-layers ${theme==='light'?'light':''} ${selectionDrag?'is-selection-dragging':''}`} ref={explorerRoot} aria-label="Alignment Explorer" data-screenshot-capture="view">
    {(error||notice||job)&&<div className={`al-notice ${error?'error':''}`} role={error?'alert':'status'}>{error||notice||`${job.status}: ${job.progress?.message||'Indexing alignment…'}`}{error&&dataset&&<button onClick={()=>{setError('');setRevision(n=>n+1)}}>Retry loading</button>}{job?<button onClick={()=>api(`/jobs/${job.id}/cancel`,{}).catch(e=>setError(e.message))}>Cancel import</button>:<button aria-label="Dismiss message" onClick={()=>{setError('');setNotice('')}}>×</button>}</div>}
    {!dataset?<div className="al-welcome"><div className="al-mark">▱<br/>▱<br/>▱</div><h2>Follow sequences across layers</h2><p>Start with a familiar alignment. Select a region, move it to a layer, and connect the pieces that matter.</p><div><button className="primary" disabled={busy||!!job} onClick={()=>setDialog('open')}>Open an alignment</button><button disabled={busy||!!job} onClick={()=>startImport({name:'Layer exploration example',format:'fasta',content:demoAlignment()})}>Explore example</button></div><small>MAF · aligned FASTA · XMFA · Stockholm · Clustal · PHYLIP<br/>All sequences are included, with or without linked genomes.</small></div>:<div className="al-workspace">
      <aside className={`al-sidebar ${state.sidebarCollapsed&&!selectionDrag?'collapsed':''}`}>
        <button className="al-sidebar-toggle" aria-label={state.sidebarCollapsed?'Expand alignment sidebar':'Collapse alignment sidebar'} aria-expanded={!state.sidebarCollapsed} onClick={()=>patch({sidebarCollapsed:!state.sidebarCollapsed})}><DrawerChevron pointsRight={!!state.sidebarCollapsed}/></button>
        <div className="al-sidebar-content">
        <details key={selectionDrag?"drag-layers":"layers"} open className="al-section"><summary>Layers</summary><div className="al-layer-targets"><div className="al-sidebar-title"><strong>Layers</strong><button title="New empty layer" onClick={()=>{const next=createLayer(`Layer ${state.layers.length+1}`,state.layers.length);commit(s=>({...s,layers:[...s.layers,next],active:next.id,original:false,selection:[],camera:next.camera}))}}>＋</button></div>
        <button className={`al-original ${state.original?'selected':''}`} onClick={()=>switchLayer('original')}><i/> <span>Original alignment<small>Complete source · always available</small></span><b>⌑</b></button>
        {state.original&&<label className="al-check"><input type="checkbox" checked={!!state.overlay} onChange={e=>patch({overlay:e.target.checked})}/>Highlight regions in other layers</label>}
        <div className="al-layer-list">{state.layers.map(l=><div key={l.id} data-layer-drop={l.id} data-selection-drop={l.id} className={`al-layer ${selectionDrag?.target===l.id?'selection-drop-hover':''} ${selectionDrag&&!state.original&&l.id===state.active?'selection-drop-disabled':''} ${!state.original&&l.id===state.active?'selected':''}`} draggable onDragStart={e=>{e.dataTransfer.setData('application/x-alignment-layer',l.id);e.dataTransfer.effectAllowed='move'}} onDragOver={e=>{if(e.dataTransfer.types.includes('application/x-alignment-layer')){e.preventDefault();e.currentTarget.classList.add('drop')}}} onDragLeave={e=>e.currentTarget.classList.remove('drop')} onDrop={e=>{e.preventDefault();e.currentTarget.classList.remove('drop');requestMerge(e.dataTransfer.getData('application/x-alignment-layer'),l.id)}}><button onClick={()=>switchLayer(l.id)}><i style={{background:l.color}}/><span>{l.name}<small>{l.fragments.length} {l.fragments.length===1?'chunk':'chunks'} · {new Set(l.fragments.flatMap(f=>f.rowIds)).size} sequences</small></span></button><button className="al-rename" aria-label={`Rename ${l.name}`} onClick={()=>{setLayerName(l.name);setDialog({rename:l.id})}}>✎</button><button className="al-rename" aria-label={`Remove layer ${l.name}`} title="Remove this layer (undo available; Original stays intact)" onClick={()=>commit(s=>({...s,layers:s.layers.filter(item=>item.id!==l.id),original:s.original||s.active===l.id,selection:[]}))}>×</button></div>)}</div>
        {!!selectionRows&&<button className={`al-new-layer-drop ${selectionDrag?.target==='new'?'selection-drop-hover':''}`} data-selection-drop="new" onClick={()=>transfer(false,'new')}><b>＋</b><span>New layer<small>Drop the picked cells here</small></span></button>}
        </div>
</details>
        <details className="al-section" open={selectionRows>0?true:undefined}><summary>Selection</summary><p className="al-hint">Click a sequence name or a block header to pick it, or drag with Select or Columns to pick a region. Picks add up; click one again to drop it. Then drag any of them to a layer or ＋ New layer.</p><button disabled={!selectableFragments.length} title={selectableFragments.length?undefined:'Zoom in to an individual source block to select by coordinates.'} onClick={()=>{const f=selectableFragments[0];setRange({fragment:f?.id||'',start:(f?.start||0)+1,end:Math.min(f?.end||100,(f?.start||0)+100)});setSelectRows([]);setDialog('select')}}>Select by coordinates</button>        {!!selectionRows&&<div className="al-selection-bar" role="region" aria-label="Selected region actions"><strong>{selectionRows?`${selectionRows} ${selectionRows===1?'sequence':'sequences'} picked`:'Nothing picked'}</strong><small>{selectionRows?`${state.selection.length} ${state.selection.length===1?'pick':'picks'} · ${selectionCells.toLocaleString()} cells`:'Click a name or a block header, or drag with Select or Columns.'}</small>{!!selectionRows&&<><select aria-label="Move selection to layer" value={target} onChange={e=>setTarget(e.target.value)}><option value="new">New layer…</option>{state.layers.filter(l=>l.id!==state.active||state.original).map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select>{target==='new'&&<input aria-label="New layer name" placeholder={`Layer ${state.layers.length+1}`} value={layerName} onChange={e=>setLayerName(e.target.value)}/>}<button className="primary" onClick={()=>transfer(false)}>{state.original?'Place in layer':'Move to layer'}</button>{!state.original&&<button onClick={()=>transfer(true)}>Copy instead</button>}<button onClick={()=>patch({selection:[]})}>Clear selection</button></>}</div>}
</details>
        <details className="al-section"><summary>Alignment & loading</summary><strong className="al-dataset-name">{dataset.name}</strong><button onClick={()=>setDialog('open')}>Open alignment</button><div className="al-source"><strong>Source blocks</strong><select aria-label="Source alignment block" value={state.sourceBlock} onChange={e=>sourceBlock(Number(e.target.value))}>{blocks.blocks.map(b=><option key={b.id} value={b.id}>Block {b.id} · {b.length.toLocaleString()} columns</option>)}</select>{blocks.total>blocks.blocks.length&&<label>Open block number<input type="number" min="1" max={blocks.total} defaultValue={state.sourceBlock} onKeyDown={e=>{if(e.key==='Enter')sourceBlock(Number(e.target.value))}}/></label>}<small>{blocks.total} source blocks · {inventory.length} sequences</small><button onClick={()=>setDialog('links')}>Genome links & annotations</button></div>
</details>
        <details className="al-section"><summary>Display & annotations</summary>{state.original&&<label className="al-row-mode">Sequence rows<select aria-label="Original sequence rows" value={state.originalRows||'aligned'} onChange={e=>patch({originalRows:e.target.value,blockRows:{}})}><option value="aligned">Align across source blocks</option><option value="compact">Collapse absent rows</option></select><small>Use the row icon on an individual block to override this.</small></label>}<button className={state.tilted?'selected':''} disabled={fallback} onClick={()=>patch({tilted:!state.tilted})}>{state.tilted?'Flat view':'3D layers'}</button><label className="al-check"><input type="checkbox" checked={state.annotations} onChange={e=>patch({annotations:e.target.checked})}/>Annotations</label>        <div className="al-legend"><span><i style={{background:baseColors.baseA}}/>A <i style={{background:baseColors.baseC}}/>C <i style={{background:baseColors.baseG}}/>G <i style={{background:baseColors.baseT}}/>T</span><span>Outlined — Gap · N Unknown · hatching No coverage</span><span>Strings: omitted alignment columns · ↔ overlap · ? different source blocks</span>{state.annotations&&<FeatureLegend theme={theme} horizontal/>}</div><p className="al-hint">Drag chunk headers to arrange pieces. Drag a layer onto another to merge. Click a cell or a string to follow one sequence's path.</p></details>
        <details className="al-section"><summary>Workspace & export</summary><div className="al-actions"><button disabled={!history.current.past.length} onClick={()=>undo(false)}>Undo</button><button disabled={!history.current.future.length} onClick={()=>undo(true)}>Redo</button></div><button onClick={save}>Save workspace</button><button onClick={()=>workspace.current.click()}>Load workspace</button><button onClick={()=>{const url=canvas.current?.image();if(url){const a=document.createElement('a');a.href=url;a.download=`${dataset.name}-${active.name}.png`;a.click()}}}>Export image</button></details>
        </div>
      </aside>
      <main className="al-main"><div className="al-toolbar" data-alignment-control-bar><div className="al-tools">{[['pan','Pan'],['rectangle','Select'],['columns','Columns']].map(([mode,label])=><button key={mode} className={state.mode===mode?'selected':''} aria-pressed={state.mode===mode} onClick={()=>patch({mode})}>{label}</button>)}</div><button disabled={state.original||!active.fragments.length} onClick={()=>commit(s=>{const tidied=tidyLayer(active,ids,chunkGap(active.fragments,size.width)),view=fitCamera(tidied,size.width,size.height);return {...s,layers:s.layers.map(l=>l.id===active.id?{...tidied,camera:view}:l),camera:view}})}>Auto arrange</button>{state.original&&<div className="al-source-nav" title={sourceRange?.grouped?'This overview groups source blocks. Enter a block number to open one.':undefined}><button aria-label="Previous source block" disabled={!!sourceRange?.grouped||visibleSourceBlock<=1} onClick={()=>sourceBlock(visibleSourceBlock-1)}>‹</button><label>{sourceRange?.grouped?`Blocks ${sourceRange.first}–${sourceRange.last}`:'Block'} <input aria-label="Jump to source block" type="number" min="1" max={blocks.total} placeholder={sourceRange?.grouped?'Block…':undefined} key={sourceRange?.grouped?'grouped':visibleSourceBlock} defaultValue={sourceRange?.grouped?'':visibleSourceBlock} onKeyDown={e=>{if(e.key==='Enter'){const id=Number(e.currentTarget.value);if(Number.isInteger(id)&&id>=1&&id<=blocks.total)sourceBlock(id)}}}/></label><button aria-label="Next source block" disabled={!!sourceRange?.grouped||visibleSourceBlock>=blocks.total} onClick={()=>sourceBlock(visibleSourceBlock+1)}>›</button></div>}<strong className="al-active-name" style={{borderColor:layer.color}}>{layer.name}</strong><button title="Reset view to whole layer" aria-label="Reset view" onClick={fit}>↺</button><LayerCycle layers={allLayers} active={layer.id} onChoose={switchLayer} dataset={dataset} inventory={displayInventory} light={theme==='light'} revision={revision}/></div>
        <LayerCanvas ref={canvas} layer={layer} layers={allLayers} state={canvasState} navigationCamera={renderState.camera} inventory={displayInventory} tiles={tiles} annotations={annotations} connections={connections} offWindow={offWindow} counts={counts} gaps={gaps} light={theme==='light'} config={config} onCamera={camera} onCopyChunk={copyChunk} onBlockToLayer={blockToLayer} onAggregate={f=>camera(fitCamera({fragments:[{...f,rowIds:[],layoutRows:1}]},size.width,size.height))} onToggleRows={f=>patch({blockRows:{...state.blockRows,[f.sourceBlock]:f.compact?'aligned':'compact'}})} onSelection={value=>patch({selection:value,mode:'pan'})} onSelectionDrag={dragSelection} onSelectionDrop={dropSelection} onMove={(id,x,y)=>commit(s=>({...s,layers:s.layers.map(l=>l.id===s.active?{...l,fragments:l.fragments.map(f=>f.id===id?{...f,x,y}:f)}:l)}))} onHighlight={id=>patch({highlighted:id})} onInspect={setInspect} onSize={setSize} onFallback={setFallback} onSourceBlock={sourceBlock}/>
        <div className="al-status"><span>{pending?'Loading regional detail…':layer.fragments.some(f=>f.aggregate)?'Block presence overview':renderState.camera.scale>=NUCLEOTIDE_LETTER_THRESHOLD?'Sequence detail':renderState.camera.scale>=.65?'Base patterns':'Binned agreement to first row'}{fallback?' · Canvas fallback':''}</span><span>{inspect?.kind==='aggregate'?`${namedRow?.label||''} · present in ${inspect.aggregate.presence?.[inspect.rowId]||0} of ${inspect.aggregate.count} source blocks (${inspect.aggregate.first}–${inspect.aggregate.last})`:inspect?.kind==='connection'?`${inventory.find(r=>r.id===inspect.connection.rowId)?.label||'Sequence'} · ${inspect.connection.columns==null?'Different source blocks: alignment distance unavailable':inspect.connection.columns<0?`${-inspect.connection.columns} overlapping alignment columns`:`${inspect.connection.columns} omitted alignment columns`} · ${counts[inspect.connection.id]?.bases??'?'} ungapped bases`:inspect?.kind==='cell'?`${namedRow?.label||''} · block ${inspect.fragment.sourceBlock}, column ${(inspect.column+1).toLocaleString()}${inspect.base?` · ${inspect.base}`:''}${inspect.placed?.length?` · In layers: ${inspect.placed.join(', ')}`:''}${inspect.features?.length?` · ${inspect.features.map(f=>f.type).join(', ')}`:''}`:'Click a name or a block header to pick it \u00b7 click a cell or a string to follow its path.'}</span></div>

        {!!warnings.length&&<div className="al-annotation-warning">Annotations unavailable for {warnings.length} visible rows: {warnings[0].message}</div>}
      </main>
    </div>}
    {selectionDrag&&<><div className="al-selection-dim"/><div className="al-selection-ghost" role="status" style={{left:selectionDrag.x+16,top:selectionDrag.y+16}}><strong>{selectionRows} sequences · {state.selection.length} regions</strong><small>{selectionDrag.target==='new'?'Release to create a new layer':selectionDrag.target?`Release to ${state.original?'place in':'move to'} ${state.layers.find(l=>l.id===selectionDrag.target)?.name}`:'Drop on a sidebar layer or ＋ New layer · Esc cancels'}</small></div></>}
    {merge&&<div className="al-modal-shade"><div className="al-modal" role="dialog" aria-modal="true" aria-label="Overlapping chunks"><h3>These layers contain overlapping chunks</h3><p>Combine overlapping source intervals into one chunk with both sets of sequences, or preserve each chunk separately. Unselected cells remain blank.</p><button className="primary" onClick={()=>finishMerge(merge.from,merge.to,true)}>Combine overlapping chunks</button><button onClick={()=>finishMerge(merge.from,merge.to,false)}>Keep chunks separate</button><button onClick={()=>setMerge(null)}>Cancel</button></div></div>}
    {dialog&&<div className="al-modal-shade"><div className="al-modal" role="dialog" aria-modal="true" aria-label={typeof dialog==='string'?dialog:'Rename layer'}><button className="al-close" aria-label="Close dialog" onClick={()=>setDialog(null)}>×</button>
      {dialog==='open'&&<><h3>Open a nucleotide alignment</h3><p>Load a local MAF, aligned FASTA, XMFA, Stockholm, Clustal or PHYLIP file. Compressed text files are supported.</p><button className="primary" disabled={busy||!!job} onClick={chooseFile}>Choose file</button><label>Or enter a local file path<input placeholder="/path/to/alignment.maf" value={path} onChange={e=>setPath(e.target.value)}/></label><button disabled={!path||busy||!!job} onClick={()=>startImport({path})}>Open path</button><button disabled={busy||!!job} onClick={()=>startImport({name:'Layer exploration example',format:'fasta',content:demoAlignment()})}>Explore example</button><small>The source file stays unchanged. Layer layouts are stored separately.</small></>}
      {dialog?.rename&&<><h3>Rename layer</h3><input aria-label="Layer name" autoFocus value={layerName} maxLength={120} onChange={e=>setLayerName(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&layerName.trim()){commit(s=>({...s,layers:s.layers.map(l=>l.id===dialog.rename?{...l,name:layerName.trim()}:l)}));setDialog(null);setLayerName('')}}}/><button className="primary" disabled={!layerName.trim()} onClick={()=>{commit(s=>({...s,layers:s.layers.map(l=>l.id===dialog.rename?{...l,name:layerName.trim()}:l)}));setDialog(null);setLayerName('')}}>Save name</button></>}
      {dialog==='select'&&<><h3>Select by alignment coordinates</h3>{!selectedFragment?<p className="al-hint">This view groups several source blocks together, so there are no individual alignment columns to address. Zoom in until single blocks are shown, then select by coordinates.</p>:<><label>{state.original?'Source block':'Chunk'}<select value={selectedFragment.id} onChange={e=>{const f=selectableFragments.find(f=>f.id===e.target.value);setRange({fragment:f.id,start:f.start+1,end:f.end});setSelectRows([])}}>{selectableFragments.map(f=><option key={f.id} value={f.id}>Block {f.sourceBlock} · {f.start+1}–{f.end}</option>)}</select></label><div className="al-range"><label>First column<input type="number" min={selectedFragment.start+1} max={selectedFragment.end} value={range.start} onChange={e=>setRange({...range,start:Number(e.target.value)})}/></label><label>Last column<input type="number" min={selectedFragment.start+1} max={selectedFragment.end} value={range.end} onChange={e=>setRange({...range,end:Number(e.target.value)})}/></label></div><label>Sequences <small>None checked means all rows in this region.</small><input placeholder="Search sequences" value={rowQuery} onChange={e=>setRowQuery(e.target.value)}/></label><div className="al-row-choices">{rowChoices.slice(0,200).map(r=><label key={r.id}><input type="checkbox" checked={selectRows.includes(r.id)} onChange={e=>setSelectRows(v=>e.target.checked?[...v,r.id]:v.filter(id=>id!==r.id))}/>{r.label||r.source}</label>)}</div>{rowChoices.length>200&&<small>Showing the first 200 of {rowChoices.length.toLocaleString()} matching sequences. Search to narrow the list, or leave every box unchecked to select all {selectedFragment.rowIds.length.toLocaleString()} rows in this block.</small>}<button className="primary" disabled={range.end<range.start||range.start<=selectedFragment.start||range.end>selectedFragment.end} onClick={()=>{patch({mode:'pan',selection:[{fragmentId:selectedFragment.id,start:range.start-1,end:range.end,rowIds:selectRows.length?selectRows:selectedFragment.rowIds}]});setDialog(null)}}>Select region</button></>}</>}
      {dialog==='links'&&<><h3>Genome links & annotations</h3><p>Link sequence identity and contig to local genome data. Coordinate-aware MAF rows use the same GFF3 feature mapping as the existing alignment view. Saved MAFFT annotations are also retained.</p><button onClick={()=>metadata.current.click()}>Import TSV / JSON metadata</button><small>Fields: source (or id), genome_key, chrom, assembly, label. FASTA coordinates: genomic_start / genomic_end (1-based), strand. Links never remove rows.</small><label>Alignment sequence<select value={link.row} onChange={e=>setLink({...link,row:e.target.value})}><option value="">Choose a sequence</option>{inventory.map(r=><option key={r.id} value={r.id}>{r.label} {r.metadata?.genome_key?'· linked':''}</option>)}</select></label><label>Local genome<select value={link.genome} onChange={e=>setLink({...link,genome:e.target.value})}><option value="">Choose a genome</option>{genomes.map(g=><option key={getGenomeKey(g)} value={getGenomeKey(g)}>{g.display_name||g.name||g.species||getGenomeKey(g)}</option>)}</select></label><label>Contig / chromosome<input placeholder="e.g. chr1" value={link.chrom} onChange={e=>setLink({...link,chrom:e.target.value})}/></label><button disabled={!link.row||!link.genome||!link.chrom} onClick={()=>applyMetadata(JSON.stringify([{id:link.row,genome_key:link.genome,chrom:link.chrom}]),'.json').then(()=>patch({annotations:true})).catch(e=>setError(e.message))}>Apply link</button><small>Unpositioned FASTA rows need coordinate metadata or saved alignment annotations; matching a name alone cannot place genomic features.</small></>}
    </div></div>}
    <input ref={file} hidden type="file" accept=".maf,.fa,.fasta,.fas,.fna,.aln,.xmfa,.sto,.stockholm,.phy,.phylip,.gz" onChange={async e=>{const f=e.target.files?.[0];e.target.value='';if(!f)return;const localPath=window.electronAPI?.getPathForFile?.(f)||f.path;if(localPath){startImport({path:localPath});return}if(f.size>20_000_000||f.name.endsWith('.gz')){setPath('');setNotice('Use the local file path for compressed files or files larger than 20 MB.');return}startImport({name:f.name,content:await f.text()})}}/>
    <input ref={metadata} hidden type="file" accept=".tsv,.json" onChange={async e=>{const f=e.target.files?.[0];e.target.value='';if(f)try{await applyMetadata(await f.text(),f.name.endsWith('.tsv')?'.tsv':'.json')}catch(error){setError(error.message)}}}/>
    <input ref={workspace} hidden type="file" accept=".json" onChange={async e=>{const f=e.target.files?.[0];e.target.value='';if(f)try{const value=JSON.parse(await f.text());if(value.source?.id&&value.source.id!==dataset.id)throw new Error('This workspace references a different alignment. Open that source first.');const next=validateLayerWorkspace(value,ids);const token=++blockNav.current;const block=await api(`/datasets/${dataset.id}/blocks/${next.sourceBlock}/rows`);if(token!==blockNav.current)return;setSource(block);commit(next.original?{...next,camera:{...next.camera,x:next.camera.x+(block.layout_start||0)}}:next)}catch(error){setError(error.message)}}}/>
  </section>
}
