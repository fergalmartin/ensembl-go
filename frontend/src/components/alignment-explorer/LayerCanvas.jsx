import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { sampleBase } from './tileCoverage'
import { recordPerformance } from './performance'
import { hitAtPoint } from './originalLayout'
import { paintLayer, panelRect, explorerColors } from './paintLayer'
import { paintBlockContext } from './paintBlockContext'
import { MARGIN_X, HEADER_HEIGHT, MARGIN_Y, ROW_HEIGHT } from './data'
import { originalRowDropTarget } from './rowDrop.js'
import { isSelectMode } from './selectKinds'
import { clamp, hasCell, rowCount, rowSlot, selectedCellAt, pickAt, selectionRect as selectRectangle, layerXToColumn, wheelScrollsRowList, rowListScrolls, togglePicks, blockPick, rowPicks, rowIsLit, namesInRect, rectEntersCells, planeOf, planeViewport, panelZoom, panelZoomBlocked, blockFitScale, blockAtLayoutX, pinnedBottom } from './layers'
import { resolveBrowsingControls, readWheelEvent, beginWheelGesture, resolveWheelAction } from '../../utils/browsingControls'

/** A classical canvas becomes the texture of an actual 3D panel. The same hit
 * coordinates and renderer drive the complete non-WebGL fallback. */
