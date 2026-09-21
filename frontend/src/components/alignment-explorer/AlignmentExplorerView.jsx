import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { getAssemblyAccession, getGenomeKey, normalizeGenomeRecord } from '../../utils/genomeIdentity'
import { API_BASE } from '../../backendRuntime'
import DrawerChevron from '../DrawerChevron'
import LayerCanvas from './LayerCanvas'
import LayerCycle from './LayerCycle'
import ColourLegend from './ColourLegend'
import CursorTool from './CursorTool'
import ColourTool from './ColourTool'
import ControlLabel from './ControlLabel'
import ControlMenu from './ControlMenu'
import { menuPosition, useMenuDismiss } from './menuAnchor'
import useMotifs from './useMotifs'
import useMotifPreparation from '../motifs/useMotifPreparation'
import MotifProgress from '../motifs/MotifProgress'
import { motifTransport } from './motifTransport'
import { loadMotifs, saveMotifs, motifLegend } from './motifs'
import ZoomTool from './ZoomTool'
import ImportProgress from './ImportProgress'
import { layoutOriginal, blockRowLines, centreOnRow } from './originalLayout'
import { hiddenSelection, canHide, hideResult, packBlocks, packedExtent, layerMembership, hideLayerFragments } from './hiding'
import useGapCollapse from './useGapCollapse'
import GapTool from './GapTool'
import useOriginalBlocks from './useOriginalBlocks'
import ControlChevron from './ControlChevron'
import useScrollEdges from './toolbarScroll'
import useLayerData from './useLayerData'
import useBlockContext from './useBlockContext'
import BlockContextGenomic from './BlockContextGenomic'
import { BAND_KINDS } from './comparisonBands'
import { annotationLaneCounts } from './contextModelLayout'
import { classifyGenomeLink, exactGenomeLinks, genomeDisplayName } from './associations'
import FilterPanel from './FilterPanel'
import GenomeColorPicker from '../GenomeColorPicker'
import { genomeColorPalette } from '../../genomeColorSchemes'
import { api, download, demoAlignment, MARGIN_X } from './data'
import { toggleHighlights, emptyWorkspace, createLayer, nextLayerName, createFragment, moveSelection, mergeLayers, layerOverlap, tidyLayer, fitCamera, validateLayerWorkspace, constrainCamera, chunkGap, chunkFasta, workspaceForSave, coordinateFragments, visibleSourceRange, resolveRowOrder, moveRowBefore, reorderFragmentRow, resolvePicks, expandRowPicks, pickedRowIds, selectedRangesForFragment, addHighlight, unlightRow, removeFragment, removeRowFromLayer, removeHighlight, planeViewport, enterPanelZoom, exitPanelZoom, PANEL_ZOOM_HINT_ATTEMPTS, ZOOM_HINT_MS, layerViewAnchor, sourceViewAnchor } from './layers'
import { NUCLEOTIDE_LETTER_THRESHOLD } from '../../utils/nucleotideStyle'
import { schemeById } from './colourSchemes'
import { cohortOf } from './conservationPlan'
import { litRows, DEFAULT_COLLAPSE_MIN, DEFAULT_GAP_PERCENT, gapPercent } from './layers'
import { createDetail, detailLayer, detailRestricted, restrictRows, comparatorFor, activePair, setReference, setMode, moveRow as moveDetailRow, pickTranscript, COMPARISON_MODES } from './detail'
import './explorer.css'

