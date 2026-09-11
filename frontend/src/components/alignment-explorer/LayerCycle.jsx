import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { clamp, fitCamera } from './layers'
import { cycleRailGeometry, cycleRailPosition, cyclePointerDragged } from '../../utils/genomeWheel'
import { paintLayer } from './paintLayer'
import useLayerData from './useLayerData'
import '../GenomeWheel.css'

const previewSize={width:1100,height:280}
function LayerPreview({layer,dataset,inventory,light,revision}) {
  const canvas=useRef(null),camera=fitCamera(layer,previewSize.width,previewSize.height)
  const [error,setError]=useState('')
  const data=useLayerData(dataset,layer,camera,previewSize,false,revision,setError,true)
  useEffect(()=>{if(canvas.current)paintLayer(canvas.current.getContext('2d'),{...data,layer,camera,size:previewSize,inventory,state:{selection:[],connectionUnit:'columns'},light})},[data,layer,camera,inventory,light])
  return <div className="genome-wheel-preview"><canvas ref={canvas} width={previewSize.width} height={previewSize.height} aria-label={`Alignment preview: ${layer.name}`}/>{error&&<span>{error}</span>}</div>
}

/** The same oblique rotating drum and press–drag–release interaction as genome Cycle. */
export default function LayerCycle({layers,active,onChoose,dataset,inventory,light,revision}) {
  const [session,setSession]=useState(null),sessionRef=useRef(null),button=useRef(null)
  const update=value=>{sessionRef.current=value;setSession(value)}
  const close=()=>update(null)
  const choose=()=>{const s=sessionRef.current;if(s){onChoose(layers[Math.round(s.position)].id);close()}}
  // Read the cursor against the same geometry the rail was drawn from, so the
  // indicator sits under the hand rather than a padding's distance from it.
  const move=(y)=>{const s=sessionRef.current;if(s)update({...s,position:cycleRailPosition(y,s.rail,layers.length)})}

  const open=e=>{
    const rail=cycleRailGeometry(layers.length,e.currentTarget.getBoundingClientRect(),window.innerHeight)
    e.currentTarget.setPointerCapture(e.pointerId)
    update({position:Math.max(0,layers.findIndex(l=>l.id===active)),rail,pointerId:e.pointerId,
      origin:{x:e.clientX,y:e.clientY},dragged:false,sticky:false})
  }
  useEffect(()=>{
    if(!session)return
    // A drag commits where it is released. A press that never travelled leaves
    // the wheel open instead, following the bare cursor until a click confirms:
    // the same two halves of one control the genome browser has.
    const moved=e=>{
      const s=sessionRef.current;if(!s)return
      if(!s.sticky&&e.pointerId!==s.pointerId)return
      if(!s.sticky&&!s.dragged&&cyclePointerDragged(s.origin,e.clientX,e.clientY))s.dragged=true
      move(e.clientY)
    }
    const up=e=>{
      const s=sessionRef.current;if(!s||s.sticky)return
      if(e.pointerId!==s.pointerId)return
      if(s.dragged)return choose()
      update({...s,sticky:true})
    }
    const click=e=>{
      const s=sessionRef.current;if(!s||!s.sticky)return
      e.preventDefault();e.stopPropagation()
      e.button===0?choose():close()
    }
    const key=e=>{
      const s=sessionRef.current;if(!s)return
      if(e.key==='Escape'){e.preventDefault();close()}
      if(['ArrowUp','ArrowDown','Home','End'].includes(e.key)){e.preventDefault()
        update({...s,position:e.key==='Home'?0:e.key==='End'?layers.length-1:clamp(Math.round(s.position)+(e.key==='ArrowUp'?-1:1),0,layers.length-1)})}
      if(e.key==='Enter'||e.key===' '){e.preventDefault();choose()}
    }
    window.addEventListener('pointermove',moved)
    window.addEventListener('pointerup',up)
    window.addEventListener('pointerdown',click,true)
    window.addEventListener('keydown',key)
    return()=>{window.removeEventListener('pointermove',moved);window.removeEventListener('pointerup',up)
      window.removeEventListener('pointerdown',click,true);window.removeEventListener('keydown',key)}
  },[!!session,layers,onChoose]) // eslint-disable-line react-hooks/exhaustive-deps

  const selected=session?Math.round(session.position):0
  const step=layers.length>1?360/layers.length:360,radius=layers.length>2?322/(2*Math.tan(Math.PI/layers.length)):0
  return <><button ref={button} aria-label="Cycle layers" aria-expanded={!!session}
    title="Drag to preview layers and release to choose, or click once to leave the wheel following the cursor."
    onPointerDown={open}>◈ Cycle</button>
    {session&&createPortal(<div className={`genome-wheel-overlay al-wheel ${light?'light':''} ${session.sticky?'sticky':''}`}
      onWheel={e=>{const s=sessionRef.current;update({...s,position:clamp(s.position+e.deltaY/160,0,layers.length-1)})}}>
      <div className="genome-wheel-scene"><div className="genome-wheel-drum" style={{'--face-height':'322px','--radius':`${radius}px`,'--face-step':`${step}deg`,'--wheel-position':session.position}}>
        {layers.map((l,i)=><div key={l.id} className="genome-wheel-face" style={{'--face-index':i}}>
          {Math.min(Math.abs(i-selected),layers.length-Math.abs(i-selected))<=1?<LayerPreview layer={l} dataset={dataset} inventory={inventory} light={light} revision={revision}/>:<div className="genome-wheel-preview">{l.name}</div>}</div>)}
      </div></div>
      <div className="genome-wheel-rail" role="slider" tabIndex={0} aria-label="Layer preview" aria-valuemin={1}
        aria-valuemax={layers.length} aria-valuenow={selected+1} aria-valuetext={layers[selected].name}
        style={{left:session.rail.center-26,top:session.rail.top,height:session.rail.height}}>
        <div className="genome-wheel-line"/>
        {layers.map((l,i)=><i key={l.id} className="genome-wheel-dot" style={{top:session.rail.padding+i*session.rail.spacing,background:l.color}} title={l.name}/>)}
        <span className="genome-wheel-indicator" style={{top:session.rail.padding+session.position*session.rail.spacing}}/>
      </div>
      <button className="genome-cycle-cancel" style={{left:session.rail.center,top:session.rail.cancelTop,height:session.rail.cancelHeight}}
        onPointerDown={e=>{e.stopPropagation();close()}}>Cancel</button>
      <div className="genome-wheel-status"><strong>{layers[selected].name}</strong>
        <span>{session.sticky?'Move to choose · click to confirm · Esc to cancel':'Release to choose'}</span></div>
    </div>,document.body)}
  </>
}
