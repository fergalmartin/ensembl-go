import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getGenomeKey, genomeKeyCandidates, genomeKeyDisplayLabels } from '../../utils/genomeIdentity'
import DrawerChevron from '../DrawerChevron'
import LayerCanvas from './LayerCanvas'
import LayerCycle from './LayerCycle'
import ColourLegend from './ColourLegend'
import SelectTool from './SelectTool'
import ColourTool from './ColourTool'
import useMotifs from './useMotifs'
import useMotifPreparation from '../motifs/useMotifPreparation'
import MotifProgress from '../motifs/MotifProgress'
import { motifTransport } from './motifTransport'
import { loadMotifs, saveMotifs, motifLegend } from './motifs'
import ZoomTool from './ZoomTool'
import ImportProgress from './ImportProgress'
import { layoutOriginal, blockRowLines, centreOnRow } from './originalLayout'
import { hiddenSelection, canHide, hideResult, packBlocks, packedExtent } from './hiding'
import useOriginalBlocks from './useOriginalBlocks'
import useLayerData from './useLayerData'
import { exactGenomeLinks } from './associations'
import FilterPanel from './FilterPanel'
import GenomeColorPicker from '../GenomeColorPicker'
import { genomeColorPalette } from '../../genomeColorSchemes'
import { api, download, demoAlignment } from './data'
import { toggleHighlights, emptyWorkspace, createLayer, createFragment, moveSelection, mergeLayers, layerOverlap, tidyLayer, fitCamera, validateLayerWorkspace, constrainCamera, chunkGap, chunkFasta, workspaceForSave, coordinateFragments, visibleSourceRange, resolveRowOrder, moveRowBefore, reorderFragmentRow, resolvePicks, addHighlight, unlightRow, removeFragment, removeRowFromLayer, removeHighlight, planeViewport, enterPanelZoom, exitPanelZoom, PANEL_ZOOM_HINT_ATTEMPTS, ZOOM_HINT_MS } from './layers'
import { NUCLEOTIDE_LETTER_THRESHOLD } from '../../utils/nucleotideStyle'
import { schemeById } from './colourSchemes'
import { cohortOf } from './conservationPlan'
import { litRows } from './layers'
import './explorer.css'

