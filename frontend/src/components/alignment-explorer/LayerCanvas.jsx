import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { hitCanvasItem } from './originalLayout'
import { paintLayer, panelRect } from './paintLayer'
import { MARGIN_X, HEADER_HEIGHT, MARGIN_Y, ROW_HEIGHT } from './data'
import { clamp, hasCell, rowCount, rowSlot, selectedCellAt, selectionRect as selectRectangle, layerXToColumn, wheelScrollsRowList, togglePicks, blockPick, rowPicks, removeRowPicks } from './layers'
import { resolveBrowsingControls, readWheelEvent, beginWheelGesture, resolveWheelAction } from '../../utils/browsingControls'

/** A classical canvas becomes the texture of an actual 3D panel. The same hit
 * coordinates and renderer drive the complete non-WebGL fallback. */
const LayerCanvas = forwardRef(function LayerCanvas({ layer, layers, state, navigationCamera, inventory, tiles, annotations, connections, offWindow, counts, gaps, light, config, onCamera, onCopyChunk, onBlockToLayer, onAggregate, onToggleRows, onSelection, onSelectionDrag, onSelectionDrop, onMove, onHighlight, onInspect, onSize, onFallback, onSourceBlock, onReorderRow }, ref) {
  const host = useRef(null), engine = useRef(null), latest = useRef(null), interaction = useRef(null), hits = useRef([]), space = useRef(false)
  const [size, setSize] = useState({width:800,height:500}), [drag,setDrag] = useState(null), [rectangle,setRectangle] = useState(null), [reorder,setReorder] = useState(null), [overSelection,setOverSelection] = useState(false), [hover,setHover] = useState(null)
  useLayoutEffect(()=>{ latest.current = {layer,layers,state,navigationCamera,inventory,tiles,annotations,connections,counts,light,config,onCamera,onSelection,onSelectionDrag,onSelectionDrop,onMove,onHighlight,onInspect,onSize,onFallback,size,drag,rectangle} })
  function canvasPoint(event){
    const r=host.current.getBoundingClientRect(),x=event.clientX-r.left,y=event.clientY-r.top,e=engine.current
    if(e?.renderer&&!e.failed){e.raycaster.setFromCamera(new THREE.Vector2(x/r.width*2-1,1-y/r.height*2),e.camera);const hit=e.raycaster.intersectObject(e.mesh)[0];if(hit)return {x:hit.uv.x*r.width,y:(1-hit.uv.y)*r.height}}
    return {x,y}
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
      // Scrolling the name list scrolls the rows, carrying the alignment with it.
      // Left of the gutter edge the horizontal controls would otherwise take the
      // wheel and there would be no way to move down a long list of sequences.
      if(wheelScrollsRowList(canvasPoint(event).x,descriptor,MARGIN_X)){
        event.preventDefault();event.stopPropagation()
        p.onCamera({...camera,y:camera.y+descriptor.dy});return
      }
      const gesture=beginWheelGesture(e.gesture,descriptor,event.timeStamp)
      const intent=resolveWheelAction(descriptor,resolveBrowsingControls(p.config),{gesture,canScrollPage:true});e.gesture={...gesture,mode:intent.nextGestureMode}
      if(intent.type==='none')return
      event.preventDefault();event.stopPropagation()
      if(intent.type==='page_scroll'){p.onCamera({...camera,y:camera.y+descriptor.dy});return}
      if(intent.type==='pan'){p.onCamera({...camera,x:camera.x+intent.dxPx/camera.scale});return}
      if(intent.type==='zoom'){
        const point=canvasPoint(event),x=intent.anchor==='center'?p.size.width/2:point.x
        const scale=clamp(camera.scale/intent.factor,Number.EPSILON,24),anchor=camera.x+(x-MARGIN_X)/camera.scale
        p.onCamera({...camera,scale,x:anchor-(x-MARGIN_X)/scale})
      }
    }
    el.addEventListener('wheel',wheel,{passive:false})
    return()=>{observer.disconnect();el.removeEventListener('wheel',wheel);if(e.renderer){e.renderer.domElement.removeEventListener('webglcontextlost',e.lost);e.renderer.dispose();e.group.children.forEach(m=>{m.geometry.dispose();m.material.dispose()});e.texture.dispose()}el.replaceChildren();engine.current=null}
  },[])
  useEffect(()=>{
    const e=engine.current;if(!e)return
    const dpr=Math.min(window.devicePixelRatio||1,2),canvas=e.textureCanvas
    if(canvas.width!==size.width*dpr||canvas.height!==size.height*dpr){
      canvas.width=size.width*dpr;canvas.height=size.height*dpr
      if(e.texture){e.texture.dispose();e.texture=new THREE.CanvasTexture(canvas);e.texture.colorSpace=THREE.SRGBColorSpace;e.texture.minFilter=THREE.LinearFilter;e.texture.magFilter=THREE.NearestFilter;e.mesh.material.map=e.texture;e.mesh.material.needsUpdate=true}
    }
    const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0)
    hits.current=paintLayer(ctx,{layer,camera:state.camera,size,inventory,tiles,annotations,connections,offWindow,counts,state,drag,hover,gaps,reorder,selectionRect:rectangle,light})
    if(e.failed){e.fallback.width=canvas.width;e.fallback.height=canvas.height;e.fallback.getContext('2d').drawImage(canvas,0,0);return}
    e.renderer.setSize(size.width,size.height,false)
    e.camera.left=-size.width/2;e.camera.right=size.width/2;e.camera.top=size.height/2;e.camera.bottom=-size.height/2;e.camera.updateProjectionMatrix()
    e.mesh.scale.set(size.width,size.height,1);e.texture.needsUpdate=true
    e.group.rotation.set(state.tilted?-.28:0,state.tilted?.12:0,0);e.group.scale.setScalar(state.tilted?.82:1)
    // Backplates give named layers depth, while the active plane retains exact data.
    while(e.group.children.length>1){const m=e.group.children.at(-1);e.group.remove(m);m.geometry.dispose();m.material.dispose()}
    if(state.tilted)layers.filter(l=>l.id!==layer.id).slice(0,8).forEach((l,i)=>{
      const m=new THREE.Mesh(new THREE.PlaneGeometry(size.width,size.height),new THREE.MeshBasicMaterial({color:l.color,transparent:true,opacity:.16,side:THREE.DoubleSide,depthWrite:false}))
      m.position.set((i+1)*9,-(i+1)*14,-(i+1)*65);e.group.add(m)
    })
    e.camera.updateMatrixWorld(true);e.scene.updateMatrixWorld(true);e.renderer.render(e.scene,e.camera)
  },[layer,layers,state,inventory,tiles,annotations,connections,offWindow,counts,gaps,light,size,drag,hover,reorder,rectangle])
  const rowIndexAt=y=>Math.round((y-MARGIN_Y+state.camera.y)/ROW_HEIGHT)
  // In Original a row belongs to one shared order; in a layer it belongs to the
  // chunk its name sits beside, so the drop is measured against that chunk.
  function reorderTarget(current,y){
    if(state.original)return {target:clamp(rowIndexAt(y),0,Math.max(0,inventory.length-1)),index:clamp(rowIndexAt(y),0,Math.max(0,inventory.length-1))}
    const f=layer.fragments.find(x=>x.id===current.fragmentId)
    if(!f)return {target:0,index:0}
    const top=panelRect(f,state.camera).y
    const slot=clamp(Math.round((y-top)/ROW_HEIGHT),0,Math.max(0,rowCount(f)-1))
    return {target:slot,index:(top-MARGIN_Y+state.camera.y)/ROW_HEIGHT+slot}
  }
  function pointerHover(point){
    // A block or merged block under the cursor, with the layout position inside
    // it so a merged block can point at the individual block being pointed at.
    for(const f of layer.fragments){
      const r=panelRect(f,state.camera)
      if(point.x<r.x||point.x>r.x+r.width||point.y<r.y-HEADER_HEIGHT||point.y>r.y+r.height)continue
      const column=layerXToColumn(f,state.camera,state.camera.x+(point.x-MARGIN_X)/state.camera.scale)
      return {fragmentId:f.id,layoutX:f.x+column-f.start}
    }
    return null
  }
  function layoutPoint(p,camera){return {x:camera.x+(p.x-MARGIN_X)/camera.scale,y:(p.y-MARGIN_Y+camera.y)/ROW_HEIGHT}}
  function pointerDown(event){
    if(event.button!==0&&event.button!==1)return
    host.current.focus();const point=canvasPoint(event),p=latest.current
    const hit=[...hits.current].reverse().find(h=>hitCanvasItem(h,point))
    if(hit?.kind==='aggregate'){onAggregate?.(layer.fragments.find(f=>f.id===hit.fragmentId));return}
    if(hit?.kind==='rows'){onToggleRows?.(layer.fragments.find(f=>f.id===hit.fragmentId));return}
    if(hit?.kind==='copy'){onCopyChunk?.(layer.fragments.find(f=>f.id===hit.fragmentId));return}
    if(hit?.kind==='layer'){onBlockToLayer?.(layer.fragments.find(f=>f.id===hit.fragmentId));return}
    if(hit?.kind==='label'){
      // Highlight on the press, so the row is picked out before it is dragged
      // anywhere. A click that goes nowhere toggles it back off on release.
      const already=state.selection.some(pick=>pick.kind==='row'&&pick.rowIds.includes(hit.rowId))
      if(!already)onSelection(togglePicks(state.selection,rowPicks(layer,hit.rowId)))
      interaction.current={kind:'reorder',point,rowId:hit.rowId,fragmentId:hit.fragmentId,wasPicked:already,fromLabel:true,camera:{...p.state.camera}}
      event.currentTarget.setPointerCapture(event.pointerId);event.preventDefault();return
    }
    if(hit?.kind==='blockjump'){
      onHighlight(hit.rowId)
      interaction.current={kind:'reorder',point,rowId:hit.rowId,fragmentId:hit.fragmentId,
        jumpBlock:hit.block,fromConnector:true,camera:{...p.state.camera}}
      event.currentTarget.setPointerCapture(event.pointerId);event.preventDefault();return
    }
    if(hit?.kind==='connection')onInspect(hit)
    // Either end of a connector is a handle on the row in the block at that end.
    // A row whose name sits beside an earlier chunk has no other handle in the
    // chunk the path runs into, which is where it most needs one.
    if(hit?.kind==='connection'&&hit.points){
      const head=hit.points[0],tail=hit.points[hit.points.length-1]
      const intoTail=Math.hypot(point.x-tail.x,point.y-tail.y)<=Math.hypot(point.x-head.x,point.y-head.y)
      interaction.current={kind:'reorder',point,rowId:hit.connection.rowId,
        fragmentId:intoTail?hit.connection.to.id:hit.connection.from.id,
        fromConnector:true,camera:{...p.state.camera}}
      event.currentTarget.setPointerCapture(event.pointerId);event.preventDefault();return
    }
    const selected=state.mode==='pan'&&selectedCellAt(layer,state.selection,layoutPoint(point,state.camera),state.camera)
    const kind=space.current||event.button===1?'pan':selected?'transfer':hit?.kind==='header'?(state.original?'header':'move'):state.mode==='pan'?'pan':'select'
    const fragment=kind==='move'?layer.fragments.find(f=>f.id===hit.fragmentId):null
    const cell=hit?.connection?.rowId||layer.fragments.map(f=>{const r=panelRect(f,state.camera),index=f.rowIds.findIndex((_,i)=>point.y>=r.y+rowSlot(f,i)*ROW_HEIGHT&&point.y<r.y+(rowSlot(f,i)+1)*ROW_HEIGHT);return point.x>=r.x&&point.x<r.x+r.width&&index>=0?f.rowIds[index]:null}).find(Boolean)
    interaction.current={kind,point,cell,clientX:event.clientX,clientY:event.clientY,camera:{...p.state.camera},fragment,headerId:hit?.fragmentId};event.currentTarget.setPointerCapture(event.pointerId);event.preventDefault()
  }
  function pointerMove(event){
    const point=canvasPoint(event),current=interaction.current
    if(!current){
      setOverSelection(state.mode==='pan'&&selectedCellAt(layer,state.selection,layoutPoint(point,state.camera),state.camera))
      const next=pointerHover(point)
      setHover(prev=>prev?.fragmentId===next?.fragmentId&&prev?.layoutX===next?.layoutX?prev:next)
      const hit=[...hits.current].reverse().find(h=>hitCanvasItem(h,point))
      host.current.title=hit?.kind==='blockjump'?`Open source block ${hit.block}`:hit?.kind==='aggregate'?`Zoom into source blocks ${layer.fragments.find(f=>f.id===hit.fragmentId)?.aggregate.first}–${layer.fragments.find(f=>f.id===hit.fragmentId)?.aggregate.last}`:hit?.kind==='rows'?'Collapse or align absent rows for this block':hit?.kind==='copy'?'Copy chunk as aligned FASTA':hit?.kind==='layer'?'Create a layer from this source block':''
      if(hit?.kind==='connection'){onInspect(hit);return}
      for(const f of layer.fragments){const r=panelRect(f,state.camera),index=f.rowIds.findIndex((_,i)=>point.y>=r.y+rowSlot(f,i)*ROW_HEIGHT&&point.y<r.y+(rowSlot(f,i)+1)*ROW_HEIGHT)
        if(point.x>=r.x&&point.x<r.x+r.width&&index>=0){if(f.aggregate){onInspect({kind:'aggregate',rowId:f.rowIds[index],aggregate:f.aggregate});return}const column=f.start+Math.floor((point.x-r.x)/r.scale),row=tiles[f.id]?.data?.rows.find(r=>r.id===f.rowIds[index]);onInspect({kind:'cell',rowId:f.rowIds[index],fragment:f,column,base:hasCell(f,f.rowIds[index],column)?row?.sequence?.[column-(tiles[f.id]?.data?.start||0)]:'Unselected cell',placed:(state.placedOverlay||[]).filter(p=>p.sourceBlock===f.sourceBlock&&hasCell(p,f.rowIds[index],column)).map(p=>p.name),features:(annotations[f.id]?.[f.rowIds[index]]||[]).filter(a=>column>=a.start&&column<=a.end)});return}}
      return
    }
    if(current.kind==='transfer'){
      if(current.started||Math.hypot(event.clientX-current.clientX,event.clientY-current.clientY)>4){
        current.started=true;onSelectionDrag({x:event.clientX,y:event.clientY})
      }
      return
    }
    const dx=point.x-current.point.x,dy=point.y-current.point.y
    if(current.kind==='pan')onCamera({...current.camera,x:current.camera.x-dx/current.camera.scale,y:current.camera.y-dy})
    if(current.kind==='move')setDrag({fragmentId:current.fragment.id,x:current.fragment.x+dx/current.camera.scale,y:current.fragment.y+dy/ROW_HEIGHT})
    if(current.kind==='reorder'){
      if(current.fromConnector&&!current.dragging&&Math.abs(dx)>Math.abs(dy)&&Math.abs(dx)>4){
        current.kind='pan';onCamera({...current.camera,x:current.camera.x-dx/current.camera.scale,y:current.camera.y-dy});return
      }
      if(Math.abs(dy)>ROW_HEIGHT/2||current.dragging){current.dragging=true
        setReorder({rowId:current.rowId,...reorderTarget(current,point.y),y:point.y})}
      return
    }
    if(current.kind==='select')setRectangle({x:Math.min(current.point.x,point.x),y:state.mode==='columns'?0:Math.min(current.point.y,point.y),width:Math.abs(dx),height:state.mode==='columns'?size.height:Math.abs(dy)})
  }
  function pointerUp(event){
    const current=interaction.current;if(!current)return
    const point=canvasPoint(event)
    if(['pan','transfer'].includes(current.kind)&&current.cell&&Math.hypot(event.clientX-current.clientX,event.clientY-current.clientY)<4)onHighlight(state.highlighted===current.cell?'':current.cell)
    if(current.kind==='transfer'){
      if(current.started)onSelectionDrop({x:event.clientX,y:event.clientY})
      onSelectionDrag(null)
    }
    if(current.kind==='reorder'){
      // A press that never travelled is still a click on the name; one that did
      // drops the row where it was let go.
      if(current.dragging)onReorderRow?.(current.rowId,reorderTarget(current,point.y).target,current.fragmentId)
      else if(current.jumpBlock!=null)onSourceBlock?.(current.jumpBlock)
      else if(current.fromLabel&&current.wasPicked)onSelection(removeRowPicks(state.selection,current.rowId))
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
      const a=layoutPoint(current.point,current.camera),b=layoutPoint(point,current.camera)
      const drawn=selectRectangle(layer,{x1:Math.min(a.x,b.x),x2:Math.max(a.x,b.x)+.001,y1:Math.min(a.y,b.y),y2:Math.max(a.y,b.y)+.001},state.mode==='columns',current.camera)
      // Regions accumulate, so several can be picked out before moving them.
      onSelection(togglePicks(state.selection,drawn.map(r=>({...r,kind:'region'}))))
    }
    interaction.current=null;setDrag(null);setRectangle(null);setReorder(null);setOverSelection(false)
  }
  function cancelGesture(){interaction.current=null;setDrag(null);setRectangle(null);setReorder(null);onSelectionDrag(null)}
  useEffect(()=>{const cancel=()=>{interaction.current=null;setDrag(null);setRectangle(null);latest.current.onSelectionDrag(null)};window.addEventListener('blur',cancel);return()=>window.removeEventListener('blur',cancel)},[])
  return <div className={`al-canvas ${state.mode==='pan'?'is-pan':'is-select'} ${state.selection.length?'has-selection':''} ${overSelection?'over-selection':''}`} ref={host} tabIndex={0} role="application" aria-label="Alignment panel. Use arrow keys to pan, plus and minus to zoom. Choose rectangle or columns to select. Drag highlighted cells to a sidebar layer or New layer. Drag chunk headers to arrange. Each header has a clipboard to copy FASTA; original source blocks also have a plus to create a layer."
    onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerLeave={()=>setHover(null)} onPointerCancel={cancelGesture} onLostPointerCapture={()=>{if(interaction.current)cancelGesture()}}
    onKeyDown={e=>{if(interaction.current?.kind==='transfer'){if(e.key==='Escape'){e.preventDefault();cancelGesture()}return}if(e.key===' '){space.current=true;e.preventDefault()}if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();onCamera({...state.camera,x:state.camera.x+(e.key==='ArrowLeft'?-80:e.key==='ArrowRight'?80:0)/state.camera.scale,y:state.camera.y+(e.key==='ArrowUp'?-80:e.key==='ArrowDown'?80:0)})}if(['+','=','-'].includes(e.key)){e.preventDefault();const current=navigationCamera||state.camera,scale=clamp(current.scale*(e.key==='-'?1/1.4:1.4),Number.EPSILON,24);onCamera({...current,scale,x:current.x+(size.width/2-MARGIN_X)*(1/current.scale-1/scale)})}if(e.key==='Escape')onSelection([])}} onKeyUp={e=>{if(e.key===' ')space.current=false}} onBlur={()=>{space.current=false}} />
})
export default LayerCanvas