/** How far a press on the picked cells may travel and still be a click. */
const TRANSFER_SLOP=2
const LayerCanvas = forwardRef(function LayerCanvas({ layer, state, navigationCamera, inventory, rowsById, tiles, annotations, connections, offWindow, counts, gaps, conservation, light, config, onCamera, onCopyChunk, onBlockToLayer, onBrowseSelection, onRemoveBlock, onRemoveRow, onDeselect, onAggregate, onToggleRows, onSelection, onSelectionDrag, onSelectionDrop, onMove, onHighlight, onUnlight, onInspect, onSize, onFallback, onSourceBlock, onReorderRow, onZoomLimit, onBlockContext, onPickTranscript, onPickFeature, focusOf, blockContext }, ref) {
  const host = useRef(null), engine = useRef(null), latest = useRef(null), interaction = useRef(null), hits = useRef([]), space = useRef(false)
  const [size, setSize] = useState({width:800,height:500}), [drag,setDrag] = useState(null), [rectangle,setRectangle] = useState(null), [reorder,setReorder] = useState(null), [overSelection,setOverSelection] = useState(false), [hoverPick,setHoverPick] = useState(null), [hover,setHover] = useState(null)
  useLayoutEffect(()=>{ latest.current = {layer,state,navigationCamera,inventory,rowsById,tiles,annotations,connections,counts,light,config,onCamera:navigate,onSelection,onSelectionDrag,onSelectionDrop,onMove,onHighlight,onUnlight,onInspect,onSize,onFallback,onZoomLimit,size,drag,rectangle} })
  // Plane units, the coordinates the painter drew in and every hit region, drag
  // and drop target is expressed in. Dividing here once is the whole of what
  // plane zoom costs the gestures below: nothing downstream knows about it.
  function navigate(value){const bounded=onCamera(value);if(latest.current)latest.current.navigationCamera=bounded||value}
  function canvasPoint(event,camera=latest.current?.state?.camera){
    const r=host.current.getBoundingClientRect(),x=event.clientX-r.left,y=event.clientY-r.top,e=engine.current
    const plane=planeOf(camera)
    if(e?.renderer&&!e.failed){e.raycaster.setFromCamera(new THREE.Vector2(x/r.width*2-1,1-y/r.height*2),e.camera);const hit=e.raycaster.intersectObject(e.mesh)[0];if(hit)return {x:hit.uv.x*r.width/plane,y:(1-hit.uv.y)*r.height/plane}}
    return {x:x/plane,y:y/plane}
  }
  useImperativeHandle(ref,()=>({ image:()=>engine.current?.textureCanvas.toDataURL('image/png') }))
  useEffect(()=>{
    const el=host.current, textureCanvas=document.createElement('canvas'), fallback=document.createElement('canvas')
    const e={textureCanvas, fallback, renderer:null, mesh:null};engine.current=e
    try {
      e.renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,preserveDrawingBuffer:true})
      e.renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2))
      e.renderer.outputColorSpace=THREE.SRGBColorSpace
      e.scene=new THREE.Scene();e.camera=new THREE.OrthographicCamera(-400,400,250,-250,.1,5000);e.camera.position.z=1800
      e.group=new THREE.Group();e.scene.add(e.group)
      e.texture=new THREE.CanvasTexture(textureCanvas);e.texture.colorSpace=THREE.SRGBColorSpace;e.texture.minFilter=THREE.LinearFilter;e.texture.magFilter=THREE.NearestFilter
      e.mesh=new THREE.Mesh(new THREE.PlaneGeometry(1,1),new THREE.MeshBasicMaterial({map:e.texture,side:THREE.DoubleSide}));e.group.add(e.mesh)
      e.raycaster=new THREE.Raycaster();el.appendChild(e.renderer.domElement)
      e.lost=event=>{event.preventDefault();e.renderer.domElement.style.display='none';el.appendChild(fallback);e.failed=true;latest.current.onFallback(true);fallback.width=textureCanvas.width;fallback.height=textureCanvas.height;fallback.getContext('2d').drawImage(textureCanvas,0,0)}
      e.renderer.domElement.addEventListener('webglcontextlost',e.lost)
    } catch {e.failed=true;el.appendChild(fallback);latest.current.onFallback(true)}
    const observer=new ResizeObserver(([entry])=>{const next={width:Math.max(1,Math.floor(entry.contentRect.width)),height:Math.max(1,Math.floor(entry.contentRect.height))};setSize(next);latest.current.onSize(next)})
    observer.observe(el)
    const wheel=event=>{
      if(interaction.current?.kind==='transfer'){event.preventDefault();return}
      const p=latest.current, descriptor=readWheelEvent(event,{pageHeight:p.size.height})
      const camera=p.navigationCamera||p.state.camera
      // A wheel notch is so many real pixels whatever the plane is doing, so the
      // view keeps up with the hand rather than crawling as the sheet shrinks.
      const plane=planeOf(camera)
      // Scrolling the name list scrolls the rows, carrying the alignment with it.
      // Left of the gutter edge the horizontal controls would otherwise take the
      // wheel and there would be no way to move down a long list of sequences.
      // Only where there is a list to scroll, though: only the original draws a
      // gutter, and only a list taller than the window has anywhere to go.
      const gutter=p.state.original&&rowListScrolls(p.layer,camera,p.size)
      if(wheelScrollsRowList(canvasPoint(event,camera).x,descriptor,MARGIN_X,gutter)){
        event.preventDefault();event.stopPropagation()
        p.onCamera({...camera,y:camera.y+descriptor.dy/plane});return
      }
      const gesture=beginWheelGesture(e.gesture,descriptor,event.timeStamp)
      const intent=resolveWheelAction(descriptor,resolveBrowsingControls(p.config),{gesture,canScrollPage:true});e.gesture={...gesture,mode:intent.nextGestureMode}
      if(intent.type==='none')return
      event.preventDefault();event.stopPropagation()
      if(intent.type==='page_scroll'){p.onCamera({...camera,y:camera.y+descriptor.dy/plane});return}
      if(intent.type==='pan'){p.onCamera({...camera,x:camera.x+intent.dxPx/plane/camera.scale});return}
      if(intent.type==='zoom'){
        const point=canvasPoint(event,camera),x=intent.anchor==='center'?p.size.width/plane/2:point.x
        // The same gesture, walking the panel ladder instead of the columns.
        if(p.state.planeZoom){
          const factor=1/intent.factor
          // Counted per gesture, not per event: one flick of a wheel or one
          // pinch delivers dozens of events, and counting those would make two
          // "attempts" out of a single movement of the hand.
          if(panelZoomBlocked(camera,factor)){if(!gesture.continues)p.onZoomLimit?.(true);return}
          p.onZoomLimit?.(false)
          p.onCamera(panelZoom(camera,factor,{blockScale:blockFitScale(p.layer,camera,p.size),size:p.size}));return
        }
        p.onZoomLimit?.(false)
        const scale=clamp(camera.scale/intent.factor,Number.EPSILON,24),anchor=camera.x+(x-MARGIN_X)/camera.scale
        p.onCamera({...camera,scale,x:anchor-(x-MARGIN_X)/scale})
      }
    }
    el.addEventListener('wheel',wheel,{passive:false})
    return()=>{observer.disconnect();el.removeEventListener('wheel',wheel);if(e.renderer){e.renderer.domElement.removeEventListener('webglcontextlost',e.lost);e.renderer.dispose();e.group.children.forEach(m=>{m.geometry.dispose();m.material.dispose()});e.texture.dispose()}el.replaceChildren();engine.current=null}
  },[])
  useLayoutEffect(()=>{
    const e=engine.current;if(!e)return
    const started=performance.now()
    const dpr=Math.min(window.devicePixelRatio||1,2),canvas=e.textureCanvas
    if(canvas.width!==Math.floor(size.width*dpr)||canvas.height!==Math.floor(size.height*dpr)){
      canvas.width=size.width*dpr;canvas.height=size.height*dpr
      if(e.texture){e.texture.dispose();e.texture=new THREE.CanvasTexture(canvas);e.texture.colorSpace=THREE.SRGBColorSpace;e.texture.minFilter=THREE.LinearFilter;e.texture.magFilter=THREE.NearestFilter;e.mesh.material.map=e.texture;e.mesh.material.needsUpdate=true}
    }
    // The plane factor rides on the canvas transform and the painter is handed
    // the viewport it opens up, so one drawing serves both zooms unchanged.
    const plane=planeOf(state.camera),view=planeViewport(size,state.camera)
    const ctx=canvas.getContext('2d');ctx.setTransform(dpr*plane,0,0,dpr*plane,0,0)
    hits.current=paintLayer(ctx,{layer,camera:state.camera,size:view,inventory,rowsById,tiles,annotations,connections,offWindow,counts,state,drag,hover,gaps,reorder,selectionRect:rectangle,conservation,hoverPick,light,focusOf})
    // After the sheet and over it, appended to the same hit list: `hitAtPoint`
    // walks backwards, so the overlay's own regions answer first without either
    // painter knowing about the other.
    if(state.blockContext)hits.current=[...hits.current,...paintBlockContext(ctx,{layer,camera:state.camera,size:view,
      detail:state.blockContext,features:blockContext?.features,rowsById:blockContext?.rowsById,inventory,
      comparison:blockContext?.comparison,comparisonPending:blockContext?.comparisonPending,
      colors:explorerColors(light),light,pending:blockContext?.pending,zoomRequired:blockContext?.zoomRequired})]
    if(e.failed){if(e.fallback.width!==canvas.width||e.fallback.height!==canvas.height){e.fallback.width=canvas.width;e.fallback.height=canvas.height}e.fallback.getContext('2d').drawImage(canvas,0,0);return}
    if(e.width!==size.width||e.height!==size.height||e.dpr!==dpr){e.renderer.setPixelRatio(dpr);e.renderer.setSize(size.width,size.height,false);e.width=size.width;e.height=size.height;e.dpr=dpr}
    e.camera.left=-size.width/2;e.camera.right=size.width/2;e.camera.top=size.height/2;e.camera.bottom=-size.height/2;e.camera.updateProjectionMatrix()
    e.mesh.scale.set(size.width,size.height,1);e.texture.needsUpdate=true
    e.camera.updateMatrixWorld(true);e.scene.updateMatrixWorld(true);e.renderer.render(e.scene,e.camera)
    recordPerformance('paint',{ms:performance.now()-started,textureBytes:canvas.width*canvas.height*4})
  },[layer,state,inventory,rowsById,tiles,annotations,connections,offWindow,counts,gaps,conservation,light,size,drag,hover,hoverPick,reorder,rectangle,focusOf,blockContext])
  // Where a drop lands, read off the layout as drawn rather than worked out from
  // a row height. The indicator and the move both come from this, so what is
  // shown and what happens cannot disagree.
  function reorderTarget(current,point){
    if(state.original){
      // The gutter publishes the rows it draws and whose they are; which list a
      // drop should be read against is `originalRowDropTarget`'s to decide.
      const gutterRows=(hits.current||[]).filter(h=>h.kind==='label')
      return originalRowDropTarget({point,fragments:layer.fragments,camera:state.camera,
        gutterRows,gutterAnchor:gutterRows[0]?.anchor??null,order:inventory.map(r=>r.id),
        jumpBlock:current.jumpBlock??null,fragmentId:current.fragmentId??null,rowId:current.rowId})
    }
    const f=layer.fragments.find(x=>x.id===current.fragmentId)
    if(!f)return {slot:0,lineY:point.y}
    const top=panelRect(f,state.camera).y
    const slot=clamp(Math.round((point.y-top)/ROW_HEIGHT),0,Math.max(0,rowCount(f)-1))
    return {slot,lineY:top+slot*ROW_HEIGHT}
  }
  function pointerHover(point){
    // A block or merged block under the cursor, with the layout position inside
    // it so a merged block can point at the individual block being pointed at.
    for(const f of layer.fragments){
      const r=panelRect(f,state.camera)
      if(point.x<r.x||point.x>r.x+r.width||point.y<r.y-HEADER_HEIGHT||point.y>r.y+r.height)continue
      const column=layerXToColumn(f,state.camera,state.camera.x+(point.x-MARGIN_X)/state.camera.scale)
      return {fragmentId:f.id,layoutX:f.aggregate?f.x+column-f.start:null}
    }
    return null
  }
  function layoutPoint(p,camera){return {x:camera.x+(p.x-MARGIN_X)/camera.scale,y:(p.y-MARGIN_Y+camera.y)/ROW_HEIGHT}}
  // What the press found, and whether it is allowed to take hold of it. Only
  // Pan grabs content: with Select or Columns armed, a press that would have
  // picked up a row, a block or a connector starts the rectangle instead, which
  // is the whole of what those modes are for.
  const hitHere=(point,filter)=>hitAtPoint(hits.current,point,{original:!!state.original||!!state.blockContext,marginX:MARGIN_X,filter:hit=>(!filter||filter(hit))&&(!state.blockContext||point.y>=pinnedBottom(layer,state.camera)||layer.fragments.find(f=>f.id===hit.fragmentId)?.pinned)})
  function pointerDown(event){
    if(event.button!==0&&event.button!==1)return
    host.current.focus();const point=canvasPoint(event),p=latest.current
    const hit=hitHere(point),grabs=!isSelectMode(state.mode),editing=!!state.blockContext
    if(hit?.kind==='aggregate'){
      // The block under the cursor, which is the one the header names and the
      // one highlighted below it, rather than the whole merged group.
      const f=layer.fragments.find(x=>x.id===hit.fragmentId)
      onAggregate?.(f,f?blockAtLayoutX(f,f.x+layerXToColumn(f,state.camera,state.camera.x+(point.x-MARGIN_X)/state.camera.scale)-f.start):null)
      return
    }
    if(hit?.kind==='rows'){onToggleRows?.(layer.fragments.find(f=>f.id===hit.fragmentId));return}
    if(hit?.kind==='copy'){onCopyChunk?.(layer.fragments.find(f=>f.id===hit.fragmentId));return}
    if(hit?.kind==='browse'){onBrowseSelection?.(layer.fragments.find(f=>f.id===hit.fragmentId));return}
    if(hit?.kind==='context'){onBlockContext?.(layer.fragments.find(f=>f.id===hit.fragmentId));return}
    // The feature is the finer target and is published after the transcript, so
    // `hitAtPoint`'s reverse walk finds it first: pressing an exon measures that
    // exon, pressing the model around it chooses the transcript.
    if(hit?.kind==='feature'){onPickFeature?.(hit.feature);return}
    if(hit?.kind==='transcript'){onPickTranscript?.(hit.rowId,hit.transcriptId,hit.geneId);return}
    // Removing a chunk or a sequence renumbers the layer's row slots
    // (`compactSlots`), which is exactly what the grouped lanes of block context
    // are made of - a removal there would collapse every track lane onto its
    // sequence. Block context is a lens, not an edit, so neither is offered.
    if(hit?.kind==='removeBlock'&&!editing){onRemoveBlock?.(layer.fragments.find(f=>f.id===hit.fragmentId));return}
    // Before the name's own handler, or taking a row out would first pick it.
    if(hit?.kind==='removeRow'&&!editing){onRemoveRow?.(hit.rowId);return}
    if(hit?.kind==='deselect'){setHoverPick(null);onDeselect?.(hit.pick);return}
    if(hit?.kind==='layer'){onBlockToLayer?.(layer.fragments.find(f=>f.id===hit.fragmentId));return}
    if(hit?.kind==='label'&&grabs){
      // Highlight on the press, so the row is picked out before it is dragged
      // anywhere. A click that goes nowhere puts it back out on release - and
      // what counts as already lit is the whole of it, a pick or a click on a
      // cell, so a name click always answers what the reader can see.
      const already=rowIsLit(state,hit.rowId)
      // Same for one name at a time: a click on a name off the sheet used to do
      // nothing at all, which read as the name not being a control.
      if(!already){const picks=rowPicks(layer,hit.rowId);onSelection(togglePicks(state.selection,picks),picks.length?null:[hit.rowId])}
      if(editing){event.preventDefault();return}
      interaction.current={kind:'reorder',point,rowId:hit.rowId,fragmentId:hit.fragmentId,wasPicked:already,fromLabel:true,camera:{...p.state.camera}}
      event.currentTarget.setPointerCapture(event.pointerId);event.preventDefault();return
    }
    if(hit?.kind==='blockjump'&&grabs){
      onHighlight(hit.rowId)
      interaction.current={kind:'reorder',point,rowId:hit.rowId,fragmentId:hit.fragmentId,
        jumpBlock:hit.block,fromConnector:true,camera:{...p.state.camera}}
      event.currentTarget.setPointerCapture(event.pointerId);event.preventDefault();return
    }
    if(hit?.kind==='connection')onInspect(hit)
    // Either end of a connector is a handle on the row in the block at that end.
    // A row whose name sits beside an earlier chunk has no other handle in the
    // chunk the path runs into, which is where it most needs one.
    if(hit?.kind==='connection'&&hit.points&&grabs){
      const head=hit.points[0],tail=hit.points[hit.points.length-1]
      const intoTail=Math.hypot(point.x-tail.x,point.y-tail.y)<=Math.hypot(point.x-head.x,point.y-head.y)
      interaction.current={kind:'reorder',point,rowId:hit.connection.rowId,
        fragmentId:intoTail?hit.connection.to.id:hit.connection.from.id,
        fromConnector:true,camera:{...p.state.camera}}
      event.currentTarget.setPointerCapture(event.pointerId);event.preventDefault();return
    }
    const selected=state.mode==='pan'&&selectedCellAt(layer,state.selection,layoutPoint(point,state.camera),state.camera)
    const kind=space.current||event.button===1?'pan':selected?'transfer':hit?.kind==='header'&&grabs?(state.original?'header':'move'):grabs?'pan':'select'
    const fragment=kind==='move'?layer.fragments.find(f=>f.id===hit.fragmentId):null
    const cell=hit?.connection?.rowId||layer.fragments.map(f=>{const r=panelRect(f,state.camera),index=f.rowIds.findIndex((_,i)=>point.y>=r.y+rowSlot(f,i)*ROW_HEIGHT&&point.y<r.y+(rowSlot(f,i)+1)*ROW_HEIGHT);return point.x>=r.x&&point.x<r.x+r.width&&index>=0?f.rowIds[index]:null}).find(Boolean)
    interaction.current={kind,point,cell,clientX:event.clientX,clientY:event.clientY,camera:{...p.state.camera},fragment,headerId:hit?.fragmentId};event.currentTarget.setPointerCapture(event.pointerId);event.preventDefault()
  }
  function pointerMove(event){
    const point=canvasPoint(event),current=interaction.current
    if(!current){
      const inside=pickAt(layer,state.selection,layoutPoint(point,state.camera),state.camera)
      setOverSelection(state.mode==='pan'&&!!inside)
      // The cross counts as part of its own region. On a narrow selection it
      // reaches past the edge, and without this, moving onto it would decide
      // the region was no longer hovered and take the cross away mid-reach.
      const onCross=hitHere(point,h=>h.kind==='deselect')
      // By reference, and only on a change: the canvas repaints whole, so
      // setting this on every pixel of travel would repaint on every pixel.
      setHoverPick(prev=>{const next=inside||onCross?.pick||null;return prev===next?prev:next})
      const next=pointerHover(point)
      setHover(prev=>prev?.fragmentId===next?.fragmentId&&prev?.layoutX===next?.layoutX?prev:next)
      const hit=hitHere(point)
      host.current.title=hit?.kind==='blockjump'?`Open source block ${hit.block}`:hit?.kind==='aggregate'?(next&&blockAtLayoutX(layer.fragments.find(f=>f.id===hit.fragmentId),next.layoutX)?`Open source block ${blockAtLayoutX(layer.fragments.find(f=>f.id===hit.fragmentId),next.layoutX).block}`:`Zoom into source blocks ${layer.fragments.find(f=>f.id===hit.fragmentId)?.aggregate.first}–${layer.fragments.find(f=>f.id===hit.fragmentId)?.aggregate.last}`):hit?.kind==='rows'?'Collapse or align absent rows for this block':hit?.kind==='copy'?'Copy chunk as aligned FASTA':hit?.kind==='browse'?'Open the selected genomic regions in Genome Browser':hit?.kind==='layer'?'Create a layer from this source block':hit?.kind==='removeBlock'?'Remove this chunk from the layer':hit?.kind==='removeRow'?'Remove this sequence from every chunk in the layer':hit?.kind==='context'?'Open this block on its own, with each genome\u2019s annotation':hit?.kind==='feature'?hit.label:hit?.kind==='transcript'?hit.label:hit?.kind==='deselect'?'Drop this selected region':''
      if(hit?.kind==='connection'){onInspect(hit);return}
      for(const f of layer.fragments){const r=panelRect(f,state.camera),index=f.rowIds.findIndex((_,i)=>point.y>=r.y+rowSlot(f,i)*ROW_HEIGHT&&point.y<r.y+(rowSlot(f,i)+1)*ROW_HEIGHT)
        if(point.x>=r.x&&point.x<r.x+r.width&&index>=0){if(f.aggregate){onInspect({kind:'aggregate',rowId:f.rowIds[index],aggregate:f.aggregate});return}const column=f.start+Math.floor((point.x-r.x)/r.scale),base=sampleBase(tiles[f.id],f.rowIds[index],column);onInspect({kind:'cell',rowId:f.rowIds[index],fragment:f,column,base:hasCell(f,f.rowIds[index],column)?base:'Unselected cell',placed:(state.placedOverlay||[]).filter(p=>p.sourceBlock===f.sourceBlock&&hasCell(p,f.rowIds[index],column)).map(p=>p.name),features:(annotations[f.id]?.[f.rowIds[index]]||[]).filter(a=>column>=a.start&&column<=a.end)});return}}
      return
    }
    if(current.kind==='transfer'){
      if(current.started||Math.hypot(event.clientX-current.clientX,event.clientY-current.clientY)>TRANSFER_SLOP){
        current.started=true;onSelectionDrag({x:event.clientX,y:event.clientY})
      }
      return
    }
    const dx=point.x-current.point.x,dy=point.y-current.point.y
    if(current.kind==='pan')navigate({...current.camera,x:current.camera.x-dx/current.camera.scale,y:current.camera.y-dy})
    if(current.kind==='move')setDrag({fragmentId:current.fragment.id,x:current.fragment.x+dx/current.camera.scale,y:current.fragment.y+dy/ROW_HEIGHT})
    if(current.kind==='reorder'){
      // Both thresholds are half a row or a few real pixels, whichever is larger:
      // zoomed out, half a row is less than the hand can hold still for.
      const plane=planeOf(state.camera)
      // A press on a jump marker that moves at all is a drag of that row. The
      // marker names a block to put it in, so there is nothing else the gesture
      // could mean: taking a sideways one for a pan, or waiting for half a row
      // of vertical travel, left the reader holding something that did nothing.
      const marker=current.jumpBlock!=null
      if(!marker&&current.fromConnector&&!current.dragging&&Math.abs(dx)>Math.abs(dy)&&Math.abs(dx)>4/plane){
        current.kind='pan';onCamera({...current.camera,x:current.camera.x-dx/current.camera.scale,y:current.camera.y-dy});return
      }
      const moved=marker?Math.hypot(dx,dy)>Math.max(3,4/plane):Math.abs(dy)>Math.max(ROW_HEIGHT/2,6/plane)
      if(moved||current.dragging){current.dragging=true
        setReorder({rowId:current.rowId,...reorderTarget(current,point),y:point.y})}
      return
    }
    if(current.kind==='select')setRectangle({x:Math.min(current.point.x,point.x),y:state.mode==='columns'?0:Math.min(current.point.y,point.y),width:Math.abs(dx),height:state.mode==='columns'?size.height:Math.abs(dy)})
  }
  function pointerUp(event){
    const current=interaction.current;if(!current)return
    const point=canvasPoint(event)
    // A press on the picked cells is the handle for dragging them into a layer,
    // and a press on any other cell is a click on that row. Both end as a click
    // when they go nowhere, but the drag handle gives up its slack sooner: a
    // click there puts the row out, picks and all, and losing a file's worth of
    // picks to a pixel of tremor while reaching for the sidebar is not a trade
    // worth making. Past this the gesture is a drag, and a drag that lands on
    // nothing changes nothing.
    const slop=current.kind==='transfer'?TRANSFER_SLOP:4
    if(['pan','transfer'].includes(current.kind)&&current.cell&&Math.hypot(event.clientX-current.clientX,event.clientY-current.clientY)<=slop)rowIsLit(state,current.cell)?onUnlight(current.cell):onHighlight(current.cell)
    if(current.kind==='transfer'){
      if(current.started)onSelectionDrop({x:event.clientX,y:event.clientY})
      onSelectionDrag(null)
    }
    if(current.kind==='reorder'){
      // A press that never travelled is still a click on the name; one that did
      // drops the row where it was let go.
      if(current.dragging)onReorderRow?.(current.rowId,reorderTarget(current,point),current.fragmentId)
      // Clicking a marker opens the block it names, on the sequence it belongs
      // to: the point of following a path is to see where that row continues.
      else if(current.jumpBlock!=null)onSourceBlock?.(current.jumpBlock,current.rowId)
      else if(current.fromLabel&&current.wasPicked)onUnlight(current.rowId)
      setReorder(null)
    }
    if(current.kind==='move'){
      const dx=point.x-current.point.x,dy=point.y-current.point.y
      if(Math.abs(dx)+Math.abs(dy)>2)onMove(current.fragment.id,current.fragment.x+dx/current.camera.scale,current.fragment.y+dy/ROW_HEIGHT)
      else if(current.fragment)onSelection(togglePicks(state.selection,[blockPick(current.fragment)]))
    }
    if(current.kind==='header'){
      const f=layer.fragments.find(x=>x.id===current.headerId)
      if(f&&Math.hypot(point.x-current.point.x,point.y-current.point.y)<4)onSelection(togglePicks(state.selection,[blockPick(f)]))
    }
    if(current.kind==='select'){
      const columnsOnly=state.mode==='columns'
      // Screen space, because the names are drawn there and nowhere else: they
      // have no column of their own to express this in.
      const box={x1:Math.min(current.point.x,point.x),x2:Math.max(current.point.x,point.x),
        y1:Math.min(current.point.y,point.y),y2:Math.max(current.point.y,point.y)}
      const names=namesInRect((hits.current||[]).filter(h=>h.kind==='label'),box,columnsOnly)
      const reached=rectEntersCells(layer.fragments.filter(f=>!f.aggregate).map(f=>panelRect(f,state.camera)),
        box,state.original?MARGIN_X:0)
      // Names alone pick those sequences, exactly as clicking each of them
      // would - so they toggle the same way and light the same gold. Carry the
      // drag on into the alignment and it is an ordinary region again.
      if(names.length&&!reached){
        // A name whose sequence is nowhere on the sheet has no cells to pick, so
        // it is lit instead. The reader dragged the box over that name and means
        // that sequence; which block happens to be open is not part of what they
        // said, and leaving those names out selected some of a rectangle.
        const picks=[],bare=[]
        for(const id of names){const own=rowPicks(layer,id);own.length?picks.push(...own):bare.push(id)}
        onSelection(togglePicks(state.selection,picks),bare)
      } else {
      const a=layoutPoint(current.point,current.camera),b=layoutPoint(point,current.camera)
      const drawn=selectRectangle(layer,{x1:Math.min(a.x,b.x),x2:Math.max(a.x,b.x)+.001,y1:Math.min(a.y,b.y),y2:Math.max(a.y,b.y)+.001},columnsOnly,current.camera)
      // Regions accumulate, so several can be picked out before moving them.
      onSelection(togglePicks(state.selection,drawn.map(r=>({...r,kind:'region'}))))
      }
    }
    interaction.current=null;setDrag(null);setRectangle(null);setReorder(null);setOverSelection(false)
  }
  function cancelGesture(){interaction.current=null;setDrag(null);setRectangle(null);setReorder(null);onSelectionDrag(null)}
  useEffect(()=>{const cancel=()=>{interaction.current=null;setDrag(null);setRectangle(null);latest.current.onSelectionDrag(null)};window.addEventListener('blur',cancel);return()=>window.removeEventListener('blur',cancel)},[])
  return <div className={`al-canvas ${state.mode==='pan'?'is-pan':'is-select'} ${state.selection.length?'has-selection':''} ${overSelection?'over-selection':''}`} ref={host} tabIndex={0} role="application" aria-label="Alignment panel. Use arrow keys to pan, plus and minus to zoom. Choose rectangle or columns to select. Drag highlighted cells to a sidebar layer or New layer. Drag chunk headers to arrange. Each header has a clipboard to copy FASTA; original source blocks also have a plus to create a layer."
    onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerLeave={()=>{setHover(null);setHoverPick(null)}} onPointerCancel={cancelGesture} onLostPointerCapture={()=>{if(interaction.current)cancelGesture()}}
    onKeyDown={e=>{if(interaction.current?.kind==='transfer'){if(e.key==='Escape'){e.preventDefault();cancelGesture()}return}if(e.key===' '){space.current=true;e.preventDefault()}if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();const plane=planeOf(state.camera);onCamera({...state.camera,x:state.camera.x+(e.key==='ArrowLeft'?-80:e.key==='ArrowRight'?80:0)/plane/state.camera.scale,y:state.camera.y+(e.key==='ArrowUp'?-80:e.key==='ArrowDown'?80:0)/plane})}if(['+','=','-'].includes(e.key)){e.preventDefault();const current=latest.current?.navigationCamera||navigationCamera||state.camera,factor=e.key==='-'?1/1.4:1.4,plane=planeOf(current);if(state.planeZoom){if(panelZoomBlocked(current,factor)){onZoomLimit?.(true);return}onZoomLimit?.(false);navigate(panelZoom(current,factor,{blockScale:blockFitScale(layer,current,size),size}))}else{onZoomLimit?.(false);const scale=clamp(current.scale*factor,Number.EPSILON,24);navigate({...current,scale,x:current.x+(size.width/plane/2-MARGIN_X)*(1/current.scale-1/scale)})}}if(e.key==='Escape'){e.preventDefault();if(state.blockContext){onBlockContext?.(null);return}onSelection([])}}} onKeyUp={e=>{if(e.key===' ')space.current=false}} onBlur={()=>{space.current=false}} />
})
export default LayerCanvas