export default function AlignmentExplorerView({theme='dark',config,genomes=[],topBarGenomes=genomes,onAddGenome,onOpenGenome,incoming,onIncomingConsumed}) {
  const [motifs,setMotifs]=useState(loadMotifs),[motifsSaved,setMotifsSaved]=useState(true)
  const [dataset,setDataset]=useState(null),[inventory,setInventory]=useState([]),[blocks,setBlocks]=useState({blocks:[],total:0}),[source,setSource]=useState(null)
  const [state,setState]=useState(emptyWorkspace),[size,setSize]=useState({width:900,height:500}),[job,setJob]=useState(null),[opening,setOpening]=useState(''),[cancelling,setCancelling]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
  const [dialog,setDialog]=useState(null),[path,setPath]=useState(''),[merge,setMerge]=useState(null),[layerName,setLayerName]=useState(''),[inspect,setInspect]=useState(null),[fallback,setFallback]=useState(false),[revision,setRevision]=useState(0)
  const [selectionDrag,setSelectionDrag]=useState(null),[filterOpen,setFilterOpen]=useState(false),[colorTarget,setColorTarget]=useState(null)
  // Block context is a lens, never a layer and never part of the workspace. It
  // is held outside `state` so that nothing about it can be committed, undone or
  // saved: a lens onto a block is not a statement about the alignment, and a
  // saved one could name a block, a row or a transcript that has since gone.
  const [blockContext,setBlockContext]=useState(null),[contextBusy,setContextBusy]=useState(false)
  const [contextRows,setContextRows]=useState(false)
  // Hiding replaces Original's layout rather than filtering it: the blocks that
  // survive are fetched by number and laid out shoulder to shoulder, so the
  // file's own coordinates no longer describe the sheet and the loader that
  // reads them is stood down for the duration.
  const [hiddenLayout,setHiddenLayout]=useState(null),[hideMenu,setHideMenu]=useState(false),[hideDraft,setHideDraft]=useState(null),[menuAnchor,setMenuAnchor]=useState(null)
  // Layers folds like the other sections, but its title lives on the sidebar's
  // header row rather than inside the section, so a <details> cannot hold the
  // state. A selection drag opens it whatever the user left it at, or there
  // would be nothing to drop onto.
  const [layersExpanded,setLayersExpanded]=useState(true)
  const layersOpen=layersExpanded||!!selectionDrag
  const explorerRoot=useRef(null), hideMenuId=useId(), toolbar=useRef(null)
  const barEdges=useScrollEdges(toolbar)
  // Which of the two ways of selecting the bar's one button offers. A completed
  // selection puts the mode back to Pan, so the choice has to outlive the mode.
  const [cursorShape,setCursorShape]=useState('rectangle')
  const [rowQuery,setRowQuery]=useState(''),[selectRows,setSelectRows]=useState([]),[range,setRange]=useState({fragment:'',start:1,end:100}),[link,setLink]=useState({row:'',assembly:'',region:'',strand:'+'})
  const [localGenomes,setLocalGenomes]=useState([]),[localGenomesLoading,setLocalGenomesLoading]=useState(false),[linkReport,setLinkReport]=useState(null),[linkImporting,setLinkImporting]=useState(false),[addingAssembly,setAddingAssembly]=useState('')
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

  useEffect(()=>{
    const controller=new AbortController();let cancelled=false
    const candidates=[]
    const push=(item,manual=false)=>{
      const genome=normalizeGenomeRecord(manual?{...item,is_manual:true}:item),assembly=getAssemblyAccession(genome)
      if(!assembly||candidates.some(value=>getAssemblyAccession(value).toUpperCase()===assembly.toUpperCase()))return
      candidates.push(genome)
    }
    for(const item of topBarGenomes||[])push(item)
    for(const item of genomes||[])push(item)
    for(const item of config?.manual_species||[])push(item,true)
    const loadLocal=async()=>{
      const outputDir=String(config?.output_dir||'').trim()
      if(outputDir){
        setLocalGenomesLoading(true)
        try{
          const response=await fetch(`${API_BASE}/api/remote/local-assemblies?output_dir=${encodeURIComponent(outputDir)}`,{signal:controller.signal})
          if(response.ok){
            for(const item of await response.json()){
              push(item)
              for(const instance of Array.isArray(item?.dataset_instances)?item.dataset_instances:[])push(instance)
            }
          }
        }catch(error){if(error?.name!=='AbortError')setNotice('Local genome availability could not be refreshed.')}
      }
      if(!cancelled){setLocalGenomes(candidates);setLocalGenomesLoading(false)}
    }
    loadLocal()
    return()=>{cancelled=true;controller.abort()}
  },[config?.manual_species,config?.output_dir,genomes,topBarGenomes])
  
  const orderedInventory=useMemo(()=>{
    const order=resolveRowOrder(inventory.map(r=>r.id),state.rowOrder)
    const byId=new Map(inventory.map(r=>[r.id,r]))
    return order.map(id=>byId.get(id)).filter(Boolean)
  },[inventory,state.rowOrder])
  // The layer row order, declared beside the order it is taken from: the layer
  // being drawn needs it to compact a hide, long before the toolbar does.
  const ids=useMemo(()=>orderedInventory.map(r=>r.id),[orderedInventory])
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
  // Original's hide. It alone drives the layout fetch and the repack below: a
  // layer's hide never reaches the server and never rearranges Original.
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
  const sourceFragments=useOriginalBlocks(dataset,source,state.camera,sourceView,blocks.total,state.original&&!blockContext&&!hiddenBlocks?.length&&!motifBlockIds,setError,revision,!!state.planeZoom)
  const laidOut=packedFragments||sourceFragments
  const originalFragments=useMemo(()=>layoutOriginal(laidOut,orderedInventory.map(r=>r.id),state.originalRows||'aligned',state.blockRows||{},dataset?.max_source_rows,viewFilter),[laidOut,orderedInventory,state.originalRows,state.blockRows,dataset?.max_source_rows,viewFilter])
  const original=useMemo(()=>({id:'original',name:'Original alignment',color:'#b9c5d9',fragments:originalFragments,packed:!!packedFragments,rowExtent:Math.max(inventory.length,2*(dataset?.max_source_rows||0)+3),extent:packedFragments?packedExtent(packedFragments):dataset?.layout_end||source?.layout_end||source?.length||1}),[originalFragments,packedFragments,dataset?.layout_end,source?.layout_end,source?.length,inventory.length,dataset?.max_source_rows])
  const allLayers=useMemo(()=>[original,...state.layers],[original,state.layers])
  const active=state.original?original:state.layers.find(l=>l.id===state.active)||original
  // What is actually drawn: the active layer, narrowed by its own hide and then
  // by the motif filter. Both are read here rather than written into the layer,
  // so Show everything is a matter of dropping the note, not rebuilding it.
  const contextLayer=useMemo(()=>blockContext?detailLayer(blockContext):null,[blockContext])
  const shownLayer=useMemo(()=>{
    if(contextLayer)return contextLayer
    if(state.original)return active
    let fragments=active.fragments
    if(active.hidden)fragments=hideLayerFragments(fragments,active.hidden,ids)
    if(motifBlockIds)fragments=fragments.filter(f=>motifBlockIds.has(f.sourceBlock))
    return fragments===active.fragments?active:{...active,fragments}
  },[active,motifBlockIds,state.original,ids,contextLayer])
  // Last of the narrowings, and the only one that is about columns rather than
  // about blocks and sequences. It goes after the others on purpose: what is
  // uninformative is decided by the rows that survived them, so hiding a
  // sequence can empty a column and showing it again fills it, with no state in
  // between to keep consistent.
  const collapse=useGapCollapse(dataset,shownLayer,!!state.collapseGaps&&!contextLayer,state.collapseMin||DEFAULT_COLLAPSE_MIN,gapPercent(state.collapsePercent),setError,!!state.original)
  const layer=collapse.layer
  // Packing moves the blocks; this moves the camera with them.
  //
  // Closing the channels shifts every block after a collapsed one to the left,
  // and a reader halfway down the file would otherwise find the sheet had slid
  // out from under them - on switching the option, and again each time an
  // answer arrives for a block behind them or a block behind them is unloaded.
  // The block nearest the camera is watched: while it is the same block, any
  // change in how far it has moved is applied to the camera as well, so what is
  // under the viewport stays under it. A different block means the reader
  // panned there themselves, which is a camera move of their own to leave alone.
  const packAnchor=useRef(null)
  const packSolid=layer.fragments?.filter(f=>!f.aggregate)||[]
  const packNearest=packSolid.length?sourceViewAnchor(packSolid,stateRef.current.camera):null
  const packBlock=packNearest?.sourceBlock??null,packShift=packNearest?.packShift||0
  useEffect(()=>{
    const previous=packAnchor.current
    packAnchor.current={block:packBlock,shift:packShift}
    if(!previous||previous.block!==packBlock||previous.shift===packShift)return
    const delta=packShift-previous.shift
    const current=stateRef.current.camera
    patch({camera:{...current,x:current.x-delta}})
  },[packBlock,packShift,patch])
  // One answer to "which layer is on screen", read by the camera as well as the
  // painter. Deriving it twice is what let a pan be clamped against one layer
  // and drawn against another.
  const layerRef=useRef(layer);layerRef.current=layer
  const previousMotifBlocks=useRef(null)
  useEffect(()=>{
    if(motifBlocks.blocks&&previousMotifBlocks.current!==motifBlocks.blocks&&state.original){
      patch({camera:fitCamera(original,size.width,size.height)})
    }
    previousMotifBlocks.current=motifBlocks.blocks
  },[motifBlocks.blocks,original,size.width,size.height,state.original,patch])
  const cameraFrame=useRef(null),pendingCamera=useRef(null)
  const camera=useCallback(value=>{
    const current=stateRef.current,drawn=layerRef.current||original,bounded=constrainCamera(drawn,value,size)
    pendingCamera.current={camera:bounded,active:current.active,original:current.original,layerId:drawn.id}
    if(cameraFrame.current==null)cameraFrame.current=requestAnimationFrame(()=>{
      cameraFrame.current=null;const next=pendingCamera.current
      if((layerRef.current?.id||null)!==next.layerId)return
      // A lens keeps its camera in the same place every other view does, so pan
      // and zoom need no special case; what it must not do is write that camera
      // back into the layer it was opened from, which is where the reader is
      // returned to on closing.
      setState(s=>s.active!==next.active||s.original!==next.original?s:{...s,camera:next.camera,
        layers:next.layerId==='detail'?s.layers:s.layers.map(l=>l.id===s.active&&!s.original?{...l,camera:next.camera}:l)})
    })
    return bounded
  },[original,size])
  useEffect(()=>()=>{if(cameraFrame.current!=null)cancelAnimationFrame(cameraFrame.current)},[])
  const renderState=useMemo(()=>({...state,original:layer.id==='original',blockContext,camera:constrainCamera(layer,state.camera,size),
    placedOverlay:state.original&&state.overlay&&!blockContext?state.layers.flatMap(l=>l.fragments.map(f=>({...f,color:l.color,name:l.name}))):[]}),[state,layer,size,blockContext])
  const renderView=useMemo(()=>planeViewport(size,renderState.camera),[size,renderState.camera])
  // Named once, over the whole file, and filtered afterwards. Doing it the other
  // way round left every row a filter excludes with no entry anywhere, and the
  // sheet falls back to a bare identifier when it cannot find one - so filtering
  // Original renamed the rows of every layer holding a sequence the filter does
  // not keep, which a layer is perfectly entitled to hold.
  const namedInventory=useMemo(()=>orderedInventory.map(row=>{
    const linked=classifyGenomeLink(row,topBarGenomes,localGenomes)
    if(!linked.assembly)return row
    const name=genomeDisplayName(linked.genome,'')
    const label=row.label||row.source
    return {...row,label:name&&!String(label).toLowerCase().includes(String(name).toLowerCase())?`${name} · ${label}`:label,linkStatus:linked.status,linkedGenome:linked.genome}
  }),[orderedInventory,localGenomes,topBarGenomes])
  // Which rows Original lists, and in what order: that is the filter's business.
  const displayInventory=useMemo(()=>{
    const allowed=viewFilter?.sequences?.length?new Set(viewFilter.sequences):null
    return allowed?namedInventory.filter(row=>allowed.has(row.id)):namedInventory
  },[namedInventory,viewFilter])
  // Who every row is, whether it is listed or not. The painter draws names for
  // rows a layer holds, and a layer is not narrowed by Original's filter.
  const rowsById=useMemo(()=>new Map(namedInventory.map(row=>[row.id,row])),[namedInventory])
  // Names for the controls that talk about rows. The inventory a filter has
  // narrowed is not the whole file, and block context can hold a row the filter
  // is hiding, so this falls back to the unfiltered inventory rather than
  // printing a bare identifier.
  const rowLabel=useCallback(id=>{const row=rowsById.get(id);return row?.label||row?.source||id},[rowsById])
  const genomeOptions=useMemo(()=>{
    const values=[]
    for(const genome of [...(topBarGenomes||[]),...localGenomes]){
      const assembly=getAssemblyAccession(genome)
      if(assembly&&!values.some(item=>getAssemblyAccession(item).toUpperCase()===assembly.toUpperCase()))values.push(genome)
    }
    return values.sort((a,b)=>genomeDisplayName(a,getAssemblyAccession(a)).localeCompare(genomeDisplayName(b,getAssemblyAccession(b))))
  },[localGenomes,topBarGenomes])
  const reportGroups=useMemo(()=>{
    const ids=linkReport?.sequence_ids?new Set(linkReport.sequence_ids):null
    const rows=inventory.filter(row=>ids?ids.has(row.id):row.metadata?.assembly)
    const grouped=new Map()
    for(const row of rows){
      const linked=classifyGenomeLink(row,topBarGenomes,localGenomes)
      const key=`${linked.status}:${linked.assembly||row.source}`
      if(!grouped.has(key))grouped.set(key,{...linked,count:0,sources:[],regions:new Set()})
      const group=grouped.get(key);group.count++;group.sources.push(row.label||row.source)
      if(linked.region)group.regions.add(linked.region)
    }
    const order={topbar:0,local:1,unavailable:2,unresolved:3}
    return [...grouped.values()].map(group=>({...group,regionLabel:[...group.regions].slice(0,3).join(', ')+(group.regions.size>3?` +${group.regions.size-3} more`: '')})).sort((a,b)=>(order[a.status]-order[b.status])||String(a.assembly).localeCompare(String(b.assembly)))
  },[inventory,linkReport,localGenomes,topBarGenomes])
  // The rows laid out, narrowing to whatever is picked. Deliberately the
  // laid-out set rather than the rows that happen to be on screen, so scrolling
  // never restates the question and the colours hold still while reading.
  const scheme=schemeById(state.colourScheme)
  const cohort=useMemo(()=>scheme.cohort?cohortOf(layer,displayInventory,litRows(state)):null,[scheme,layer,displayInventory,state])
  // What each row's binned summaries are relative to. Outside the lens this is
  // null, which leaves every request asking for the block's first row exactly as
  // it always has.
  const focusOf=useMemo(()=>blockContext?(rowId=>comparatorFor(blockContext,rowId)||blockContext.reference||rowId):null,[blockContext])
  // The lens owns its annotation data and its overlay. Entering it must not turn
  // the saved Annotations setting on, which would leak into the workspace and
  // start the parked ribbon requesting on every other sheet as well.
  const {tiles,annotations,connections,offWindow,counts,pending,warnings,conservation,gaps,displayCamera}=useLayerData(dataset,layer,renderState.camera,renderView,state.annotations&&!blockContext,revision,setError,false,cohort,focusOf)
  const motifSearch=useMotifs(snapshot,layer,displayCamera,renderView,scheme.id==='motif')
  // Block context owns its annotation data, on its own request budget. Nothing
  // here touches the parked Annotations setting or the ribbon it drives.
  const contextData=useBlockContext(dataset,blockContext,contextLayer,renderState.camera,renderView,revision,setError)
  const laneCountsKey=JSON.stringify(annotationLaneCounts(contextData.features))
  useEffect(()=>{
    const counts=JSON.parse(laneCountsKey)
    setBlockContext(d=>!d||!Object.keys(counts).some(id=>d.trackLanes?.[id]!==counts[id])?d:
      {...d,trackLanes:{...d.trackLanes,...counts}})
  },[laneCountsKey])
  const browserRangesByFragment=useMemo(()=>{
    const eligible=new Set(displayInventory.filter(row=>row.linkStatus==='topbar'&&row.linkedGenome?.files?.gff3).map(row=>row.id)),ranges=new Map()
    if(!onOpenGenome||!eligible.size)return ranges
    for(const fragment of layer.fragments){
      const selected=selectedRangesForFragment(state.selection,fragment,eligible,state.highlighted)
      if(selected.length)ranges.set(fragment.id,selected)
    }
    return ranges
  },[displayInventory,layer.fragments,onOpenGenome,state.highlighted,state.selection])
  const canvasState=useMemo(()=>({...renderState,camera:displayCamera,annotations:state.annotations&&!blockContext,motifRows:motifSearch.rows,browserFragments:new Set(browserRangesByFragment.keys())}),[renderState,displayCamera,motifSearch.rows,browserRangesByFragment,state.annotations,blockContext])
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
  const switchLayer=useCallback(id=>{setInspect(null);setBlockContext(null);setState(s=>({...s,original:id==='original',active:id==='original'?s.active:id,selection:[],camera:id==='original'?fitCamera({fragments:original.fragments.filter(f=>f.sourceBlock===s.sourceBlock&&!f.aggregate).slice(0,1)},size.width,size.height):s.layers.find(l=>l.id===id)?.camera||s.camera}))},[original,size])
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
      history.current={past:[],future:[]};setDataset(data);setInventory(rows);setBlocks(blockList);setSource(first);setState(next);setDialog(null);setInspect(null);setLinkReport(null);setLink({row:'',assembly:'',region:'',strand:'+'});setNotice('');setRevision(v=>v+1)
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
  // Picks are resolved against the sheet they were made on. Reading a layer's
  // picks against Original's fragments found no fragment for them at all, so a
  // pick in a layer never contributed the block it was in.
  const hideChoice=useMemo(()=>hiddenSelection(state.selection,state.highlighted,state.original?originalFragments:active.fragments),[state.selection,state.highlighted,state.original,originalFragments,active.fragments])
  // The hide in force on what is being looked at. Original keeps its own; each
  // layer keeps its own, because hiding is a way of reading one sheet rather
  // than a narrowing of the alignment - that is what the filter is for.
  const viewHidden=state.original?state.hidden:active.hidden
  const viewTotals=useMemo(()=>state.original
    ?{blocks:blocks.total||0,rows:inventory.length}
    :{blocks:new Set(active.fragments.map(f=>f.sourceBlock)).size,rows:new Set(active.fragments.flatMap(f=>f.rowIds)).size},
    [state.original,blocks.total,inventory.length,active.fragments])
  // The rule in force: what produced the sheet on screen, or what the next Hide
  // will use. A rule that keeps nothing never becomes the rule in force, so the
  // control snaps back to the one the reader is actually looking at.
  const hideWhat=hideMenu?(hideDraft?.what||state.hideWhat||'blocks'):(state.hideWhat||'blocks'),hideMode=hideMenu?(hideDraft?.mode||state.hideMode||'or'):(state.hideMode||'or')
  // Where the survivors sit once the rest are gone. Original has the sidebar's
  // own row mode for this; a layer keeps it with the hide that caused it.
  const hideRows=hideMenu?(hideDraft?.rows||state.hideRows||'compact'):(state.hideRows||'compact')
  const hiding=!!(viewHidden?.blocks?.length||viewHidden?.rows?.length)
  const hidingSummary=useMemo(()=>{
    const parts=[]
    if(viewHidden?.blocks?.length)parts.push(`${viewHidden.blocks.length.toLocaleString()} of ${viewTotals.blocks.toLocaleString()} blocks`)
    if(viewHidden?.rows?.length)parts.push(`${viewHidden.rows.length.toLocaleString()} of ${viewTotals.rows.toLocaleString()} sequences`)
    return parts.join(' · ')
  },[viewHidden,viewTotals])
  // What the view is holding back, said once, beside the totals it is measured
  // against. Both counts used to sit in the control bar next to the switch that
  // set them, which is the obvious place for them until a wide one pushes Cycle
  // off the end and the bar has to be scrolled to reach its own buttons. The
  // switches keep them in their tooltips; the sidebar card gives them a line
  // that is always in view and never competes for width.
  // "Gap-only" only while the threshold is the whole cohort. Below that the
  // hidden columns hold bases, and a line still calling them empty would be the
  // view telling the reader the opposite of what it had just done for them.
  const gapShareApplied=gapPercent(state.collapsePercent)
  const narrowedSummary=[hiding?`Showing ${hidingSummary}`:hiddenSummary,
    collapse.columns?(gapShareApplied<100
      ?`${collapse.columns.toLocaleString()} columns hidden, ${gapShareApplied}% or more gapped`
      :`${collapse.columns.toLocaleString()} gap-only columns hidden`):''].filter(Boolean).join(' · ')
  const closeHideMenu=useCallback(()=>setHideMenu(false),[])
  useMenuDismiss(hideMenu,closeHideMenu,hideButton,'al-tool-menu')
  const hideMenuChoice=hideDraft?.previous?state.hideMemory?.choice:canHide(hideChoice)?hideChoice:viewHidden?.choice
  // The switch says what is hidden and only that. Collapsing lives in the same
  // menu because that is where a reader goes to narrow a sheet, but it is not a
  // hide - it hides nothing, it closes up columns nobody has anything in - and
  // naming it on the face of the control made one word there into two that did
  // not fit, leaving the reader reading "Sequences + ...". What is collapsed is
  // counted on the Original alignment card, beside the other counts, and stated
  // in the menu that sets it.
  const collapsing=!!state.collapseGaps
  // How many sequences the threshold is a share of. Counted from the sheet
  // rather than from the file: the question the gap answer asks is about the
  // rows being drawn, and a percentage of some larger number the reader cannot
  // see would be a percentage of nothing they could check. Blocks holding fewer
  // than this need fewer, which the menu says rather than pretending otherwise.
  const gapCohort=useMemo(()=>new Set((shownLayer?.fragments||[]).filter(f=>!f.aggregate).flatMap(f=>f.rowIds)).size,[shownLayer])
  // Closing gaps is its own switch, its own settings and its own Apply. Undo
  // reaches both, so a reader who closes gaps and dislikes the result has the
  // same way back as from any other edit.
  const toggleGaps=useCallback(value=>commit(s=>({...s,collapseGaps:value})),[commit])
  // Apply publishes the whole answer the menu asked for - shown or hidden, and
  // how - in one commit, so Undo returns the sheet to how it was read rather
  // than to a half state nobody chose.
  const applyGapSettings=useCallback(({closed,marks,min,percent})=>commit(s=>({...s,collapseGaps:closed,collapseMarks:marks,collapseMin:min,collapsePercent:percent})),[commit])
  // Stopping the work and leaving the switch on would be no answer at all: the
  // next render asks the same questions again. So Stop is "do not close gaps",
  // which is both halves - drop the work, and take the switch back off.
  const cancelCollapse=useCallback(()=>{collapse.cancel();patch({collapseGaps:false})},[collapse,patch])
  const hideValue=hiding?({blocks:'Blocks',sequences:'Sequences',both:'Both'}[viewHidden?.what||state.hideWhat]||'On'):'Off'
  const openHideMenu=()=>{
    if(hideMenu){closeHideMenu();return}
    setHideDraft({what:viewHidden?.what||state.hideWhat||'blocks',mode:viewHidden?.mode||state.hideMode||'or',rows:viewHidden?.rowLayout||state.hideRows||'compact',previous:false})
    setMenuAnchor(menuPosition(hideButton.current,320));setHideMenu(true)
  }
  const hideRefusal=(kept,what,mode)=>kept.length?null:(mode==='and'&&what!=='sequences'
    ?'No block satisfies the conditions.'
    :'Nothing picked out is in a block to keep.')
  /** Hiding inside a layer, which the layer answers on its own.
   *
   * It needs no server and no repack: the layer's chunks already say which of
   * its blocks carry which sequences, and its arrangement is the reader's, not
   * the file's. The result is a note on the layer, so every layer narrows
   * separately and Original is left alone - hiding is a way of reading one
   * sheet, where the filter is a narrowing of the alignment behind all of them.
   */
  function hideInLayer(choice,{what,mode,rows:rowLayout},settings={}){
    const {blocks:kept,rows}=hideResult(choice,layerMembership(active.fragments,choice.rows),{what,mode})
    const refusal=hideRefusal(kept,what,mode)
    if(refusal){setNotice(refusal);return}
    const hidden={blocks:kept,rows,camera:active.hidden?.camera??state.camera,what,mode,rowLayout,choice}
    const survivors=hideLayerFragments(active.fragments,hidden,ids)
    setHideMenu(false)
    commit(s=>({...s,...settings,hideWhat:what,hideMode:mode,hideRows:rowLayout,hideMemory:{choice,what,mode,rowLayout},
      layers:s.layers.map(l=>l.id===s.active?{...l,hidden}:l),
      camera:survivors.length?fitCamera({fragments:survivors},size.width,size.height):s.camera}))
  }
  async function applyHide(choice,{what,mode,rows:rowLayout},settings={}){
    if(!canHide(choice))return
    if(what!=='blocks'&&!choice.rows.length){setNotice('No sequences are picked to keep.');return}
    if(choice.rows.length>5000){setNotice('Too many sequences are picked to ask about at once.');return}
    if(!state.original){hideInLayer(choice,{what,mode,rows:rowLayout},settings);return}
    setBusy(true)
    try{
      // A picked sequence runs the length of the file, and most of the blocks it
      // visits are not loaded, so the server is asked which hold it.
      const membership=choice.rows.length
        ?(await api(`/datasets/${dataset.id}/blocks-with`,{ids:choice.rows})).blocks||[]
        :[]
      const {blocks:kept,rows}=hideResult(choice,membership,{what,mode})
      const refusal=hideRefusal(kept,what,mode)
      if(refusal){setNotice(refusal);return}
      hideFit.current=kept.join(',')
      setHideMenu(false)
      // What was hidden, and what asked for it: the settings outlive the hide so
      // the same narrowing can be put back without building the picks again.
      commit(s=>({...s,...settings,hideWhat:what,hideMode:mode,hideRows:rowLayout,
        hidden:{blocks:kept,rows,camera:s.hidden?.camera??s.camera,what,mode,rowLayout,choice},
        hideMemory:{choice,what,mode,rowLayout}}))
    }catch(error){setError(error.message)}finally{setBusy(false)}
  }
  // Show everything puts back whichever sheet is being read, and only that one.
  function showEverything(){commit(s=>s.original
    ?{...s,hidden:null,camera:s.hidden?.camera||s.camera}
    :{...s,layers:s.layers.map(l=>l.id===s.active?{...l,hidden:null}:l),
      camera:s.layers.find(l=>l.id===s.active)?.hidden?.camera||s.camera})}
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
      const lines=rowId?blockRowLines(result.rows.map(r=>r.id),displayInventory.map(r=>r.id),{compact,wholeView:mode==='compact'}):null
      const line=lines?.get(rowId)
      if(line!=null)view.y=centreOnRow(line,Math.max(...lines.values()),size.height)
      patch({sourceBlock:Number(id),original:true,camera:view,...(rowId?{highlighted:addHighlight(state.highlighted,rowId)}:{})})
    }catch(e){if(token===blockNav.current)setError(e.message)}
  }
  function layerFromFilter(chunks){
    if(!chunks.length)return
    const next=createLayer(nextLayerName(state.layers,'Filtered'),state.layers.length,
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
  /** Put the picked cells in a layer.
   *
   * Always a copy, wherever they came from. A layer is a way of looking at the
   * alignment, not a box the cells are kept in, so taking a set of sequences
   * into a layer of their own left the layer they came from holding the blank
   * lane they used to fill and made every drop a decision about losing the
   * arrangement behind it. Original was already copied for the same reason.
   * Removing is its own act: the × on a chunk header or a sequence name.
   */
  async function transfer(destinationId='new'){
    const selected=state.selection
    let transferOriginal=original,selection=selected
    // The Original is a sliding window of descriptors. A row pick is semantic:
    // it names the sequence's complete path, so resolve every source block that
    // carries it before cutting chunks. Rectangles and block picks remain the
    // precise regions that were drawn or clicked.
    if(state.original){
      const rowIds=[...pickedRowIds(selected)]
      if(rowIds.length){
        setBusy(true);setError('')
        try{
          const result=await api(`/datasets/${dataset.id}/row-fragments`,{ids:rowIds})
          const complete=(result.fragments||[]).map(f=>createFragment(f.block,0,f.end_x-f.x,f.row_ids,{id:`original:${f.block}`,x:f.x}))
          const byId=new Map(complete.map(f=>[f.id,f]))
          // Retain the rows needed by simultaneous region/block picks without
          // replacing the server's real-presence membership. Loaded Original
          // descriptors also contain MAF empty components, which are useful as
          // blank layout bands but must never turn into layer cells.
          const localRows=new Map()
          for(const pick of selected)if(pick.kind!=='row'){
            if(!localRows.has(pick.fragmentId))localRows.set(pick.fragmentId,new Set())
            for(const id of pick.rowIds)localRows.get(pick.fragmentId).add(id)
          }
          for(const f of original.fragments){
            const local=localRows.get(f.id)
            if(f.aggregate||!local?.size)continue
            const resolved=byId.get(f.id)
            byId.set(f.id,resolved?{...resolved,rowIds:[...new Set([...resolved.rowIds,...local])]}:f)
          }
          const fragments=[...byId.values()]
          transferOriginal={...original,fragments}
          selection=expandRowPicks(selected,fragments)
        }catch(error){setError(error.message);return}
        finally{setBusy(false)}
      }
    }
    const present=new Set((state.original?transferOriginal:active).fragments.map(f=>f.id))
    const resolved=resolvePicks(selection)
    const waiting=resolved.filter(pick=>!present.has(pick.fragmentId))
    if(waiting.length)setNotice(`${waiting.length} picked ${waiting.length===1?'block is':'blocks are'} not loaded, so ${waiting.length===1?'it was':'they were'} left behind. Navigate to them and drop them again.`)
    // Nothing to move means nothing to commit: going ahead would leave the
    // workspace pointing at a layer that was never made.
    if(waiting.length===resolved.length)return
    commit(s=>{
      // Do not apply a delayed path lookup to a selection changed while it was
      // in flight. The next drop will resolve that newer selection itself.
      if(s.selection!==selected)return s
      // Original is immutable. Extracting from it creates working cells without
      // removing any source data or storing a duplicate of the full alignment.
      const prepared={...s,selection}
      // Named against the layers as they stand at the drop, not as they stood
      // when this view last rendered: a drop can follow an undo or another
      // drop, and a name read from a stale list lands on a number the sidebar
      // is already using.
      const newLayer=destinationId==='new'?createLayer(nextLayerName(s.layers),s.layers.length):null
      const input=s.original?{...prepared,layers:[...s.layers,transferOriginal],active:'original'}:prepared
      const next=moveSelection(input,newLayer?.id||destinationId,{copy:true,targetLayer:newLayer,viewportWidth:size.width})
      const layers=next.layers.filter(l=>l.id!=='original'),destination=layers.find(l=>l.id===next.active)
      const view=fitCamera(destination,size.width,size.height)
      return {...next,layers:layers.map(l=>l.id===next.active?{...l,camera:view}:l),camera:view}
    });setInspect(null)
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
    if(id)transfer(id)
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
  async function applyMetadata(content,suffix,label='Genome links'){
    setLinkImporting(true);setError('')
    try{
      const report=await api(`/datasets/${dataset.id}/metadata`,{content,suffix}),rows=[]
      for(let offset=0;;offset+=5000){const page=await api(`/datasets/${dataset.id}/sequences?offset=${offset}&limit=5000`);rows.push(...page.rows);if(rows.length>=page.total)break}
      setInventory(rows);setLinkReport({...report,label});setRevision(v=>v+1)
      setNotice(`${report.updated.toLocaleString()} alignment ${report.updated===1?'sequence':'sequences'} linked; no alignment rows were removed.`)
      return report
    }finally{setLinkImporting(false)}
  }
  async function addLinkedGenome(genome){
    if(!onAddGenome||!genome)return
    const assembly=getAssemblyAccession(genome);setAddingAssembly(assembly)
    try{
      const result=await onAddGenome(genome,'alignment_explorer',{desired:'selected'})
      if(result?.ok===false)throw new Error(result.message||'This genome could not be added to the top bar.')
    }catch(error){setError(error.message)}finally{setAddingAssembly('')}
  }
  async function openSelectionInGenomeBrowser(fragment){
    const ranges=browserRangesByFragment.get(fragment?.id)
    if(!dataset||!fragment||!ranges?.length||!onOpenGenome)return
    setBusy(true);setError('')
    try{
      const result=await api(`/datasets/${dataset.id}/genomic-loci`,{block:fragment.sourceBlock,ranges})
      const loci=(result.loci||[]).map(locus=>{
        const genome=topBarGenomes.find(item=>getAssemblyAccession(item).toUpperCase()===String(locus.assembly||'').toUpperCase())
        return genome?{...locus,genomeKey:getGenomeKey(genome)}:null
      }).filter(Boolean)
      if(!loci.length){setNotice('The selected alignment cells do not contain placed bases for a browsable top-bar genome.');return}
      if(result.warnings?.length)setNotice(result.warnings[0].message)
      await onOpenGenome({loci})
    }catch(error){setError(error.message)}finally{setBusy(false)}
  }
  /** Open one source block on its own.
   *
   * Always the complete source block, even when the press came from a chunk:
   * a chunk is a piece someone cut out, and reading a gene against the
   * alignment means reading it against the alignment the block actually has.
   * Where the chunk covers less than the block, its interval is what the view
   * opens framed on, and the bar says the whole block is in hand.
   */
  async function openBlockContext(fragment){
    if(!dataset||!fragment||fragment.aggregate||contextBusy)return
    setContextBusy(true);setError('')
    try{
      const result=await api(`/datasets/${dataset.id}/blocks/${fragment.sourceBlock}/rows`)
      const present=result.rows.map(r=>r.id)
      const ordered=resolveRowOrder(present,state.rowOrder).filter(id=>present.includes(id))
      const rows=restrictRows(ordered,state.selection,state.highlighted)
      const next=createDetail({
        fragmentId:fragment.id,sourceBlock:fragment.sourceBlock,length:result.length,
        rowIds:rows,allRowIds:ordered,available:result.rows.filter(r=>!r.empty_status).map(r=>r.id),
        frame:fragment.start>0||fragment.end<result.length?{start:fragment.start,end:fragment.end}:null,
        origin:{camera:state.camera,original:state.original,active:state.active,
          selection:state.selection,highlighted:state.highlighted,rowOrder:state.rowOrder},
      })
      setBlockContext(next);setInspect(null)
      patch({camera:contextCamera(next),selection:[]})
    }catch(error){setError(error.message)}finally{setContextBusy(false)}
  }
  function contextCamera(detail){
    const drawn=detailLayer(detail)
    const view=fitCamera(drawn,size.width,size.height)
    if(!detail.frame)return view
    const span=Math.max(1,detail.frame.end-detail.frame.start)
    return constrainCamera(drawn,{...view,x:detail.frame.start,scale:Math.max(view.scale,(size.width-MARGIN_X-24)/span)},size)
  }
  /** Open the rows the genomic panel is showing, at their own coordinates.
   *
   * The same handoff the block header's Genome Browser button makes, from a
   * different starting point: there it is the columns that were picked, here it
   * is the window each track is already framed on. */
  async function openGenomicRowsInBrowser(rows,windows){
    if(!onOpenGenome)return
    const loci=[]
    for(const rowId of rows||[]){
      const row=contextData.rowsById?.get(rowId)
      if(!row?.assembly||!row?.region||!row.genomic)continue
      const genome=topBarGenomes.find(item=>getAssemblyAccession(item).toUpperCase()===String(row.assembly).toUpperCase())
      if(!genome)continue
      loci.push({assembly:row.assembly,region:row.region,chrom:row.region,strand:row.strand,
        start:Math.max(0,windows?.[rowId]?.start??row.genomic.start)+1,end:windows?.[rowId]?.end??row.genomic.end,genomeKey:getGenomeKey(genome)})
    }
    if(!loci.length){setNotice('None of these rows is linked to a genome in the top bar.');return}
    try{await onOpenGenome({loci})}catch(error){setError(error.message)}
  }
  /** Put back the sheet, the camera and the picks the reader came in with. The
   * lens never wrote to any of them, so this is a restore rather than an undo. */
  function closeBlockContext(){
    const origin=blockContext?.origin
    setBlockContext(null);setInspect(null)
    if(origin)patch({camera:origin.camera,original:origin.original,active:origin.active,
      selection:origin.selection,highlighted:origin.highlighted,rowOrder:origin.rowOrder})
  }
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
  // Block navigation is not Original's alone. A layer holds a subset of the
  // file's blocks, in an order its own arrangement decides, so it walks the
  // blocks it actually has rather than counting through block numbers that are
  // not on this sheet.
  const layerNavFragments=useMemo(()=>state.original?[]:layer.fragments.filter(f=>!f.aggregate&&f.sourceBlock!=null),[state.original,layer.fragments])
  const layerBlocks=useMemo(()=>[...new Set(layerNavFragments.map(f=>f.sourceBlock))].sort((a,b)=>a-b),[layerNavFragments])
  const layerBlock=useMemo(()=>layerViewAnchor(layerNavFragments,renderState.camera,renderView)?.sourceBlock??null,[layerNavFragments,renderState.camera,renderView])
  // A block can be several chunks once pieces of it have been moved separately,
  // so the camera is fitted to all of them rather than to whichever comes first.
  function layerBlockTo(id){
    const wanted=layerNavFragments.filter(f=>f.sourceBlock===Number(id))
    if(!wanted.length){setNotice(`Block ${id} is not in ${layer.name}. Open it in Original, or move it into a layer first.`);return}
    patch({camera:fitCamera({fragments:wanted},size.width,size.height)})
  }
  const stepLayerBlock=delta=>{const at=layerBlocks.indexOf(layerBlock);return layerBlocks[(at<0?0:at)+delta]??null}
  // The two navigators differ in what they walk, not in how they are worked.
  const blockNavigator=state.original
    ? {label:sourceRange?.grouped?`Blocks ${sourceRange.first}\u2013${sourceRange.last}`:'Block',
       grouped:!!sourceRange?.grouped,value:visibleSourceBlock,min:1,max:blocks.total,ready:blocks.total>0,
       go:id=>{if(id>=1&&id<=blocks.total)sourceBlock(id)},step:stepBlock,onStep:sourceBlock,
       title:sourceRange?.grouped?'This overview groups source blocks. Enter a block number to open one.':'Jump to a source block, or step to the one either side.'}
    : {label:'Block',grouped:false,value:layerBlock,min:layerBlocks[0],max:layerBlocks.at(-1),ready:layerBlocks.length>0,
       go:layerBlockTo,step:stepLayerBlock,onStep:layerBlockTo,
       title:layerBlocks.length?`${layer.name} holds ${plural(layerBlocks.length,'block','blocks')}. Jump to one of them, or step between them.`:'This layer has no blocks yet. Move a selection into it first.'}
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
          <button className="al-new-layer" title="New empty layer" aria-label="New empty layer" onClick={()=>{setLayersExpanded(true);commit(s=>{const next=createLayer(nextLayerName(s.layers),s.layers.length);return {...s,layers:[...s.layers,next],active:next.id,original:false,selection:[],camera:next.camera}})}}>＋</button>
          <button className="al-sidebar-toggle" aria-label={state.sidebarCollapsed?'Expand alignment sidebar':'Collapse alignment sidebar'} aria-expanded={!state.sidebarCollapsed} onClick={()=>patch({sidebarCollapsed:!state.sidebarCollapsed})}><DrawerChevron pointsRight={!!state.sidebarCollapsed}/></button>
        </div>
        <div className="al-sidebar-content">
        {layersOpen&&<div className="al-section"><div className="al-layer-targets">
        <button className={`al-original ${state.original?'selected':''}`} onClick={()=>switchLayer('original')}><i/> <span>Original alignment<small>{blockSummary}</small>{!!narrowedSummary&&<small className="al-narrowed">{narrowedSummary}</small>}</span></button>
        {state.original&&<label className="al-check al-overlay-check"><input type="checkbox" checked={!!state.overlay} onChange={e=>patch({overlay:e.target.checked})}/>Highlight regions in other layers</label>}
        <div className="al-layer-list">{state.layers.map(l=><div key={l.id} data-layer-drop={l.id} data-selection-drop={l.id} className={`al-layer ${selectionDrag?.target===l.id?'selection-drop-hover':''} ${selectionDrag&&!state.original&&l.id===state.active?'selection-drop-disabled':''} ${!state.original&&l.id===state.active?'selected':''}`} draggable onDragStart={e=>{e.dataTransfer.setData('application/x-alignment-layer',l.id);e.dataTransfer.effectAllowed='move'}} onDragOver={e=>{if(e.dataTransfer.types.includes('application/x-alignment-layer')){e.preventDefault();e.currentTarget.classList.add('drop')}}} onDragLeave={e=>e.currentTarget.classList.remove('drop')} onDrop={e=>{e.preventDefault();e.currentTarget.classList.remove('drop');requestMerge(e.dataTransfer.getData('application/x-alignment-layer'),l.id)}}><button onClick={()=>switchLayer(l.id)}><i style={{background:l.color}}/><span>{l.name}<small>{l.fragments.length} {l.fragments.length===1?'chunk':'chunks'} · {new Set(l.fragments.flatMap(f=>f.rowIds)).size} sequences</small></span></button><button className="al-rename" aria-label={`Rename ${l.name}`} onClick={()=>{setLayerName(l.name);setDialog({rename:l.id})}}>✎</button><button className="al-rename" aria-label={`Remove layer ${l.name}`} title="Remove this layer (undo available; Original stays intact)" onClick={()=>commit(s=>({...s,layers:s.layers.filter(item=>item.id!==l.id),original:s.original||s.active===l.id,selection:[]}))}>×</button></div>)}</div>
        {!!selectionRows&&<button className={`al-new-layer-drop ${selectionDrag?.target==='new'?'selection-drop-hover':''}`} data-selection-drop="new" onClick={()=>transfer('new')}><b>＋</b><span>New layer<small>Drop the picked cells here</small></span></button>}
        </div>
</div>}
        <details className="al-section" open={filterOpen?true:undefined}><summary>Filter</summary>
          <p className="al-hint">Narrow the alignment to the sequences and blocks you want, then build a layer from them or show only those in Original.</p>
          <button className={filterOpen?'selected':''} aria-expanded={filterOpen} onClick={()=>setFilterOpen(v=>!v)}>{filterOpen?'Close filter':'Filter sequences & blocks'}</button>
          {state.filter&&<div className="al-filter-active" role="status"><strong>{filterOn?'Original is filtered':'Filter is off'}</strong>
            <small>{(state.filter.sequences||[]).length.toLocaleString()} sequences · {(state.filter.blocks||[]).length.toLocaleString()} blocks</small>
            <button onClick={()=>patch({filterOff:filterOn})}>{filterOn?'Turn filter off':'Turn filter on'}</button>
            <button onClick={()=>patch({filter:null,filterOff:false})}>Clear filter</button></div>}
        </details>
        <details className="al-section"><summary>Load data</summary><strong className="al-dataset-name">{dataset.name}</strong><button onClick={()=>setDialog('open')}>Open alignment</button><div className="al-source"><small>{blocks.total} source {blocks.total===1?'block':'blocks'} · {inventory.length} {inventory.length===1?'sequence':'sequences'}</small>
          {!!readerLabel&&<small className="al-reader">Read as <strong>{readerLabel}</strong>{dataset.format_chosen?' (you chose this format)':''}{lastImport.current&&<> · <button className="al-link" onClick={()=>{setFormat(dataset.format||'auto');setDialog('open')}}>read as another format</button></>}</small>}<button onClick={()=>setDialog('links')}>Link local genomes</button></div>
</details>
        <details className="al-section"><summary>Workspace & export</summary><button onClick={save}>Save workspace</button><button onClick={()=>workspace.current.click()}>Load workspace</button>
          <div className="al-source"><strong>Export sequences</strong><label>Format<select value={exportFormat} onChange={e=>setExportFormat(e.target.value)}>{exportChoices.map(([value,label])=><option key={value} value={value} disabled={exportRegions.length>1&&(value==='clustal'||value==='phylip-relaxed')}>{label}</option>)}</select></label><button disabled={busy||!exportRegions.length} onClick={exportSequences}>{state.selection.length?'Export picked region':'Export this layer'}</button><small>{!exportRegions.length?'Zoom in to an individual source block, or pick a region, to export its columns.':state.selection.length?`${exportRegions.length} picked ${exportRegions.length===1?'region':'regions'}, in each sequence's own aligned columns.`:`Every chunk on screen: ${exportRegions.length}. Pick a region to export just that.`}{exportRegions.length>1&&' Clustal and PHYLIP hold one alignment each, so several regions export as FASTA or MAF.'}</small></div></details>
        </div>
      </aside>
      {filterOpen&&<FilterPanel dataset={dataset} genomes={localGenomes} onError={setError}
        filterApplied={filterOn} applied={state.filter}
        onClose={()=>setFilterOpen(false)}
        onNewLayer={layerFromFilter}
        onApplyToOriginal={value=>patch({filter:value,filterOff:false,original:true})}
        onClearFilter={()=>patch({filter:null,filterOff:false})}/>}
      <main className={`al-main ${blockContext?'is-context':''}`}><div className="al-toolbar-rail" data-overflow={barEdges}><div className="al-toolbar" ref={toolbar} data-alignment-control-bar><div className="al-toolbar-group"><div className="al-toolbar-stack"><div className="al-source-nav" title={blockNavigator.title}><label>{blockNavigator.label} <input aria-label={state.original?"Jump to source block":"Jump to a block in this layer"} type="number" min={blockNavigator.min} max={blockNavigator.max} disabled={!blockNavigator.ready} placeholder={blockNavigator.grouped?'#':undefined} key={blockNavigator.grouped?'grouped':`${layer.id}:${blockNavigator.value}`} defaultValue={blockNavigator.grouped?'':blockNavigator.value??''} onKeyDown={e=>{if(e.key==='Enter'){const id=Number(e.currentTarget.value);if(Number.isInteger(id))blockNavigator.go(id)}}}/></label><button aria-label="Previous block" disabled={!!blockNavigator.grouped||blockNavigator.step(-1)==null} onClick={()=>blockNavigator.onStep(blockNavigator.step(-1))}>‹</button><button aria-label="Next block" disabled={!!blockNavigator.grouped||blockNavigator.step(1)==null} onClick={()=>blockNavigator.onStep(blockNavigator.step(1))}>›</button></div><button disabled={state.original||!active.fragments.length} onClick={()=>commit(s=>{const tidied=tidyLayer(active,ids,chunkGap(active.fragments,size.width)),view=fitCamera(tidied,size.width,size.height);return {...s,layers:s.layers.map(l=>l.id===active.id?{...tidied,camera:view}:l),camera:view}})}>Arrange</button></div><CursorTool mode={state.mode} shape={cursorShape} picked={state.selection.length} rows={selectionRows} root={explorerRoot.current}
        onMode={mode=>patch({mode})} onShape={setCursorShape} onClear={()=>patch({selection:[],highlighted:[]})}/><ZoomTool panel={!!state.planeZoom} plane={renderState.camera.plane} root={explorerRoot.current} onMode={zoomMode}/><ColourTool scheme={state.colourScheme} palette={state.palette} shading={state.shading} legendOverlay={!!state.legendOverlay}
        cohort={cohort} scale={conservation?.scale} light={theme==='light'} root={explorerRoot.current}
        motifs={motifs} motifsSaved={motifsSaved} config={config} disabled={motifOperation.running}
        hideUnmatched={!!state.hideUnmatchedMotifBlocks} onApply={applyColour}/></div><div className="al-toolbar-group al-toolbar-context"><button className={`al-control al-control-filter ${filterOn?'selected':''}`} disabled={!state.filter}
  aria-pressed={filterOn}
  title={!state.filter?'No filter is set. Build one in the sidebar.':filterOn?`Original is filtered to ${(state.filter.sequences||[]).length.toLocaleString()} sequences and ${(state.filter.blocks||[]).length.toLocaleString()} blocks. Click to turn it off; the filter is kept and the source is unchanged.`:'The filter is set but not applied. Click to turn it back on.'}
  onClick={()=>patch({filterOff:filterOn})}><ControlLabel label="Filter" value={!state.filter?'Not set':filterOn?'On':'Off'}/></button>
<div ref={hideButton} className={`al-split al-control-hide ${hiding?'selected':''} ${hideMenu?'menu-open':''}`}>
  {/* On, the face of the control is the way off: the press lands where the word
      that says it is on is, rather than a menu away from it. Off, there is
      nothing to switch, so the same press opens the menu that sets it. */}
  <button className="al-split-main" disabled={busy&&!hiding}
    aria-pressed={hiding}
    aria-haspopup={hiding?undefined:'dialog'} aria-expanded={hiding?undefined:hideMenu} aria-controls={!hiding&&hideMenu?hideMenuId:undefined}
    title={hiding?`Showing ${hidingSummary}. Click to show everything.`
      :canHide(hideChoice)||state.hideMemory?'Choose what to hide':'Hide gappy columns, or select sequences and blocks to choose what to hide'}
    onClick={()=>{if(hiding){showEverything();closeHideMenu()}else openHideMenu()}}><ControlLabel label="Hide" value={hideValue}/></button>
  <button className="al-split-arrow" disabled={busy}
    aria-label="Hide options" aria-haspopup="dialog" aria-expanded={hideMenu} aria-controls={hideMenu?hideMenuId:undefined}
    title={hiding?'Change what is hidden, or show everything':'Choose what to hide, or hide gappy columns'}
    onClick={openHideMenu}><ControlChevron/></button>
</div>
<GapTool closed={collapsing} marks={state.collapseMarks!==false} min={state.collapseMin||DEFAULT_COLLAPSE_MIN}
  percent={gapPercent(state.collapsePercent)} rows={gapCohort}
  status={collapse} root={explorerRoot.current} disabled={busy}
  onToggle={toggleGaps} onApply={applyGapSettings} onStop={cancelCollapse} onRetry={()=>collapse.retry()}/>
<LayerCycle layers={allLayers} active={layer.id} onChoose={switchLayer} dataset={dataset} inventory={displayInventory} light={theme==='light'} revision={revision}/></div></div></div>
        {!!blockContext&&<div className="al-context-bar" role="region" aria-label="Block context">
          <div className="al-context-id">
            <strong>Block {blockContext.sourceBlock}</strong>
            <small>{blockContext.length.toLocaleString()} alignment columns{blockContext.frame?' \u00b7 framed on the chunk you came from; the whole source block is in hand':''}</small>
          </div>
          <label className="al-context-mode">Compare
            <select aria-label="Comparison mode" value={blockContext.mode} onChange={e=>setBlockContext(d=>setMode(d,e.target.value))}>
              {COMPARISON_MODES.map(mode=><option key={mode} value={mode}>{mode==='reference'?'Reference':'Adjacent rows'}</option>)}
            </select>
          </label>
          {blockContext.mode==='reference'&&<label className="al-context-reference">Reference
            <select aria-label="Comparison reference" value={blockContext.reference||''} onChange={e=>setBlockContext(d=>setReference(d,e.target.value))}>
              {blockContext.rows.map(id=><option key={id} value={id}>{rowLabel(id)}</option>)}
            </select>
          </label>}
          <label>Inspect pair<select aria-label="Active comparison pair" value={activePair(blockContext)?.[1]||''} onChange={e=>setBlockContext(d=>({...d,pair:[comparatorFor(d,e.target.value),e.target.value]}))}>
            {blockContext.rows.filter(id=>comparatorFor(blockContext,id)).map(id=><option key={id} value={id}>{rowLabel(comparatorFor(blockContext,id))} / {rowLabel(id)}</option>)}
          </select></label>
          {blockContext.rows.length>2&&<button onClick={()=>setBlockContext(d=>{
            const pair=activePair(d)
            return pair?{...d,rows:pair,reference:pair[0],pair}:d
          })}>Show only this pair</button>}
          <button className={contextRows?'selected':''} aria-expanded={contextRows} onClick={()=>setContextRows(v=>!v)}>
            {blockContext.rows.length} of {blockContext.allRows.length} rows
          </button>
          {detailRestricted(blockContext)&&<button onClick={()=>setBlockContext(d=>({...d,rows:[...d.allRows],pair:null,reference:d.allRows.includes(d.reference)?d.reference:d.allRows[0]||null}))}>Show all rows</button>}
          <button className={blockContext.genomic?.open?'selected':''} aria-expanded={!!blockContext.genomic?.open}
            title="Show the active pair at their own genomic coordinates, with the sequence either side of the block"
            onClick={()=>setBlockContext(d=>({...d,genomic:{...d.genomic,open:!d.genomic?.open}}))}>Genomic context</button>
          <span className="al-context-spacer"/>
          <button className="al-context-close" aria-label="Close block context" title="Close block context (Escape)" onClick={closeBlockContext}>Back to alignment</button>
          {blockContext.referenceFallback==='none'&&<p className="al-context-note" role="status">No row in this block carries alignment sequence, so nothing is being compared.</p>}
          {blockContext.referenceFallback&&blockContext.referenceFallback!=='none'&&<p className="al-context-note" role="status">
            {rowLabel(blockContext.referenceFallback)} has no alignment coverage in this block, so {rowLabel(blockContext.reference)} is the reference instead.
          </p>}
          {contextData.zoomRequired&&<p className="al-context-note" role="status">Zoom in to see gene models and measured differences (up to 65,536 columns). <button onClick={()=>camera({...renderState.camera,scale:Math.max(renderState.camera.scale,(renderView.width-MARGIN_X)/32000)})}>Show annotation detail</button></p>}
          {contextData.truncated&&<p className="al-context-note" role="status">Some annotations are omitted at this scale. Narrow the window to inspect them.</p>}
          {!!contextData.warnings.length&&<p className="al-context-note" role="status">{contextData.warnings[0].message}</p>}
          <div className="al-context-key" role="group" aria-label="What a comparison band shows">
            {BAND_KINDS.map(([kind,colour,label])=><span key={kind}><i style={{background:colour}}/>{label}</span>)}
            <small>Agreement is left blank. Columns gapped in both rows are excluded from every count.</small>
          </div>
          <details className="al-context-transcripts"><summary>Genes and transcripts</summary>
            <p className="al-context-note">Select a transcript to highlight it. Click an exon or CDS in the track to inspect that feature.</p>
            {blockContext.rows.map(id=><div key={id}>
              <strong>{rowLabel(id)}</strong>
              {(contextData.features?.[id]?.genes||[]).map(gene=><label key={gene.gene_id}>
                <span>{gene.gene_name}</span>
                <select aria-label={`Transcript for ${gene.gene_name} in ${rowLabel(id)}`} value={gene.transcripts.some(t=>t.transcript_id===blockContext.picks[id])?blockContext.picks[id]:''}
                  onChange={e=>setBlockContext(d=>pickTranscript(d,id,e.target.value))}>
                  <option value="">Choose transcript</option>
                  {gene.transcripts.map(t=><option key={t.transcript_id} value={t.transcript_id}>{t.transcript_id}{t.is_canonical?' (canonical)':''}</option>)}
                </select>
                {gene.transcript_count>1&&<button aria-pressed={!!blockContext.expandedGenes?.[id]?.includes(gene.gene_id)} onClick={()=>setBlockContext(d=>{
                  const genes=d.expandedGenes?.[id]||[]
                  return {...d,expandedGenes:{...d.expandedGenes,[id]:genes.includes(gene.gene_id)?genes.filter(g=>g!==gene.gene_id):[...genes,gene.gene_id]}}
                })}>{blockContext.expandedGenes?.[id]?.includes(gene.gene_id)?'Representative only':`Show isoforms (${gene.transcript_count})`}</button>}
              </label>)}
            </div>)}
          </details>
          {!!blockContext.feature&&<div className="al-context-measure" role="region" aria-label="Selected feature measurements">
            <strong>{blockContext.feature.type.toUpperCase()} of {blockContext.feature.transcriptId} on {rowLabel(blockContext.feature.rowId)}</strong>
            <small>{(blockContext.feature.genomic.end-blockContext.feature.genomic.start).toLocaleString()} bp of genome,
              over {(blockContext.feature.end-blockContext.feature.start).toLocaleString()} alignment columns
              in {blockContext.feature.pieces.length} base-bearing {blockContext.feature.pieces.length===1?'piece':'pieces'}.</small>
            {blockContext.feature.clipped&&<small>This feature extends beyond the loaded interval; measurements cover only the displayed pieces.</small>}
            <small>Each row is measured against the selected feature’s row. Measurements are limited to loaded rows and features spanning at most 65,536 columns.</small>
            <table><thead><tr><th>Row</th><th>Comparable</th><th>Substituted</th><th>Gap in row</th><th>Gap in feature row</th><th>Unknown</th><th>No coverage</th></tr></thead>
              <tbody>{blockContext.rows.filter(id=>contextData.measurements?.has(id)).map(id=>{
                const measured=contextData.measurements.get(id)?.feature
                if(!measured)return null
                return <tr key={id} className={activePair(blockContext)?.[1]===id?'is-active':''}>
                  <th scope="row"><button className="al-link" title="Inspect this pair" onClick={()=>setBlockContext(d=>({...setReference(d,d.feature.rowId),mode:'reference',pair:[d.feature.rowId,id]}))}>{rowLabel(id)}</button></th>
                  <td>{measured.comparable.toLocaleString()}</td><td>{measured.substitution.toLocaleString()}</td>
                  <td>{measured.target_gap.toLocaleString()}{measured.entirely_gapped?' · every column':''}</td>
                  <td>{measured.reference_gap.toLocaleString()}</td>
                  <td>{measured.unknown.toLocaleString()}</td><td>{measured.unavailable.toLocaleString()}</td>
                </tr>})}</tbody></table>
            {blockContext.rows.some(id=>contextData.measurements?.get(id)?.feature?.entirely_gapped)&&
              <p className="al-context-note">A target gapped over every column of this feature is gapped in this alignment. That is not a search of that genome, and it is not exon loss.</p>}
            <button onClick={()=>setBlockContext(d=>({...d,feature:null}))}>Clear feature</button>
          </div>}
          {contextRows&&<div className="al-context-rows" role="group" aria-label="Rows in this block">
            {blockContext.rows.map((id,index)=><div key={id} className={id===blockContext.reference?'is-reference':''}>
              <button className="al-link" title="Use this row as the comparison reference" onClick={()=>setBlockContext(d=>setReference(d,id))} aria-pressed={id===blockContext.reference}>{rowLabel(id)}</button>
              <small>{id===blockContext.reference?'Reference':comparatorFor(blockContext,id)?`vs ${rowLabel(comparatorFor(blockContext,id))}`:'Nothing above to compare with'}</small>
              <button aria-label={`Move ${rowLabel(id)} up`} disabled={index===0} onClick={()=>setBlockContext(d=>moveDetailRow(d,id,d.rows[index-1]))}>↑</button>
              <button aria-label={`Move ${rowLabel(id)} down`} disabled={index===blockContext.rows.length-1} onClick={()=>setBlockContext(d=>moveDetailRow(d,id,d.rows[index+2]??null))}>↓</button>
              <button aria-label={`Remove ${rowLabel(id)} from this view`} disabled={blockContext.rows.length<2} onClick={()=>setBlockContext(d=>{
                const rows=d.rows.filter(value=>value!==id)
                return {...d,rows,pair:null,reference:rows.includes(d.reference)?d.reference:rows[0]||null}
              })}>×</button>
            </div>)}
          </div>}
        </div>}
        <div className="al-stage">{!!zoomHint&&state.planeZoom&&<div className="al-zoom-hint" role="status" key={zoomHint}><span>Panel zoom is at full size. Switch to <strong>Alignment</strong> for sequence-level zoom.</span><button className="primary" onClick={()=>zoomMode(false)}>Switch</button><button aria-label="Dismiss zoom hint" onClick={dismissZoomHint}>×</button></div>}
        {!!state.legendOverlay&&(!!scheme.legend||scheme.id==='motif')&&<ColourLegend legend={scheme.id==='motif'?motifLegend(snapshot?.settings.motifs||[]):scheme.legend(theme==='light',conservation?.scale,state.palette?.[scheme.id],state.shading)}
          cohort={scheme.cohort?cohort:null} onDismiss={()=>patch({legendOverlay:false})}/>}
        {scheme.id==='motif'&&(motifSearch.pending||motifSearch.failure||motifBlocks.blocks)&&<div className="al-motif-tile-status" role="status">{motifSearch.failure|| (motifSearch.pending?'Loading prepared matches…':`${motifBlocks.blocks.length.toLocaleString()} matching blocks`)}{motifBlocks.blocks&&<button onClick={()=>patch({hideUnmatchedMotifBlocks:false})}>Show unmatched blocks</button>}</div>}
        <LayerCanvas ref={canvas} layer={layer} state={canvasState} navigationCamera={renderState.camera} inventory={displayInventory} rowsById={rowsById} tiles={tiles} annotations={annotations} connections={connections} offWindow={offWindow} counts={counts} gaps={gaps} conservation={conservation} light={theme==='light'} config={config} onCamera={camera} onCopyChunk={copyChunk} onBlockToLayer={blockToLayer} onBrowseSelection={openSelectionInGenomeBrowser} onRemoveBlock={removeBlock} onRemoveRow={removeRow} onDeselect={deselect} onAggregate={(f,inner)=>inner?sourceBlock(inner.block):camera(fitCamera({fragments:[{...f,rowIds:[],layoutRows:1}]},size.width,size.height))} onToggleRows={f=>patch({blockRows:{...state.blockRows,[f.sourceBlock]:f.compact?'aligned':'compact'}})} onSelection={(value,lit)=>patch({selection:value,mode:'pan',...(lit?.length?{highlighted:toggleHighlights(state.highlighted,lit)}:{})})} onSelectionDrag={dragSelection} onSelectionDrop={dropSelection} onMove={(id,x,y)=>commit(s=>({...s,layers:s.layers.map(l=>l.id===s.active?{...l,fragments:l.fragments.map(f=>f.id===id?{...f,x,y}:f)}:l)}))} onHighlight={id=>patch({highlighted:addHighlight(state.highlighted,id)})} onUnlight={id=>patch(unlightRow(state,id))} onInspect={setInspect} onSize={setSize} onFallback={setFallback} onSourceBlock={sourceBlock} onReorderRow={reorderRow} onZoomLimit={noteZoomLimit} onBlockContext={f=>f?openBlockContext(f):closeBlockContext()} onPickTranscript={(rowId,transcriptId)=>setBlockContext(d=>pickTranscript(d,rowId,d.picks?.[rowId]===transcriptId?null:transcriptId))}
          onPickFeature={feature=>setBlockContext(d=>({...pickTranscript(d,feature.rowId,feature.transcriptId),feature,pair:comparatorFor(d,feature.rowId)?[comparatorFor(d,feature.rowId),feature.rowId]:d.pair,genomic:{...d.genomic,open:true,selection:null,columns:{start:feature.start,end:feature.end}}}))} focusOf={focusOf} blockContext={contextData}/></div>
        {!!blockContext?.genomic?.open&&<BlockContextGenomic dataset={dataset} detail={blockContext} rowsById={contextData.rowsById}
          rowLabel={rowLabel} theme={theme} onChange={setBlockContext}
          onOpenGenome={onOpenGenome?(rows,windows)=>openGenomicRowsInBrowser(rows,windows):null}/>}
        {/* Apply closes the menu, so the work it started has to be visible from
            the sheet as well - a bar that only existed inside the menu would be
            a bar nobody watching the alignment ever saw. */}
        {collapse.slow&&<div className="al-collapse-progress al-collapse-progress-bar" role="status" aria-live="polite">
          <div className="al-progress-foot"><small>Checking which columns are empty — {collapse.done+collapse.failed} of {collapse.total} {collapse.total===1?'block':'blocks'}</small>
            <button onClick={cancelCollapse}>Stop</button></div>
          <div className="al-progress-track"><div className="al-progress-fill" style={{width:`${Math.round(100*(collapse.done+collapse.failed)/Math.max(1,collapse.total))}%`}}/></div>
        </div>}
        <div className="al-status"><span>{pending?'Loading regional detail…':layer.fragments.some(f=>f.aggregate)?'Block presence overview':renderState.camera.scale*renderState.camera.plane>=NUCLEOTIDE_LETTER_THRESHOLD?'Sequence detail':renderState.camera.scale*renderState.camera.plane>=.65?'Base patterns':(scheme.status||state.shading==='uniform')?'Binned':blockContext?(blockContext.mode==='reference'?'Agreement to selected reference':'Agreement between adjacent rows'):'Binned agreement to first row'}{scheme.status?` \u00b7 ${scheme.status}${scheme.cohort?` among ${cohort?.ids.length||0} ${cohort?.ids.length===1?'sequence':'sequences'}${cohort?.picked?' picked':' in view'}`:''}`:''}{renderState.camera.plane<1?` · Whole panel at ${Math.round(renderState.camera.plane*100)}%`:''}{fallback?' · Canvas fallback':''}</span><span>{inspect?.kind==='aggregate'?`${namedRow?.label||''} · present in ${inspect.aggregate.presence?.[inspect.rowId]||0} of ${inspect.aggregate.count} source blocks (${inspect.aggregate.first}–${inspect.aggregate.last})`:inspect?.kind==='connection'?`${inventory.find(r=>r.id===inspect.connection.rowId)?.label||'Sequence'} · ${inspect.connection.columns==null?'Different source blocks: alignment distance unavailable':inspect.connection.columns<0?`${-inspect.connection.columns} overlapping alignment columns`:`${inspect.connection.columns} omitted alignment columns`} · ${counts[inspect.connection.id]?.bases??'?'} ungapped bases`:inspect?.kind==='cell'?`${namedRow?.label||''} · block ${inspect.fragment.sourceBlock}, column ${(inspect.column+1).toLocaleString()}${inspect.base?` · ${inspect.base}`:''}${inspect.placed?.length?` · In layers: ${inspect.placed.join(', ')}`:''}${inspect.features?.length?` · ${inspect.features.map(f=>f.type).join(', ')}`:''}`:'Click a name or a block header to pick it \u00b7 click a cell or a string to follow its path.'}</span></div>

        {!!warnings.length&&<div className="al-annotation-warning">Annotations unavailable for {warnings.length} visible rows: {warnings[0].message}</div>}
      </main>
    </div>}
    <ControlMenu id={hideMenuId} root={explorerRoot.current} anchor={hideMenu?menuAnchor:null} title="Hide" current={hideValue} className="al-hide-menu">
      {hiding&&<small>Showing {hidingSummary}.</small>}
      {/* Two removals, and they answer to different things. One reads the
          reader's picks and takes away what is not among them; the other reads
          the sheet as it stands and takes away columns nobody on it has a base
          in. Sharing one unlabelled list of controls, the second looked like a
          further condition on the first - and there was no way to ask for it
          alone, because Apply was gated on there being picks to act on. */}
      <label>What<select aria-label="What to hide" value={hideWhat} onChange={e=>setHideDraft(v=>({...v,what:e.target.value}))}>
        <option value="blocks">Blocks</option><option value="sequences">Sequences</option><option value="both">Both</option>
      </select><small>{hideWhat==='sequences'?'Keep the picked sequences, and the blocks still holding one.'
        :hideWhat==='both'?'Keep the picked sequences, in the blocks that pass.'
        :'Keep the blocks that pass; every sequence stays.'}</small></label>
      {!canHide(hideChoice)&&!state.hideMemory&&!viewHidden&&<small className="al-menu-warn">Nothing is picked yet, so there is nothing to keep. Click a sequence name or a block header, or drag with Select.</small>}
      {hideWhat!=='sequences'&&<label>Condition<select aria-label="Hide condition" value={hideMode} onChange={e=>setHideDraft(v=>({...v,mode:e.target.value}))}>
        <option value="or">Or</option><option value="and">And</option>
      </select><small>{hideMode==='and'
        ?'Every picked sequence has to be in a block for it to stay, and picked blocks are the only ones considered.'
        :'The picked blocks, and every block the picked sequences run through.'}</small></label>}
      {!state.original&&hideWhat!=='blocks'&&<label>Rows<select aria-label="Where surviving rows sit" value={hideRows} onChange={e=>setHideDraft(v=>({...v,rows:e.target.value}))}>
        <option value="compact">Compact</option><option value="keep">Keep positions</option>
      </select><small>{hideRows==='keep'
        ?'Every surviving sequence stays on the line it is on, leaving a gap where each hidden one was.'
        :'Surviving sequences rise to the top of each chunk, keeping the lines they share across chunks.'}</small></label>}
      {!!state.hideMemory&&<label className="al-menu-check"><input type="checkbox" checked={!!hideDraft?.previous} onChange={e=>setHideDraft(v=>({...v,previous:e.target.checked,...(e.target.checked?{what:state.hideMemory.what,mode:state.hideMemory.mode,rows:state.hideMemory.rowLayout||'compact'}:{})}))}/>Repeat the last hide</label>}
      <small>Changes take effect with Apply.</small>
      {hiding&&<button onClick={()=>{showEverything();closeHideMenu()}}>Show everything</button>}
      <div className="al-menu-actions"><button onClick={closeHideMenu}>Cancel</button>
        <button className="primary" disabled={busy||!hideMenuChoice||!canHide(hideMenuChoice)}
          onClick={()=>applyHide(hideMenuChoice,{what:hideWhat,mode:hideMode,rows:hideRows})}>Apply</button>
      </div>
    </ControlMenu>
    {selectionDrag&&<><div className="al-selection-dim"/><div className="al-selection-ghost" role="status" style={{left:selectionDrag.x+16,top:selectionDrag.y+16}}><strong>{selectionRows} sequences · {state.selection.length} regions</strong><small>{selectionDrag.target==='new'?'Release to create a new layer':selectionDrag.target?`Release to copy into ${state.layers.find(l=>l.id===selectionDrag.target)?.name}`:'Drop on a sidebar layer or ＋ New layer · Esc cancels'}</small></div></>}
    {merge&&<div className="al-modal-shade"><div className="al-modal" role="dialog" aria-modal="true" aria-label="Overlapping chunks"><h3>These layers contain overlapping chunks</h3><p>Combine overlapping source intervals into one chunk with both sets of sequences, or preserve each chunk separately. Unselected cells remain blank.</p><button className="primary" onClick={()=>finishMerge(merge.from,merge.to,true)}>Combine overlapping chunks</button><button onClick={()=>finishMerge(merge.from,merge.to,false)}>Keep chunks separate</button><button onClick={()=>setMerge(null)}>Cancel</button></div></div>}
    {dialog&&<div className="al-modal-shade"><div className={`al-modal ${dialog==='links'?'al-links-modal':''}`} role="dialog" aria-modal="true" aria-label={typeof dialog==='string'?dialog:'Rename layer'}><button className="al-close" aria-label="Close dialog" onClick={()=>setDialog(null)}>×</button>
      {dialog==='open'&&<><h3>Open a nucleotide alignment</h3><p>Load a local MAF, aligned FASTA, Clustal, Stockholm, PHYLIP, NEXUS, MSF or XMFA file. Compressed text files are supported.</p><label>Format<select value={format} onChange={e=>setFormat(e.target.value)}><option value="auto">Detect automatically</option>{formatChoices.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><small>{format==='auto'?'The file is read by its own signature. The format used is shown once it loads, so a wrong guess can be corrected here.':'This reader is used whatever the file claims to be.'}</small><button className="primary" disabled={busy||!!job} onClick={chooseFile}>Choose file</button><label>Or enter a local file path<input placeholder="/path/to/alignment.maf" value={path} onChange={e=>setPath(e.target.value)}/></label><button disabled={!path||busy||!!job} onClick={()=>startImport({path,format})}>Open path</button><button disabled={busy||!!job} onClick={()=>startImport({name:'Layer exploration example',format:'fasta',content:demoAlignment()})}>Explore example</button><small>The source file stays unchanged. Layer layouts are stored separately.</small></>}
      {dialog?.rename&&<><h3>Edit layer</h3>
        <label>Colour<div className="al-layer-colour">
          <i style={{background:state.layers.find(l=>l.id===dialog.rename)?.color}}/>
          <button onClick={()=>setColorTarget(dialog.rename)}>Change colour…</button>
        </div></label><input aria-label="Layer name" autoFocus value={layerName} maxLength={120} onChange={e=>setLayerName(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&layerName.trim()){commit(s=>({...s,layers:s.layers.map(l=>l.id===dialog.rename?{...l,name:layerName.trim()}:l)}));setDialog(null);setLayerName('')}}}/><button className="primary" disabled={!layerName.trim()} onClick={()=>{commit(s=>({...s,layers:s.layers.map(l=>l.id===dialog.rename?{...l,name:layerName.trim()}:l)}));setDialog(null);setLayerName('')}}>Save name</button></>}
      {dialog==='select'&&<><h3>Select by alignment coordinates</h3>{!selectedFragment?<p className="al-hint">This view groups several source blocks together, so there are no individual alignment columns to address. Zoom in until single blocks are shown, then select by coordinates.</p>:<><label>{state.original?'Source block':'Chunk'}<select value={selectedFragment.id} onChange={e=>{const f=selectableFragments.find(f=>f.id===e.target.value);setRange({fragment:f.id,start:f.start+1,end:f.end});setSelectRows([])}}>{selectableFragments.map(f=><option key={f.id} value={f.id}>Block {f.sourceBlock} · {f.start+1}–{f.end}</option>)}</select></label><div className="al-range"><label>First column<input type="number" min={selectedFragment.start+1} max={selectedFragment.end} value={range.start} onChange={e=>setRange({...range,start:Number(e.target.value)})}/></label><label>Last column<input type="number" min={selectedFragment.start+1} max={selectedFragment.end} value={range.end} onChange={e=>setRange({...range,end:Number(e.target.value)})}/></label></div><label>Sequences <small>None checked means all rows in this region.</small><input placeholder="Search sequences" value={rowQuery} onChange={e=>setRowQuery(e.target.value)}/></label><div className="al-row-choices">{rowChoices.slice(0,200).map(r=><label key={r.id}><input type="checkbox" checked={selectRows.includes(r.id)} onChange={e=>setSelectRows(v=>e.target.checked?[...v,r.id]:v.filter(id=>id!==r.id))}/>{r.label||r.source}</label>)}</div>{rowChoices.length>200&&<small>Showing the first 200 of {rowChoices.length.toLocaleString()} matching sequences. Search to narrow the list, or leave every box unchecked to select all {selectedFragment.rowIds.length.toLocaleString()} rows in this block.</small>}<button className="primary" disabled={range.end<range.start||range.start<=selectedFragment.start||range.end>selectedFragment.end} onClick={()=>{patch({mode:'pan',selection:[{fragmentId:selectedFragment.id,start:range.start-1,end:range.end,rowIds:selectRows.length?selectRows:selectedFragment.rowIds}]});setDialog(null)}}>Select region</button></>}</>}
      {dialog==='links'&&<><h3>Link alignment sequences to genomes</h3>
        <p>Use an assembly accession as the genome identity and a region name or interval as its location. Links enrich the alignment; they never remove sequences.</p>
        <div className="al-link-import">
          <button className="primary" disabled={linkImporting} onClick={()=>metadata.current.click()}>{linkImporting?'Importing…':'Import TSV or JSON'}</button>
          <small>Required fields: <code>source</code>, <code>assembly</code>, <code>region</code>. Optional: <code>strand</code>, <code>assembly_name</code>, <code>label</code>.</small>
          <small>Examples: <code>1</code> links a whole sequence from base 1; <code>1:10,000-50,000</code> supplies an explicit start. If its span differs from the ungapped sequence, the start is retained and the end is derived from the sequence. Strand accepts <code>+</code>, <code>-</code>, <code>1</code>, or <code>-1</code>.</small>
        </div>
        {(reportGroups.length>0||linkReport)&&<section className="al-link-report" aria-label="Genome link report">
          <div className="al-link-report-head"><strong>{linkReport?linkReport.label:'Current links'}</strong><span>{linkReport?`${linkReport.updated||0} linked`: `${reportGroups.reduce((total,group)=>total+group.count,0)} linked`}</span></div>
          <div className="al-link-summary">
            {['topbar','local','unavailable','unresolved'].map(status=>{
              const count=reportGroups.filter(group=>group.status===status).reduce((total,group)=>total+group.count,0)+(status==='unresolved'?(linkReport?.unresolved?.length||0):0)
              const title={topbar:'In top bar',local:'Local',unavailable:'Not downloaded',unresolved:'Unresolved'}[status]
              return <span key={status} className={`al-link-count ${status}`}><strong>{count}</strong>{title}</span>
            })}
          </div>
          <div className="al-link-list">
            {reportGroups.map(group=><div className="al-link-row" key={`${group.status}:${group.assembly}`}>
              <span className={`al-link-pill ${group.status}`}>{group.status==='topbar'?'Top bar':group.status==='local'?'Local':group.status==='unavailable'?'Not downloaded':'Unresolved'}</span>
              <span><strong>{genomeDisplayName(group.genome,group.assembly)||group.assembly}</strong><small>{group.assembly} · {group.regionLabel} · {group.count} {group.count===1?'sequence':'sequences'}</small></span>
              {group.status==='local'&&onAddGenome&&<button disabled={addingAssembly===group.assembly} onClick={()=>addLinkedGenome(group.genome)}>{addingAssembly===group.assembly?'Adding…':'Add to top bar'}</button>}
            </div>)}
            {(linkReport?.unresolved||[]).map(source=><div className="al-link-row" key={`unresolved:${source}`}><span className="al-link-pill unresolved">Unresolved</span><span><strong>{source}</strong><small>No alignment sequence has this source identifier.</small></span></div>)}
          </div>
          {(linkReport?.warnings||[]).map((warning,index)=><small className="al-link-warning" key={`${warning.id}:${index}`}>{warning.source}: {warning.message}</small>)}
        </section>}
        <div className="al-link-manual"><strong>Link one sequence</strong>
          <label>Alignment sequence<select value={link.row} onChange={e=>setLink({...link,row:e.target.value})}><option value="">Choose a sequence</option>{inventory.map(row=><option key={row.id} value={row.id}>{row.label||row.source}{row.metadata?.assembly?' · linked':''}</option>)}</select></label>
          <label>Local genome<select value={link.assembly} onChange={e=>setLink({...link,assembly:e.target.value})}><option value="">Choose a genome</option>{genomeOptions.map(genome=>{const assembly=getAssemblyAccession(genome);return <option key={getGenomeKey(genome)||assembly} value={assembly}>{genomeDisplayName(genome,assembly)} · {assembly}</option>})}</select></label>
          <div className="al-link-location"><label>Region<input placeholder="1 or 1:10,000-50,000" value={link.region} onChange={e=>setLink({...link,region:e.target.value})}/></label><label>Strand<select value={link.strand} onChange={e=>setLink({...link,strand:e.target.value})}><option value="+">+</option><option value="-">−</option></select></label></div>
          <button disabled={linkImporting||!link.row||!link.assembly||!link.region.trim()} onClick={()=>applyMetadata(JSON.stringify([{id:link.row,assembly:link.assembly,region:link.region,strand:link.strand}]),'.json','Manual link').then(()=>patch({annotations:true})).catch(error=>setError(error.message))}>Apply link</button>
          {localGenomesLoading&&<small>Refreshing local genome availability…</small>}
        </div>
      </>}
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
    <input ref={metadata} hidden type="file" accept=".tsv,.json" onChange={async e=>{const f=e.target.files?.[0];e.target.value='';if(f)try{await applyMetadata(await f.text(),f.name.toLowerCase().endsWith('.tsv')?'.tsv':'.json',f.name)}catch(error){setError(error.message)}}}/>
    <input ref={workspace} hidden type="file" accept=".json" onChange={async e=>{const f=e.target.files?.[0];e.target.value='';if(f)try{const value=JSON.parse(await f.text());if(value.source?.id&&value.source.id!==dataset.id)throw new Error('This workspace references a different alignment. Open that source first.');const next=validateLayerWorkspace(value,ids);const token=++blockNav.current;const block=await api(`/datasets/${dataset.id}/blocks/${next.sourceBlock}/rows`);if(token!==blockNav.current)return;setSource(block);commit(next.original?{...next,camera:{...next.camera,x:next.camera.x+(block.layout_start||0)}}:next)}catch(error){setError(error.message)}}}/>
  </section>
}