export default function AlignmentExplorerView({theme='dark',config,genomes=[],incoming,onIncomingConsumed}) {
  const [motifs,setMotifs]=useState(loadMotifs),[motifsSaved,setMotifsSaved]=useState(true)
  const [dataset,setDataset]=useState(null),[inventory,setInventory]=useState([]),[blocks,setBlocks]=useState({blocks:[],total:0}),[source,setSource]=useState(null)
  const [state,setState]=useState(emptyWorkspace),[size,setSize]=useState({width:900,height:500}),[job,setJob]=useState(null),[opening,setOpening]=useState(''),[cancelling,setCancelling]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
  const [dialog,setDialog]=useState(null),[path,setPath]=useState(''),[merge,setMerge]=useState(null),[layerName,setLayerName]=useState(''),[target,setTarget]=useState('new'),[inspect,setInspect]=useState(null),[fallback,setFallback]=useState(false),[revision,setRevision]=useState(0)
  const [selectionDrag,setSelectionDrag]=useState(null),[filterOpen,setFilterOpen]=useState(false),[colorTarget,setColorTarget]=useState(null)
  // Hiding replaces Original's layout rather than filtering it: the blocks that
  // survive are fetched by number and laid out shoulder to shoulder, so the
  // file's own coordinates no longer describe the sheet and the loader that
  // reads them is stood down for the duration.
  const [hiddenLayout,setHiddenLayout]=useState(null),[hideMenu,setHideMenu]=useState(false),[hideDraft,setHideDraft]=useState(null),[menuAnchor,setMenuAnchor]=useState({top:0,right:8})
  // Layers folds like the other sections, but its title lives on the sidebar's
  // header row rather than inside the section, so a <details> cannot hold the
  // state. A selection drag opens it whatever the user left it at, or there
  // would be nothing to drop onto.
  const [layersExpanded,setLayersExpanded]=useState(true)
  const layersOpen=layersExpanded||!!selectionDrag
  const explorerRoot=useRef(null)
  // Which of the two ways of selecting the bar's one button offers. A completed
  // selection puts the mode back to Pan, so the choice has to outlive the mode.
  const [selectKind,setSelectKind]=useState('rectangle')
  const [rowQuery,setRowQuery]=useState(''),[selectRows,setSelectRows]=useState([]),[range,setRange]=useState({fragment:'',start:1,end:100}),[link,setLink]=useState({row:'',genome:'',chrom:''})
  // 'auto' asks the server to read the file's own signature. Any other value
  // names a reader outright, for files whose signature is missing or misleading.
  const [format,setFormat]=useState('auto'),[capabilities,setCapabilities]=useState(null),[exportFormat,setExportFormat]=useState('fasta')
  const [attempt,setAttempt]=useState(null),[zoomHint,setZoomHint]=useState(0)
  // A token rather than a flag: it keys the hint, so asking again while one is
  // still on screen remounts it and the fade starts over instead of the notice
  // vanishing mid-sentence on the timer the first one started.
  const zoomAttempts=useRef(0),zoomHintTimer=useRef(null),hideFit=useRef(null),hideButton=useRef(null)
  const history=useRef({past:[],future:[]}),stateRef=useRef(state),canvas=useRef(null),file=useRef(null),metadata=useRef(null),workspace=useRef(null),epoch=useRef(0),blockNav=useRef(0),incomingHandled=useRef(null),genomesRef=useRef(genomes),lastImport=useRef(null),importName=useRef('')
  genomesRef.current=genomes
  stateRef.current=state
  const patch=useCallback(value=>setState(s=>({...s,...value})),[])
  const commit=useCallback(fn=>{const prev=stateRef.current,next=typeof fn==='function'?fn(prev):{...prev,...fn};if(next===prev)return;history.current.past.push(prev);history.current.past=history.current.past.slice(-50);history.current.future=[];stateRef.current=next;setState(next)},[])
  const undo=useCallback(redo=>{const from=redo?history.current.future:history.current.past,to=redo?history.current.past:history.current.future;if(from.length){to.push(stateRef.current);const next=from.pop();stateRef.current=next;setState(next)}},[])
  
  const orderedInventory=useMemo(()=>{
    const order=resolveRowOrder(inventory.map(r=>r.id),state.rowOrder)
    const byId=new Map(inventory.map(r=>[r.id,r]))
    return order.map(id=>byId.get(id)).filter(Boolean)
  },[inventory,state.rowOrder])
  // Both data paths are asked about the viewport plane zoom opens up rather than
  // the window itself. Shrinking the sheet really does put more of the file on
  // screen, and the block layout and the sequence tiles have to be told so, or
  // the level of detail would be chosen for a view nobody is looking at.
  // A filter is a definition and a switch, not one thing. Turning it off leaves
  // it where the reader built it, so the same narrowing can be put back without
  // reconstructing it; only Clear throws it away.
  const filterOn=!!state.filter&&!state.filterOff
  const activeFilter=filterOn?state.filter:null
  const sourceView=useMemo(()=>planeViewport(size,state.camera),[size,state.camera])
  const hiddenBlocks=state.hidden?.blocks,hiddenRows=state.hidden?.rows
  const [motifSnapshot,setMotifSnapshot]=useState(null)
  const datasetRef=useRef(dataset);datasetRef.current=dataset
  const publishColour=useCallback(settings=>patch({colourScheme:settings.scheme,palette:settings.palette,shading:settings.shading,legendOverlay:settings.legendOverlay,hideUnmatchedMotifBlocks:settings.hideUnmatched}),[patch])
  const motifOperation=useMotifPreparation(motifTransport,snapshot=>{
    if(snapshot.context.id!==datasetRef.current?.id)return
    setMotifSnapshot(snapshot);publishColour(snapshot.settings)
  })
  const snapshot=motifSnapshot?.context.id===dataset?.id?motifSnapshot:null
  const applyColour=settings=>{
    setMotifs(settings.motifs);setMotifsSaved(saveMotifs(settings.motifs))
    if(settings.scheme==='motif'&&settings.motifs.some(m=>m.enabled&&m.pattern))motifOperation.start(settings,dataset)
    else {motifOperation.cancel();publishColour(settings);if(settings.scheme==='motif')setMotifSnapshot(null)}
  }
  const restoredMotifs=useRef(null)
  useEffect(()=>{
    if(!dataset)return
    if(restoredMotifs.current===dataset.id)return
    restoredMotifs.current=dataset.id
    motifOperation.cancel()
    if(state.colourScheme==='motif'&&motifs.some(m=>m.enabled&&m.pattern)){
      motifOperation.start({scheme:'motif',palette:state.palette,shading:state.shading,legendOverlay:state.legendOverlay,motifs,hideUnmatched:!!state.hideUnmatchedMotifBlocks},dataset)
    }
  },[dataset]) // eslint-disable-line react-hooks/exhaustive-deps -- restore once per dataset; subsequent changes require Apply
  const motifBlocks=useMemo(()=>({blocks:state.colourScheme==='motif'&&state.hideUnmatchedMotifBlocks?snapshot?.blocks??null:null}),[state.colourScheme,state.hideUnmatchedMotifBlocks,snapshot])
  const motifBlockIds=useMemo(()=>motifBlocks.blocks?new Set(motifBlocks.blocks.map(b=>b.block)):null,[motifBlocks.blocks])
  // Hiding sequences narrows the rows the same way a filter does, so the two
  // compose rather than fight: what survives is what both of them allow.
  const viewFilter=useMemo(()=>{
    if(!hiddenRows?.length)return activeFilter
    const kept=new Set(hiddenRows)
    return {...(activeFilter||{}),sequences:activeFilter?.sequences?.length
      ?activeFilter.sequences.filter(id=>kept.has(id)):[...kept]}
  },[activeFilter,hiddenRows])
  useEffect(()=>{
    if(!dataset||!hiddenBlocks?.length){setHiddenLayout(null);return}
    let cancelled=false
    api(`/datasets/${dataset.id}/blocks-layout`,{blocks:hiddenBlocks})
      .then(result=>{if(!cancelled)setHiddenLayout(result.blocks||[])})
      .catch(error=>{if(!cancelled)setError(error.message)})
    return()=>{cancelled=true}
  },[dataset,hiddenBlocks])
  const packedFragments=useMemo(()=>{
    if(motifBlocks.blocks){
      const allowed=hiddenBlocks?.length?new Set(hiddenBlocks):null
      return packBlocks(motifBlocks.blocks.filter(b=>!allowed||allowed.has(b.block)))
    }
    return hiddenLayout?packBlocks(hiddenLayout):null
  },[hiddenLayout,hiddenBlocks,motifBlocks.blocks])
  const packedKey=packedFragments?.map(f=>f.sourceBlock).join(',')
  // Fitting the whole packed sheet is the answer to "what survived", so it
  // happens when a hide is made and not when one is loaded: a saved workspace
  // already carries the view its author left, in these same coordinates.
  useEffect(()=>{
    if(!packedFragments?.length||hideFit.current!==packedKey)return
    hideFit.current=null
    patch({camera:fitCamera({fragments:packedFragments},size.width,size.height)})
  },[packedKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const sourceFragments=useOriginalBlocks(dataset,source,state.camera,sourceView,blocks.total,state.original&&!hiddenBlocks?.length&&!motifBlockIds,setError,revision,!!state.planeZoom)
  const laidOut=packedFragments||sourceFragments
  const originalFragments=useMemo(()=>layoutOriginal(laidOut,orderedInventory.map(r=>r.id),state.originalRows||'aligned',state.blockRows||{},dataset?.max_source_rows,viewFilter),[laidOut,orderedInventory,state.originalRows,state.blockRows,dataset?.max_source_rows,viewFilter])
  const original=useMemo(()=>({id:'original',name:'Original alignment',color:'#b9c5d9',fragments:originalFragments,packed:!!packedFragments,rowExtent:Math.max(inventory.length,2*(dataset?.max_source_rows||0)+3),extent:packedFragments?packedExtent(packedFragments):dataset?.layout_end||source?.layout_end||source?.length||1}),[originalFragments,packedFragments,dataset?.layout_end,source?.layout_end,source?.length,inventory.length,dataset?.max_source_rows])
  const allLayers=useMemo(()=>[original,...state.layers],[original,state.layers])
  const active=state.original?original:state.layers.find(l=>l.id===state.active)||original
  const layer=useMemo(()=>motifBlockIds&&!state.original?{...active,fragments:active.fragments.filter(f=>motifBlockIds.has(f.sourceBlock))}:active,[active,motifBlockIds,state.original])
  const previousMotifBlocks=useRef(null)
  useEffect(()=>{
    if(motifBlocks.blocks&&previousMotifBlocks.current!==motifBlocks.blocks&&state.original){
      patch({camera:fitCamera(original,size.width,size.height)})
    }
    previousMotifBlocks.current=motifBlocks.blocks
  },[motifBlocks.blocks,original,size.width,size.height,state.original,patch])
  const cameraFrame=useRef(null),pendingCamera=useRef(null)
  const camera=useCallback(value=>{
    const current=stateRef.current,bounded=constrainCamera(current.original?original:current.layers.find(l=>l.id===current.active)||original,value,size)
    pendingCamera.current={camera:bounded,active:current.active,original:current.original}
    if(cameraFrame.current==null)cameraFrame.current=requestAnimationFrame(()=>{
      cameraFrame.current=null;const next=pendingCamera.current
      setState(s=>s.active!==next.active||s.original!==next.original?s:{...s,camera:next.camera,layers:s.layers.map(l=>l.id===s.active&&!s.original?{...l,camera:next.camera}:l)})
    })
    return bounded
  },[original,size])
  useEffect(()=>()=>{if(cameraFrame.current!=null)cancelAnimationFrame(cameraFrame.current)},[])
  const renderState=useMemo(()=>({...state,original:layer.id==='original',camera:constrainCamera(layer,state.camera,size),placedOverlay:state.original&&state.overlay?state.layers.flatMap(l=>l.fragments.map(f=>({...f,color:l.color,name:l.name}))):[]}),[state,layer,size])
  const renderView=useMemo(()=>planeViewport(size,renderState.camera),[size,renderState.camera])
  const filteredInventory=useMemo(()=>{
    const allowed=viewFilter?.sequences?.length?new Set(viewFilter.sequences):null
    return allowed?orderedInventory.filter(row=>allowed.has(row.id)):orderedInventory
  },[orderedInventory,viewFilter])
  const displayInventory=useMemo(()=>filteredInventory.map(row=>{
    const key=row.metadata?.genome_key
    if(!key)return row
    const genome=genomes.find(g=>genomeKeyCandidates(g).includes(key)),fallback=genomeKeyDisplayLabels(key)
    const name=genome?.common_name||genome?.scientific_name||fallback.displayName
    const label=row.label===key?genome?.assembly_name||fallback.displayAssembly:row.label
    return {...row,label:`${name} · ${label}`}
  }),[filteredInventory,genomes])
  // The rows laid out, narrowing to whatever is picked. Deliberately the
  // laid-out set rather than the rows that happen to be on screen, so scrolling
  // never restates the question and the colours hold still while reading.
  const scheme=schemeById(state.colourScheme)
  const cohort=useMemo(()=>scheme.cohort?cohortOf(layer,displayInventory,litRows(state)):null,[scheme,layer,displayInventory,state])
  const {tiles,annotations,connections,offWindow,counts,pending,warnings,conservation,gaps,displayCamera}=useLayerData(dataset,layer,renderState.camera,renderView,state.annotations,revision,setError,false,cohort)
  const motifSearch=useMotifs(snapshot,layer,displayCamera,renderView,scheme.id==='motif')
  const canvasState=useMemo(()=>({...renderState,camera:displayCamera,motifRows:motifSearch.rows}),[renderState,displayCamera,motifSearch.rows])
  const ids=useMemo(()=>orderedInventory.map(r=>r.id),[orderedInventory])
  // Original is the whole alignment however it is being looked at, so it is
  // described by the source's own totals. What a filter or a hide holds back is
  // a second line under them, close enough to read against.
  const plural=(n,one,many)=>`${n.toLocaleString()} ${n===1?one:many}`
  const blockSummary=useMemo(()=>`${plural(blocks.total||0,'block','blocks')} · ${plural(inventory.length,'sequence','sequences')}`,[blocks.total,inventory.length])
  // An empty list is no restriction at all on that side, the same reading
  // layoutOriginal takes of it.
  const hiddenSummary=useMemo(()=>{
    if(!activeFilter)return ''
    const blockCount=activeFilter.blocks?.length||blocks.total||0,rowCount=activeFilter.sequences?.length||inventory.length
    const parts=[]
    if(blocks.total>blockCount)parts.push(plural(blocks.total-blockCount,'block','blocks'))
    if(inventory.length>rowCount)parts.push(plural(inventory.length-rowCount,'sequence','sequences'))
    return parts.length?`${parts.join(' · ')} hidden`:''
  },[activeFilter,blocks.total,inventory.length])
  const switchLayer=useCallback(id=>{setInspect(null);setState(s=>({...s,original:id==='original',active:id==='original'?s.active:id,selection:[],camera:id==='original'?fitCamera({fragments:original.fragments.filter(f=>f.sourceBlock===s.sourceBlock&&!f.aggregate).slice(0,1)},size.width,size.height):s.layers.find(l=>l.id===id)?.camera||s.camera}))},[original,size])
  // Entering panel mode lands on blocks; leaving it returns the sheet to full
  // size with the rows against the top edge, so the control is never a way to
  // get stuck looking at something too small to read.
  const zoomMode=panel=>{
    if(panel===!!state.planeZoom)return
    dismissZoomHint()
    patch({planeZoom:panel})
    camera(panel?enterPanelZoom(state.camera,size):exitPanelZoom(state.camera,layer,size))
  }
  // Panel zoom stops at full size by design. Pointing at Alignment mode is only
  // worth doing for someone who keeps asking for more, so the hint waits for a
  // repeat and a zoom that moves takes the count back down.
  const dismissZoomHint=useCallback(()=>{
    zoomAttempts.current=0;clearTimeout(zoomHintTimer.current);zoomHintTimer.current=null;setZoomHint(0)
  },[])
  const noteZoomLimit=useCallback(blocked=>{
    if(!blocked){zoomAttempts.current=0;return}
    zoomAttempts.current+=1
    if(zoomAttempts.current<PANEL_ZOOM_HINT_ATTEMPTS)return
    setZoomHint(token=>token+1)
    clearTimeout(zoomHintTimer.current)
    zoomHintTimer.current=setTimeout(()=>{zoomHintTimer.current=null;setZoomHint(0)},ZOOM_HINT_MS)
  },[])
  useEffect(()=>()=>clearTimeout(zoomHintTimer.current),[])

  const load=useCallback(async id=>{
    const token=++epoch.current;setBusy(true);setError('')
    try {
      const data=await api(`/datasets/${id}`),rows=[]
      if(token===epoch.current)setOpening(data.name||'Opening alignment')
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
    }catch(e){if(token===epoch.current)setError(e.message)}finally{if(token===epoch.current){setBusy(false);setOpening('')}}
  },[])
  const startImport=useCallback(async payload=>{
    setBusy(true);setError('')
    // Kept so a failed read can be retried under a different reader without
    // the reader having to find the file again.
    lastImport.current=payload.rows?null:payload
    importName.current=payload.path?payload.path.split('/').pop():payload.name||'Alignment'
    try{
      const result=await api('/datasets',payload)
      setDialog(null);setCancelling(false)
      if(result.status==='ready')await load(result.dataset_id);else setJob(result)
    }catch(e){setError(e.message)}finally{setBusy(false)}
  },[load])
  const reopenAs=useCallback(chosen=>{
    const previous=lastImport.current
    if(!previous)return
    setFormat(chosen);setAttempt(null);setError('')
    startImport({...previous,format:chosen})
  },[startImport])
  useEffect(()=>{
    if(incoming&&incomingHandled.current!==incoming){incomingHandled.current=incoming;startImport({name:'MAFFT alignment',rows:incoming.rows});onIncomingConsumed?.()}
  },[incoming,onIncomingConsumed,startImport])
  useEffect(()=>{
    let live=true
    api('/capabilities').then(v=>{if(live)setCapabilities(v)}).catch(()=>{/* the chooser falls back to a built-in list */})
    return()=>{live=false}
  },[])
  useEffect(()=>{
    if(incoming)return
    try{const last=localStorage.getItem('alignment-layers:last');if(last)load(last)}catch{/* optional */}
    // Restore only once; later imports explicitly replace the dataset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[])
  useEffect(()=>{
    if(!job||!['queued','running'].includes(job.status))return
    const controller=new AbortController(),timer=setTimeout(async()=>{
      try{const next=await api(`/jobs/${job.id}`,undefined,controller.signal);setJob(next);if(next.status==='ready'){setJob(null);await load(next.dataset_id)}else if(['failed','cancelled'].includes(next.status)){setError(next.error||'Import cancelled');setAttempt({format:next.format||null,chosen:!!next.format_chosen});setJob(null)}}catch(e){if(e.name!=='AbortError')setError(e.message)}
    },400)
    return()=>{clearTimeout(timer);controller.abort()}
  },[job,load])
  const saveLatest=useRef(null)
  saveLatest.current=()=>{if(dataset)try{localStorage.setItem(`alignment-layers:${dataset.id}`,JSON.stringify(workspaceForSave(stateRef.current,originalFragments)))}catch{/* Explicit Save remains available */}}
  useEffect(()=>{
    const timer=setTimeout(()=>saveLatest.current?.(),300)
    return()=>clearTimeout(timer)
  },[dataset,state,originalFragments])
  useEffect(()=>{
    const flush=()=>saveLatest.current?.()
    window.addEventListener('pagehide',flush)
    return()=>{window.removeEventListener('pagehide',flush);flush()}
  },[])
  useEffect(()=>{
    const key=e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'&&!['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)){e.preventDefault();undo(e.shiftKey)}}
    window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key)
  },[undo])
  useEffect(()=>{
    if(!dataset||source?.block===state.sourceBlock)return
    const token=++blockNav.current
    api(`/datasets/${dataset.id}/blocks/${state.sourceBlock}/rows`).then(value=>{if(token===blockNav.current)setSource(value)}).catch(e=>{if(token===blockNav.current)setError(e.message)})
  },[dataset,source?.block,state.sourceBlock])
  // Hide keeps what is picked out and packs it; Show puts the file back as it
  // was, on the view it was left at.
  const hideChoice=useMemo(()=>hiddenSelection(state.selection,state.highlighted,originalFragments),[state.selection,state.highlighted,originalFragments])
  // The rule in force: what produced the sheet on screen, or what the next Hide
  // will use. A rule that keeps nothing never becomes the rule in force, so the
  // control snaps back to the one the reader is actually looking at.
  const hideWhat=hideMenu?(hideDraft?.what||state.hideWhat||'blocks'):(state.hideWhat||'blocks'),hideMode=hideMenu?(hideDraft?.mode||state.hideMode||'or'):(state.hideMode||'or')
  const hiding=!!(hiddenBlocks?.length||hiddenRows?.length)
  const hidingSummary=useMemo(()=>{
    const parts=[]
    if(hiddenBlocks?.length)parts.push(`${hiddenBlocks.length.toLocaleString()} of ${(blocks.total||0).toLocaleString()} blocks`)
    if(hiddenRows?.length)parts.push(`${hiddenRows.length.toLocaleString()} of ${inventory.length.toLocaleString()} sequences`)
    return parts.join(' · ')
  },[hiddenBlocks,hiddenRows,blocks.total,inventory.length])
  // What the view is holding back, said once, beside the totals it is measured
  // against. Both counts used to sit in the control bar next to the switch that
  // set them, which is the obvious place for them until a wide one pushes Cycle
  // off the end and the bar has to be scrolled to reach its own buttons. The
  // switches keep them in their tooltips; the sidebar card gives them a line
  // that is always in view and never competes for width.
  const narrowedSummary=hiding?`Showing ${hidingSummary}`:hiddenSummary
  // The control bar scrolls sideways, so the menu cannot live inside it without
  // being clipped; it is anchored to the button and drawn over the page.
  useEffect(()=>{
    if(!hideMenu)return
    const rect=hideButton.current?.getBoundingClientRect()
    if(rect)setMenuAnchor({top:Math.round(rect.bottom+6),right:Math.round(Math.max(8,window.innerWidth-rect.right))})
    const away=event=>{if(!event.target?.closest?.('.al-hide-menu')&&event.target!==hideButton.current)setHideMenu(false)}
    const key=event=>{if(event.key==='Escape')setHideMenu(false)}
    window.addEventListener('pointerdown',away,true)
    window.addEventListener('keydown',key)
    return()=>{window.removeEventListener('pointerdown',away,true);window.removeEventListener('keydown',key)}
  },[hideMenu])
  async function applyHide(choice,{what,mode}){
    if(!canHide(choice))return
    setBusy(true)
    try{
      if(what!=='blocks'&&!choice.rows.length){setNotice('No sequences are picked to keep.');return}
      if(choice.rows.length>5000){setNotice('Too many sequences are picked to ask about at once.');return}
      // A picked sequence runs the length of the file, and most of the blocks it
      // visits are not loaded, so the server is asked which hold it.
      const membership=choice.rows.length
        ?(await api(`/datasets/${dataset.id}/blocks-with`,{ids:choice.rows})).blocks||[]
        :[]
      const {blocks:kept,rows}=hideResult(choice,membership,{what,mode})
      if(!kept.length){setNotice(mode==='and'&&what!=='sequences'
        ?'No block satisfies the conditions.'
        :'Nothing picked out is in a block to keep.');return}
      hideFit.current=kept.join(',')
      setHideMenu(false)
      // What was hidden, and what asked for it: the settings outlive the hide so
      // the same narrowing can be put back without building the picks again.
      commit(s=>({...s,original:true,hideWhat:what,hideMode:mode,
        hidden:{blocks:kept,rows,camera:s.hidden?.camera??s.camera,what,mode,choice},
        hideMemory:{choice,what,mode}}))
    }catch(error){setError(error.message)}finally{setBusy(false)}
  }
  function showEverything(){commit(s=>({...s,hidden:null,camera:s.hidden?.camera||s.camera}))}
  async function sourceBlock(id,rowId){
    // On a packed sheet a block's place is not its place in the file, so the
    // fragment already laid out is what the camera is fitted to.
    if(hiddenBlocks?.length||motifBlockIds){
      const fragment=originalFragments.find(f=>!f.aggregate&&f.sourceBlock===Number(id))
      if(!fragment){setNotice(`Block ${id} is hidden. Show all blocks to open it.`);return}
      patch({sourceBlock:Number(id),original:true,camera:fitCamera({fragments:[fragment]},size.width,size.height),...(rowId?{highlighted:addHighlight(state.highlighted,rowId)}:{})})
      return
    }
    // Every path that fetches a block's rows takes a token from the same
    // counter, so a slow earlier response can never replace the block the user
    // asked for last. Without this, rapid ‹ / › clicks or repeated Enter in the
    // block input resolve out of order and the view silently settles on an
    // earlier request instead of the most recent one.
    const token=++blockNav.current
    try{
      const result=await api(`/datasets/${dataset.id}/blocks/${id}/rows`)
      if(token!==blockNav.current)return
      setSource(result)
      const view=fitCamera({fragments:[createFragment(result.block,0,result.length,result.rows.map(r=>r.id),{x:result.layout_start||0})]},size.width,size.height)
      // Arriving on a named sequence, put it in the middle of the window rather
      // than at whatever height its row happens to fall at: a block can be a
      // thousand rows deep and the row followed here is the reason for coming.
      const mode=state.originalRows||'aligned',compact=(state.blockRows?.[Number(id)]||mode)==='compact'
      const lines=rowId?blockRowLines(result.rows.map(r=>r.id),filteredInventory.map(r=>r.id),{compact,wholeView:mode==='compact'}):null
      const line=lines?.get(rowId)
      if(line!=null)view.y=centreOnRow(line,Math.max(...lines.values()),size.height)
      patch({sourceBlock:Number(id),original:true,camera:view,...(rowId?{highlighted:addHighlight(state.highlighted,rowId)}:{})})
    }catch(e){if(token===blockNav.current)setError(e.message)}
  }
  function layerFromFilter(chunks){
    if(!chunks.length)return
    const next=createLayer(`Filtered ${state.layers.length+1}`,state.layers.length,
      chunks.map(c=>createFragment(c.sourceBlock,c.start,c.end,c.rowIds,c.coverage?{coverage:c.coverage}:{})))
    const tidied=tidyLayer(next,ids,chunkGap(next.fragments,size.width))
    tidied.camera=fitCamera(tidied,size.width,size.height)
    commit(s=>({...s,layers:[...s.layers,tidied],active:tidied.id,original:false,selection:[],camera:tidied.camera}))
    setFilterOpen(false)
  }
  function reorderRow(rowId,target,fragmentId){
    // Original aligns every sequence to one row across the whole file, so a move
    // there is a move of that shared order. A layer's chunks each carry their
    // own, so a move there is a move within the chunk whose name was dragged.
    if(state.original)return commit(s=>({...s,rowOrder:moveRowBefore(resolveRowOrder(inventory.map(r=>r.id),s.rowOrder),rowId,target.beforeId)}))
    commit(s=>({...s,layers:s.layers.map(l=>l.id!==s.active?l:{...l,
      fragments:l.fragments.map(f=>f.id===fragmentId?reorderFragmentRow(f,rowId,target.slot):f)})}))
  }
  function transfer(copy=false,destinationId=target){
    const newLayer=destinationId==='new'?createLayer(layerName.trim()||`Layer ${state.layers.length+1}`,state.layers.length):null
    const present=new Set(active.fragments.map(f=>f.id))
    const resolved=resolvePicks(state.selection)
    const waiting=resolved.filter(pick=>!present.has(pick.fragmentId))
    if(waiting.length)setNotice(`${waiting.length} picked ${waiting.length===1?'block is':'blocks are'} not loaded, so ${waiting.length===1?'it was':'they were'} left behind. Navigate to them and move again.`)
    // Nothing to move means nothing to commit: going ahead would leave the
    // workspace pointing at a layer that was never made.
    if(waiting.length===resolved.length)return
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
  // Dropping a picked region. Unlike the two below this only changes what is
  // picked, so it needs no guard on the Original and no undo entry: nothing
  // about the alignment or the layer has changed.
  const deselect=useCallback(pick=>patch({selection:stateRef.current.selection.filter(p=>p!==pick)}),[patch])
  // Taking things out of a layer. Both are guarded on the Original: it is a
  // derived view of the source, so there is nothing in it that was put there
  // and nothing that can be taken back out. Both go through commit, so Undo
  // returns the chunk or the sequence exactly as it was.
  const removeBlock=useCallback(fragment=>{
    if(!fragment||stateRef.current.original)return
    commit(s=>({...s,
      layers:s.layers.map(l=>l.id===s.active?removeFragment(l,fragment.id):l),
      selection:s.selection.filter(pick=>pick.fragmentId!==fragment.id)}))
    setNotice('Chunk removed from the layer. Undo puts it back.')
  },[commit])
  const removeRow=useCallback(rowId=>{
    if(stateRef.current.original)return
    commit(s=>{
      const layers=s.layers.map(l=>l.id===s.active?removeRowFromLayer(l,rowId):l)
      // A chunk holding nothing but this sequence went with it, so picks naming
      // either the sequence or a chunk that no longer exists have to go too.
      const kept=new Set(layers.find(l=>l.id===s.active)?.fragments.map(f=>f.id)||[])
      return {...s,layers,
        highlighted:removeHighlight(s.highlighted,rowId),
        selection:s.selection
          .map(pick=>({...pick,rowIds:(pick.rowIds||[]).filter(id=>id!==rowId)}))
          .filter(pick=>pick.rowIds.length&&kept.has(pick.fragmentId))}
    })
    setNotice('Sequence removed from every chunk in this layer. Undo puts it back.')
  },[commit])
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
  // The regions sequence export writes: whatever is picked, or else every
  // addressable chunk of the layer on screen.
  const exportRegions=useMemo(()=>{
    const fragments=coordinateFragments(active)
    const byId=new Map(fragments.map(f=>[f.id,f]))
    const picks=state.selection.map(pick=>{
      const fragment=byId.get(pick.fragmentId)
      return fragment&&{block:fragment.sourceBlock,start:pick.start,end:pick.end,ids:pick.rowIds}
    }).filter(Boolean)
    if(picks.length)return picks
    return fragments.map(f=>({block:f.sourceBlock,start:f.start,end:f.end,ids:f.rowIds}))
  },[active,state.selection])
  async function exportSequences(){
    if(!exportRegions.length)return
    setBusy(true);setError('')
    try{
      const parts=[]
      for(const region of exportRegions)parts.push(await api(`/datasets/${dataset.id}/export`,{...region,format:exportFormat}))
      const suffix={fasta:'fa',clustal:'aln','phylip-relaxed':'phy',maf:'maf'}[exportFormat]
      download(`${dataset.name||'alignment'}-${active.name}.${suffix}`,parts.join(''),'text/plain')
      setNotice(`Exported ${exportRegions.length} ${exportRegions.length===1?'region':'regions'}.`)
    }catch(e){setError(e.message)}finally{setBusy(false)}
  }
  async function save(){try{const value={...workspaceForSave(state,originalFragments),source:{id:dataset.id,name:dataset.name}};await api(`/datasets/${dataset.id}/workspace`,value,undefined,'PUT');download(`${dataset.name||'alignment'}.layers.json`,JSON.stringify(value,null,2),'application/json');setNotice('Layer workspace saved.')}catch(e){setError(e.message)}}
  async function applyMetadata(content,suffix){await api(`/datasets/${dataset.id}/metadata`,{content,suffix});const rows=[];for(let offset=0;;offset+=5000){const page=await api(`/datasets/${dataset.id}/sequences?offset=${offset}&limit=5000`);rows.push(...page.rows);if(rows.length>=page.total)break}setInventory(rows);setRevision(v=>v+1);setNotice('Genome links updated; all alignment rows remain available.')}
  // The server owns the list of readers; this fallback only matters if the
  // capabilities call has not answered yet.
  const formatChoices=useMemo(()=>Object.entries(capabilities?.format_labels||{
    maf:'MAF',fasta:'Aligned FASTA',clustal:'Clustal',stockholm:'Stockholm',
    'phylip-relaxed':'PHYLIP (relaxed names)',phylip:'PHYLIP (strict 10-character names)',
    nexus:'NEXUS',msf:'GCG MSF',xmfa:'XMFA / Mauve'}),[capabilities])
  const exportChoices=useMemo(()=>Object.entries(capabilities?.export_formats||{fasta:'Aligned FASTA',clustal:'Clustal','phylip-relaxed':'PHYLIP (relaxed names)',maf:'MAF'}),[capabilities])
  const readerLabel=dataset&&(capabilities?.format_labels?.[dataset.format]||dataset.format)

  async function chooseFile(){
    if(window.electronAPI?.selectFile){try{const selected=await window.electronAPI.selectFile(path||undefined);if(selected)startImport({path:selected,format})}catch(e){setError(e.message)}}
    else file.current.click()
  }
  const selectionCells=state.selection.reduce((n,s)=>n+(s.end-s.start)*s.rowIds.length,0)
  const selectionRows=new Set(state.selection.flatMap(s=>s.rowIds)).size
  const namedRow=inspect?.rowId?displayInventory.find(r=>r.id===inspect.rowId):null
  // The width the camera actually covers, which under plane zoom is wider than
  // the window: the toolbar should name every block on screen, not the first.
  const sourceRange=visibleSourceRange(originalFragments,renderState.camera,renderView.width)
  const visibleSourceBlock=(sourceRange&&!sourceRange.grouped?sourceRange.first:null)||state.sourceBlock
  // The neighbour to step to: the next block in the file, or the next one still
  // on the sheet when the rest are hidden. Null where there is nowhere to go.
  const stepBlock=delta=>{
    if(!hiddenBlocks?.length&&!motifBlockIds)return visibleSourceBlock+delta>=1&&visibleSourceBlock+delta<=blocks.total?visibleSourceBlock+delta:null
    const kept=originalFragments.map(f=>f.sourceBlock),at=kept.indexOf(visibleSourceBlock)
    return kept[(at<0?0:at)+delta]??null
  }
  const selectableFragments=useMemo(()=>coordinateFragments(layer),[layer])
  const selectedFragment=selectableFragments.find(f=>f.id===range.fragment)||selectableFragments[0]
  const rowChoices=useMemo(()=>{
    if(!selectedFragment)return []
    const members=new Set(selectedFragment.rowIds),query=rowQuery.trim().toLowerCase()
    return inventory.filter(r=>members.has(r.id)&&(r.label||r.source).toLowerCase().includes(query))
  },[inventory,selectedFragment,rowQuery])
  return <section className={`alignment-layers ${theme==='light'?'light':''} ${selectionDrag?'is-selection-dragging':''}`} ref={explorerRoot} aria-label="Alignment Explorer" data-screenshot-capture="view">
    {(error||notice)&&<div className={`al-notice ${error?'error':''}`} role={error?'alert':'status'}>{error||notice}{error&&attempt&&lastImport.current&&<span className="al-notice-fix">{attempt.format?`Read as ${capabilities?.format_labels?.[attempt.format]||attempt.format}.`:'No format matched this file.'} Reopen as <select aria-label="Reopen with a different format" defaultValue="" onChange={e=>{if(e.target.value)reopenAs(e.target.value)}}><option value="">choose a format…</option>{formatChoices.filter(([value])=>value!==attempt.format).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></span>}{error&&dataset&&<button onClick={()=>{setError('');setRevision(n=>n+1)}}>Retry loading</button>}<button aria-label="Dismiss message" onClick={()=>{setError('');setNotice('')}}>×</button></div>}
    <MotifProgress operation={motifOperation}/>
    {(job||opening)&&<ImportProgress job={job} opening={!!opening} cancelling={cancelling}
      name={opening||importName.current}
      onCancel={()=>{setCancelling(true);api(`/jobs/${job.id}/cancel`,{}).catch(e=>setError(e.message))}}/>}
    {!dataset?<div className="al-welcome"><div className="al-mark">▱<br/>▱<br/>▱</div><h2>Follow sequences across layers</h2><p>Start with a familiar alignment. Select a region, move it to a layer, and connect the pieces that matter.</p><div><button className="primary" disabled={busy||!!job} onClick={()=>setDialog('open')}>Open an alignment</button><button disabled={busy||!!job} onClick={()=>startImport({name:'Layer exploration example',format:'fasta',content:demoAlignment()})}>Explore example</button></div><small>MAF · aligned FASTA · XMFA · Stockholm · Clustal · PHYLIP<br/>All sequences are included, with or without linked genomes.</small></div>:<div className="al-workspace">
      <aside className={`al-sidebar ${state.sidebarCollapsed&&!selectionDrag?'collapsed':''}`}>
        <div className={`al-sidebar-bar ${layersOpen?'':'closed'}`}>
          <button className="al-layers-toggle" aria-expanded={layersOpen} onClick={()=>setLayersExpanded(v=>!v)}><i/>Layers</button>
          <button className="al-new-layer" title="New empty layer" aria-label="New empty layer" onClick={()=>{setLayersExpanded(true);const next=createLayer(`Layer ${state.layers.length+1}`,state.layers.length);commit(s=>({...s,layers:[...s.layers,next],active:next.id,original:false,selection:[],camera:next.camera}))}}>＋</button>
          <button className="al-sidebar-toggle" aria-label={state.sidebarCollapsed?'Expand alignment sidebar':'Collapse alignment sidebar'} aria-expanded={!state.sidebarCollapsed} onClick={()=>patch({sidebarCollapsed:!state.sidebarCollapsed})}><DrawerChevron pointsRight={!!state.sidebarCollapsed}/></button>
        </div>
        <div className="al-sidebar-content">
        {layersOpen&&<div className="al-section"><div className="al-layer-targets">
        <button className={`al-original ${state.original?'selected':''}`} onClick={()=>switchLayer('original')}><i/> <span>Original alignment<small>{blockSummary}</small>{!!narrowedSummary&&<small className="al-narrowed">{narrowedSummary}</small>}</span></button>
        {state.original&&<label className="al-check al-overlay-check"><input type="checkbox" checked={!!state.overlay} onChange={e=>patch({overlay:e.target.checked})}/>Highlight regions in other layers</label>}
        <div className="al-layer-list">{state.layers.map(l=><div key={l.id} data-layer-drop={l.id} data-selection-drop={l.id} className={`al-layer ${selectionDrag?.target===l.id?'selection-drop-hover':''} ${selectionDrag&&!state.original&&l.id===state.active?'selection-drop-disabled':''} ${!state.original&&l.id===state.active?'selected':''}`} draggable onDragStart={e=>{e.dataTransfer.setData('application/x-alignment-layer',l.id);e.dataTransfer.effectAllowed='move'}} onDragOver={e=>{if(e.dataTransfer.types.includes('application/x-alignment-layer')){e.preventDefault();e.currentTarget.classList.add('drop')}}} onDragLeave={e=>e.currentTarget.classList.remove('drop')} onDrop={e=>{e.preventDefault();e.currentTarget.classList.remove('drop');requestMerge(e.dataTransfer.getData('application/x-alignment-layer'),l.id)}}><button onClick={()=>switchLayer(l.id)}><i style={{background:l.color}}/><span>{l.name}<small>{l.fragments.length} {l.fragments.length===1?'chunk':'chunks'} · {new Set(l.fragments.flatMap(f=>f.rowIds)).size} sequences</small></span></button><button className="al-rename" aria-label={`Rename ${l.name}`} onClick={()=>{setLayerName(l.name);setDialog({rename:l.id})}}>✎</button><button className="al-rename" aria-label={`Remove layer ${l.name}`} title="Remove this layer (undo available; Original stays intact)" onClick={()=>commit(s=>({...s,layers:s.layers.filter(item=>item.id!==l.id),original:s.original||s.active===l.id,selection:[]}))}>×</button></div>)}</div>
        {!!selectionRows&&<button className={`al-new-layer-drop ${selectionDrag?.target==='new'?'selection-drop-hover':''}`} data-selection-drop="new" onClick={()=>transfer(false,'new')}><b>＋</b><span>New layer<small>Drop the picked cells here</small></span></button>}
        </div>
</div>}
        <details className="al-section" open={selectionRows>0?true:undefined}><summary>Selection</summary><p className="al-hint">Click a sequence name or a block header to pick it, or drag with Select or Columns to pick a region. Picks add up; click one again to drop it. Then drag any of them to a layer or ＋ New layer.</p><button disabled={!selectableFragments.length} title={selectableFragments.length?undefined:'Zoom in to an individual source block to select by coordinates.'} onClick={()=>{const f=selectableFragments[0];setRange({fragment:f?.id||'',start:(f?.start||0)+1,end:Math.min(f?.end||100,(f?.start||0)+100)});setSelectRows([]);setDialog('select')}}>Select by coordinates</button>        {!!selectionRows&&<div className="al-selection-bar" role="region" aria-label="Selected region actions"><strong>{selectionRows?`${selectionRows} ${selectionRows===1?'sequence':'sequences'} picked`:'Nothing picked'}</strong><small>{selectionRows?`${state.selection.length} ${state.selection.length===1?'pick':'picks'} · ${selectionCells.toLocaleString()} cells`:'Click a name or a block header, or drag with Select or Columns.'}</small>{!!selectionRows&&<><select aria-label="Move selection to layer" value={target} onChange={e=>setTarget(e.target.value)}><option value="new">New layer…</option>{state.layers.filter(l=>l.id!==state.active||state.original).map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select>{target==='new'&&<input aria-label="New layer name" placeholder={`Layer ${state.layers.length+1}`} value={layerName} onChange={e=>setLayerName(e.target.value)}/>}<button className="primary" onClick={()=>transfer(false)}>{state.original?'Place in layer':'Move to layer'}</button>{!state.original&&<button onClick={()=>transfer(true)}>Copy instead</button>}<button onClick={()=>patch({selection:[],highlighted:[]})}>Clear selection</button></>}</div>}
</details>
        <details className="al-section" open={filterOpen?true:undefined}><summary>Filter</summary>
          <p className="al-hint">Narrow the alignment to the sequences and blocks you want, then build a layer from them or show only those in Original.</p>
          <button className={filterOpen?'selected':''} aria-expanded={filterOpen} onClick={()=>setFilterOpen(v=>!v)}>{filterOpen?'Close filter':'Filter sequences & blocks'}</button>
          {state.filter&&<div className="al-filter-active" role="status"><strong>{filterOn?'Original is filtered':'Filter is off'}</strong>
            <small>{(state.filter.sequences||[]).length.toLocaleString()} sequences · {(state.filter.blocks||[]).length.toLocaleString()} blocks</small>
            <button onClick={()=>patch({filterOff:filterOn})}>{filterOn?'Turn filter off':'Turn filter on'}</button>
            <button onClick={()=>patch({filter:null,filterOff:false})}>Clear filter</button></div>}
        </details>
        <details className="al-section"><summary>Alignment & loading</summary><strong className="al-dataset-name">{dataset.name}</strong><button onClick={()=>setDialog('open')}>Open alignment</button><div className="al-source"><small>{blocks.total} source {blocks.total===1?'block':'blocks'} · {inventory.length} {inventory.length===1?'sequence':'sequences'}</small>
          {!!readerLabel&&<small className="al-reader">Read as <strong>{readerLabel}</strong>{dataset.format_chosen?' (you chose this format)':''}{lastImport.current&&<> · <button className="al-link" onClick={()=>{setFormat(dataset.format||'auto');setDialog('open')}}>read as another format</button></>}</small>}<button onClick={()=>setDialog('links')}>Link local genomes</button></div>
</details>
        <details className="al-section"><summary>Display</summary>{state.original&&<label className="al-row-mode">Sequence rows<select aria-label="Original sequence rows" value={state.originalRows||'aligned'} onChange={e=>patch({originalRows:e.target.value,blockRows:{}})}><option value="aligned">Align across source blocks</option><option value="compact">Collapse absent rows</option></select><small>Use the row icon on an individual block to override this.</small></label>}</details>
        <details className="al-section"><summary>Workspace & export</summary><div className="al-actions"><button disabled={!history.current.past.length} onClick={()=>undo(false)}>Undo</button><button disabled={!history.current.future.length} onClick={()=>undo(true)}>Redo</button></div><button onClick={save}>Save workspace</button><button onClick={()=>workspace.current.click()}>Load workspace</button><button onClick={()=>{const url=canvas.current?.image();if(url){const a=document.createElement('a');a.href=url;a.download=`${dataset.name}-${active.name}.png`;a.click()}}}>Export image</button>
          <div className="al-source"><strong>Export sequences</strong><label>Format<select value={exportFormat} onChange={e=>setExportFormat(e.target.value)}>{exportChoices.map(([value,label])=><option key={value} value={value} disabled={exportRegions.length>1&&(value==='clustal'||value==='phylip-relaxed')}>{label}</option>)}</select></label><button disabled={busy||!exportRegions.length} onClick={exportSequences}>{state.selection.length?'Export picked region':'Export this layer'}</button><small>{!exportRegions.length?'Zoom in to an individual source block, or pick a region, to export its columns.':state.selection.length?`${exportRegions.length} picked ${exportRegions.length===1?'region':'regions'}, in each sequence's own aligned columns.`:`Every chunk on screen: ${exportRegions.length}. Pick a region to export just that.`}{exportRegions.length>1&&' Clustal and PHYLIP hold one alignment each, so several regions export as FASTA or MAF.'}</small></div></details>
        </div>
      </aside>
      {filterOpen&&<FilterPanel dataset={dataset} genomes={genomes} onError={setError}
        filterApplied={filterOn} applied={state.filter}
        onClose={()=>setFilterOpen(false)}
        onNewLayer={layerFromFilter}
        onApplyToOriginal={value=>patch({filter:value,filterOff:false,original:true})}
        onClearFilter={()=>patch({filter:null,filterOff:false})}/>}
      <main className="al-main"><div className="al-toolbar" data-alignment-control-bar><div className="al-tools"><button className={state.mode==='pan'?'selected':''} aria-pressed={state.mode==='pan'} title="Drag to move the sheet. Space does this from any mode." onClick={()=>patch({mode:'pan'})}>Pan</button>
      <SelectTool mode={state.mode} kind={selectKind} picked={state.selection.length} rows={selectionRows} root={explorerRoot.current}
        onMode={mode=>patch({mode})} onKind={setSelectKind} onClear={()=>patch({selection:[],highlighted:[]})}/></div><button disabled={state.original||!active.fragments.length} onClick={()=>commit(s=>{const tidied=tidyLayer(active,ids,chunkGap(active.fragments,size.width)),view=fitCamera(tidied,size.width,size.height);return {...s,layers:s.layers.map(l=>l.id===active.id?{...tidied,camera:view}:l),camera:view}})}>Auto arrange</button><ZoomTool panel={!!state.planeZoom} plane={renderState.camera.plane} root={explorerRoot.current} onMode={zoomMode}/><ColourTool scheme={state.colourScheme} palette={state.palette} shading={state.shading} legendOverlay={!!state.legendOverlay}
        cohort={cohort} scale={conservation?.scale} light={theme==='light'} root={explorerRoot.current}
        motifs={motifs} motifsSaved={motifsSaved} config={config} disabled={motifOperation.running}
        hideUnmatched={!!state.hideUnmatchedMotifBlocks} onApply={applyColour}/>{state.original&&<div className="al-source-nav" title={sourceRange?.grouped?'This overview groups source blocks. Enter a block number to open one.':undefined}><label>{sourceRange?.grouped?`Blocks ${sourceRange.first}–${sourceRange.last}`:'Block'} <input aria-label="Jump to source block" type="number" min="1" max={blocks.total} placeholder={sourceRange?.grouped?'Block…':undefined} key={sourceRange?.grouped?'grouped':visibleSourceBlock} defaultValue={sourceRange?.grouped?'':visibleSourceBlock} onKeyDown={e=>{if(e.key==='Enter'){const id=Number(e.currentTarget.value);if(Number.isInteger(id)&&id>=1&&id<=blocks.total)sourceBlock(id)}}}/></label><button aria-label="Previous source block" disabled={!!sourceRange?.grouped||stepBlock(-1)==null} onClick={()=>sourceBlock(stepBlock(-1))}>‹</button><button aria-label="Next source block" disabled={!!sourceRange?.grouped||stepBlock(1)==null} onClick={()=>sourceBlock(stepBlock(1))}>›</button></div>}<button className={`al-filter-flag ${filterOn?'selected':''}`} disabled={!state.filter}
  aria-pressed={filterOn}
  title={!state.filter?'No filter is set. Build one in the sidebar.':filterOn?`Original is filtered to ${(state.filter.sequences||[]).length.toLocaleString()} sequences and ${(state.filter.blocks||[]).length.toLocaleString()} blocks. Click to turn it off; the filter is kept and the source is unchanged.`:'The filter is set but not applied. Click to turn it back on.'}
  onClick={()=>patch({filterOff:filterOn})}>Filter</button>
<button ref={hideButton} className={`al-hide-flag ${hiding?'selected':''}`} disabled={busy||(!hiding&&!canHide(hideChoice)&&!state.hideMemory)}
  aria-pressed={hiding} aria-expanded={hiding?undefined:hideMenu}
  title={hiding?`Showing ${hidingSummary}. Click to bring back everything hidden.`:canHide(hideChoice)||state.hideMemory?'Choose what to hide':'Select sequences and/or blocks to then hide blocks with no highlighted regions'}
  onClick={()=>{if(hiding)showEverything();else{setHideDraft({what:state.hideWhat||'blocks',mode:state.hideMode||'or'});setHideMenu(open=>!open)}}}>{hiding?'Show':'Hide'}</button>
<LayerCycle layers={allLayers} active={layer.id} onChoose={switchLayer} dataset={dataset} inventory={displayInventory} light={theme==='light'} revision={revision}/></div>
        <div className="al-stage">{!!zoomHint&&state.planeZoom&&<div className="al-zoom-hint" role="status" key={zoomHint}><span>Panel zoom is at full size. Switch to <strong>Alignment</strong> for sequence-level zoom.</span><button className="primary" onClick={()=>zoomMode(false)}>Switch</button><button aria-label="Dismiss zoom hint" onClick={dismissZoomHint}>×</button></div>}
        {!!state.legendOverlay&&(!!scheme.legend||scheme.id==='motif')&&<ColourLegend legend={scheme.id==='motif'?motifLegend(snapshot?.settings.motifs||[]):scheme.legend(theme==='light',conservation?.scale,state.palette?.[scheme.id],state.shading)}
          cohort={scheme.cohort?cohort:null} onDismiss={()=>patch({legendOverlay:false})}/>}
        {scheme.id==='motif'&&(motifSearch.pending||motifSearch.failure||motifBlocks.blocks)&&<div className="al-motif-tile-status" role="status">{motifSearch.failure|| (motifSearch.pending?'Loading prepared motif tiles…':`${motifBlocks.blocks.length.toLocaleString()} matching blocks`)}{motifBlocks.blocks&&<button onClick={()=>patch({hideUnmatchedMotifBlocks:false})}>Show unmatched blocks</button>}</div>}
        <LayerCanvas ref={canvas} layer={layer} state={canvasState} navigationCamera={renderState.camera} inventory={displayInventory} tiles={tiles} annotations={annotations} connections={connections} offWindow={offWindow} counts={counts} gaps={gaps} conservation={conservation} light={theme==='light'} config={config} onCamera={camera} onCopyChunk={copyChunk} onBlockToLayer={blockToLayer} onRemoveBlock={removeBlock} onRemoveRow={removeRow} onDeselect={deselect} onAggregate={(f,inner)=>inner?sourceBlock(inner.block):camera(fitCamera({fragments:[{...f,rowIds:[],layoutRows:1}]},size.width,size.height))} onToggleRows={f=>patch({blockRows:{...state.blockRows,[f.sourceBlock]:f.compact?'aligned':'compact'}})} onSelection={(value,lit)=>patch({selection:value,mode:'pan',...(lit?.length?{highlighted:toggleHighlights(state.highlighted,lit)}:{})})} onSelectionDrag={dragSelection} onSelectionDrop={dropSelection} onMove={(id,x,y)=>commit(s=>({...s,layers:s.layers.map(l=>l.id===s.active?{...l,fragments:l.fragments.map(f=>f.id===id?{...f,x,y}:f)}:l)}))} onHighlight={id=>patch({highlighted:addHighlight(state.highlighted,id)})} onUnlight={id=>patch(unlightRow(state,id))} onInspect={setInspect} onSize={setSize} onFallback={setFallback} onSourceBlock={sourceBlock} onReorderRow={reorderRow} onZoomLimit={noteZoomLimit}/></div>
        <div className="al-status"><span>{pending?'Loading regional detail…':layer.fragments.some(f=>f.aggregate)?'Block presence overview':renderState.camera.scale*renderState.camera.plane>=NUCLEOTIDE_LETTER_THRESHOLD?'Sequence detail':renderState.camera.scale*renderState.camera.plane>=.65?'Base patterns':(scheme.status||state.shading==='uniform')?'Binned':'Binned agreement to first row'}{scheme.status?` \u00b7 ${scheme.status}${scheme.cohort?` among ${cohort?.ids.length||0} ${cohort?.ids.length===1?'sequence':'sequences'}${cohort?.picked?' picked':' in view'}`:''}`:''}{renderState.camera.plane<1?` · Whole panel at ${Math.round(renderState.camera.plane*100)}%`:''}{fallback?' · Canvas fallback':''}</span><span>{inspect?.kind==='aggregate'?`${namedRow?.label||''} · present in ${inspect.aggregate.presence?.[inspect.rowId]||0} of ${inspect.aggregate.count} source blocks (${inspect.aggregate.first}–${inspect.aggregate.last})`:inspect?.kind==='connection'?`${inventory.find(r=>r.id===inspect.connection.rowId)?.label||'Sequence'} · ${inspect.connection.columns==null?'Different source blocks: alignment distance unavailable':inspect.connection.columns<0?`${-inspect.connection.columns} overlapping alignment columns`:`${inspect.connection.columns} omitted alignment columns`} · ${counts[inspect.connection.id]?.bases??'?'} ungapped bases`:inspect?.kind==='cell'?`${namedRow?.label||''} · block ${inspect.fragment.sourceBlock}, column ${(inspect.column+1).toLocaleString()}${inspect.base?` · ${inspect.base}`:''}${inspect.placed?.length?` · In layers: ${inspect.placed.join(', ')}`:''}${inspect.features?.length?` · ${inspect.features.map(f=>f.type).join(', ')}`:''}`:'Click a name or a block header to pick it \u00b7 click a cell or a string to follow its path.'}</span></div>

        {!!warnings.length&&<div className="al-annotation-warning">Annotations unavailable for {warnings.length} visible rows: {warnings[0].message}</div>}
      </main>
    </div>}
    {hideMenu&&!hiding&&explorerRoot.current&&createPortal(<div className="al-hide-menu" role="dialog" aria-label="Hide options"
      style={{top:menuAnchor.top,right:menuAnchor.right}} onPointerDown={e=>e.stopPropagation()}>
      <label>What<select aria-label="What to hide" value={hideWhat} onChange={e=>setHideDraft(v=>({...v,what:e.target.value}))}>
        <option value="blocks">Blocks</option><option value="sequences">Sequences</option><option value="both">Both</option>
      </select><small>{hideWhat==='sequences'?'Keep the picked sequences, and the blocks still holding one.'
        :hideWhat==='both'?'Keep the picked sequences, in the blocks that pass.'
        :'Keep the blocks that pass; every sequence stays.'}</small></label>
      {hideWhat!=='sequences'&&<label>Condition<select aria-label="Hide condition" value={hideMode} onChange={e=>setHideDraft(v=>({...v,mode:e.target.value}))}>
        <option value="or">Or</option><option value="and">And</option>
      </select><small>{hideMode==='and'
        ?'Every picked sequence has to be in a block for it to stay, and picked blocks are the only ones considered.'
        :'The picked blocks, and every block the picked sequences run through.'}</small></label>}
      <div className="al-hide-actions"><button onClick={()=>setHideMenu(false)}>Cancel</button>
        <button className="primary" disabled={busy||!canHide(hideChoice)} onClick={()=>applyHide(hideChoice,{what:hideWhat,mode:hideMode})}>Apply</button>
        {!!state.hideMemory&&<button disabled={busy} title="Hide to the last set of picks, with the settings it used"
          onClick={()=>applyHide(state.hideMemory.choice,{what:state.hideMemory.what,mode:state.hideMemory.mode})}>Previous</button>}
      </div>
    </div>,explorerRoot.current)}
    {selectionDrag&&<><div className="al-selection-dim"/><div className="al-selection-ghost" role="status" style={{left:selectionDrag.x+16,top:selectionDrag.y+16}}><strong>{selectionRows} sequences · {state.selection.length} regions</strong><small>{selectionDrag.target==='new'?'Release to create a new layer':selectionDrag.target?`Release to ${state.original?'place in':'move to'} ${state.layers.find(l=>l.id===selectionDrag.target)?.name}`:'Drop on a sidebar layer or ＋ New layer · Esc cancels'}</small></div></>}
    {merge&&<div className="al-modal-shade"><div className="al-modal" role="dialog" aria-modal="true" aria-label="Overlapping chunks"><h3>These layers contain overlapping chunks</h3><p>Combine overlapping source intervals into one chunk with both sets of sequences, or preserve each chunk separately. Unselected cells remain blank.</p><button className="primary" onClick={()=>finishMerge(merge.from,merge.to,true)}>Combine overlapping chunks</button><button onClick={()=>finishMerge(merge.from,merge.to,false)}>Keep chunks separate</button><button onClick={()=>setMerge(null)}>Cancel</button></div></div>}
    {dialog&&<div className="al-modal-shade"><div className="al-modal" role="dialog" aria-modal="true" aria-label={typeof dialog==='string'?dialog:'Rename layer'}><button className="al-close" aria-label="Close dialog" onClick={()=>setDialog(null)}>×</button>
      {dialog==='open'&&<><h3>Open a nucleotide alignment</h3><p>Load a local MAF, aligned FASTA, Clustal, Stockholm, PHYLIP, NEXUS, MSF or XMFA file. Compressed text files are supported.</p><label>Format<select value={format} onChange={e=>setFormat(e.target.value)}><option value="auto">Detect automatically</option>{formatChoices.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><small>{format==='auto'?'The file is read by its own signature. The format used is shown once it loads, so a wrong guess can be corrected here.':'This reader is used whatever the file claims to be.'}</small><button className="primary" disabled={busy||!!job} onClick={chooseFile}>Choose file</button><label>Or enter a local file path<input placeholder="/path/to/alignment.maf" value={path} onChange={e=>setPath(e.target.value)}/></label><button disabled={!path||busy||!!job} onClick={()=>startImport({path,format})}>Open path</button><button disabled={busy||!!job} onClick={()=>startImport({name:'Layer exploration example',format:'fasta',content:demoAlignment()})}>Explore example</button><small>The source file stays unchanged. Layer layouts are stored separately.</small></>}
      {dialog?.rename&&<><h3>Edit layer</h3>
        <label>Colour<div className="al-layer-colour">
          <i style={{background:state.layers.find(l=>l.id===dialog.rename)?.color}}/>
          <button onClick={()=>setColorTarget(dialog.rename)}>Change colour…</button>
        </div></label><input aria-label="Layer name" autoFocus value={layerName} maxLength={120} onChange={e=>setLayerName(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&layerName.trim()){commit(s=>({...s,layers:s.layers.map(l=>l.id===dialog.rename?{...l,name:layerName.trim()}:l)}));setDialog(null);setLayerName('')}}}/><button className="primary" disabled={!layerName.trim()} onClick={()=>{commit(s=>({...s,layers:s.layers.map(l=>l.id===dialog.rename?{...l,name:layerName.trim()}:l)}));setDialog(null);setLayerName('')}}>Save name</button></>}
      {dialog==='select'&&<><h3>Select by alignment coordinates</h3>{!selectedFragment?<p className="al-hint">This view groups several source blocks together, so there are no individual alignment columns to address. Zoom in until single blocks are shown, then select by coordinates.</p>:<><label>{state.original?'Source block':'Chunk'}<select value={selectedFragment.id} onChange={e=>{const f=selectableFragments.find(f=>f.id===e.target.value);setRange({fragment:f.id,start:f.start+1,end:f.end});setSelectRows([])}}>{selectableFragments.map(f=><option key={f.id} value={f.id}>Block {f.sourceBlock} · {f.start+1}–{f.end}</option>)}</select></label><div className="al-range"><label>First column<input type="number" min={selectedFragment.start+1} max={selectedFragment.end} value={range.start} onChange={e=>setRange({...range,start:Number(e.target.value)})}/></label><label>Last column<input type="number" min={selectedFragment.start+1} max={selectedFragment.end} value={range.end} onChange={e=>setRange({...range,end:Number(e.target.value)})}/></label></div><label>Sequences <small>None checked means all rows in this region.</small><input placeholder="Search sequences" value={rowQuery} onChange={e=>setRowQuery(e.target.value)}/></label><div className="al-row-choices">{rowChoices.slice(0,200).map(r=><label key={r.id}><input type="checkbox" checked={selectRows.includes(r.id)} onChange={e=>setSelectRows(v=>e.target.checked?[...v,r.id]:v.filter(id=>id!==r.id))}/>{r.label||r.source}</label>)}</div>{rowChoices.length>200&&<small>Showing the first 200 of {rowChoices.length.toLocaleString()} matching sequences. Search to narrow the list, or leave every box unchecked to select all {selectedFragment.rowIds.length.toLocaleString()} rows in this block.</small>}<button className="primary" disabled={range.end<range.start||range.start<=selectedFragment.start||range.end>selectedFragment.end} onClick={()=>{patch({mode:'pan',selection:[{fragmentId:selectedFragment.id,start:range.start-1,end:range.end,rowIds:selectRows.length?selectRows:selectedFragment.rowIds}]});setDialog(null)}}>Select region</button></>}</>}
      {dialog==='links'&&<><h3>Link local genomes</h3><p>Link sequence identity and contig to local genome data. Coordinate-aware MAF rows use the same GFF3 feature mapping as the existing alignment view. Saved MAFFT annotations are also retained.</p><button onClick={()=>metadata.current.click()}>Import TSV / JSON metadata</button><small>Fields: source (or id), genome_key, chrom, assembly, label. FASTA coordinates: genomic_start / genomic_end (1-based), strand. Links never remove rows.</small><label>Alignment sequence<select value={link.row} onChange={e=>setLink({...link,row:e.target.value})}><option value="">Choose a sequence</option>{inventory.map(r=><option key={r.id} value={r.id}>{r.label} {r.metadata?.genome_key?'· linked':''}</option>)}</select></label><label>Local genome<select value={link.genome} onChange={e=>setLink({...link,genome:e.target.value})}><option value="">Choose a genome</option>{genomes.map(g=><option key={getGenomeKey(g)} value={getGenomeKey(g)}>{g.display_name||g.name||g.species||getGenomeKey(g)}</option>)}</select></label><label>Contig / chromosome<input placeholder="e.g. chr1" value={link.chrom} onChange={e=>setLink({...link,chrom:e.target.value})}/></label><button disabled={!link.row||!link.genome||!link.chrom} onClick={()=>applyMetadata(JSON.stringify([{id:link.row,genome_key:link.genome,chrom:link.chrom}]),'.json').then(()=>patch({annotations:true})).catch(e=>setError(e.message))}>Apply link</button><small>Unpositioned FASTA rows need coordinate metadata or saved alignment annotations; matching a name alone cannot place genomic features.</small></>}
    </div></div>}
    <GenomeColorPicker isOpen={!!colorTarget} theme={theme} title="Layer colour"
      subtitle={state.layers.find(l=>l.id===colorTarget)?.name||''}
      palette={genomeColorPalette(config)}
      renderPreview={color=><div className="al-colour-preview">
        {[42,26,64,18].map((width,i)=><span key={i} style={{background:color,width:`${width}%`}}/>)}
      </div>}
      currentColor={state.layers.find(l=>l.id===colorTarget)?.color||''}
      onApply={color=>commit(s=>({...s,layers:s.layers.map(l=>l.id===colorTarget?{...l,color}:l)}))}
      onClose={()=>setColorTarget(null)}/>
    <input ref={file} hidden type="file" accept=".maf,.fa,.fasta,.fas,.fna,.mfa,.afa,.fsa,.aln,.clw,.xmfa,.sto,.stk,.stockholm,.phy,.phylip,.nex,.nexus,.nxs,.msf,.gz" onChange={async e=>{const f=e.target.files?.[0];e.target.value='';if(!f)return;const localPath=window.electronAPI?.getPathForFile?.(f)||f.path;if(localPath){startImport({path:localPath,format});return}if(f.size>20_000_000||f.name.endsWith('.gz')){setPath('');setNotice('Use the local file path for compressed files or files larger than 20 MB.');return}startImport({name:f.name,content:await f.text(),format})}}/>
    <input ref={metadata} hidden type="file" accept=".tsv,.json" onChange={async e=>{const f=e.target.files?.[0];e.target.value='';if(f)try{await applyMetadata(await f.text(),f.name.endsWith('.tsv')?'.tsv':'.json')}catch(error){setError(error.message)}}}/>
    <input ref={workspace} hidden type="file" accept=".json" onChange={async e=>{const f=e.target.files?.[0];e.target.value='';if(f)try{const value=JSON.parse(await f.text());if(value.source?.id&&value.source.id!==dataset.id)throw new Error('This workspace references a different alignment. Open that source first.');const next=validateLayerWorkspace(value,ids);const token=++blockNav.current;const block=await api(`/datasets/${dataset.id}/blocks/${next.sourceBlock}/rows`);if(token!==blockNav.current)return;setSource(block);commit(next.original?{...next,camera:{...next.camera,x:next.camera.x+(block.layout_start||0)}}:next)}catch(error){setError(error.message)}}}/>
  </section>
}
