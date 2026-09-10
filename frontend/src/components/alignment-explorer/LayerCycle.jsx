import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { clamp, fitCamera } from './layers'
import { paintLayer } from './paintLayer'
import useLayerData from './useLayerData'
import '../GenomeWheel.css'

const previewSize={width:1100,height:280}
function LayerPreview({layer,dataset,inventory,light,revision}) {
  const canvas=useRef(null),camera=fitCamera(layer,previewSize.width,previewSize.height)
  const [error,setError]=useState('')
  const data=useLayerData(dataset,layer,camera,previewSize,false,revision,setError)
  useEffect(()=>{if(canvas.current)paintLayer(canvas.current.getContext('2d'),{...data,layer,camera,size:previewSize,inventory,state:{selection:[],connectionUnit:'columns'},light})},[data,layer,camera,inventory,light])
  return <div className="genome-wheel-preview"><canvas ref={canvas} width={previewSize.width} height={previewSize.height} aria-label={`Alignment preview: ${layer.name}`}/>{error&&<span>{error}</span>}</div>
}

/** The same oblique rotating drum and press–drag–release interaction as genome Cycle. */
export default function LayerCycle({layers,active,onChoose,dataset,inventory,light,revision}) {
  const [session,setSession]=useState(null),sessionRef=useRef(null),gesture=useRef(null),button=useRef(null)
  const update=value=>{sessionRef.current=value;setSession(value)}
  const close=()=>update(null)
  const choose=()=>{const s=sessionRef.current;if(s){onChoose(layers[Math.round(s.position)].id);close()}}
  const move=y=>{const s=sessionRef.current;if(s)update({...s,position:clamp((y-s.top-16)/(s.height-32)*(layers.length-1),0,layers.length-1)})}
  useEffect(()=>{
    if(!session)return
    const key=e=>{
      if(e.key==='Escape'){e.preventDefault();update(null)}
      if(['ArrowUp','ArrowDown','Home','End'].includes(e.key)){e.preventDefault();const s=sessionRef.current;update({...s,position:e.key==='Home'?0:e.key==='End'?layers.length-1:clamp(Math.round(s.position)+(e.key==='ArrowUp'?-1:1),0,layers.length-1)})}
      if(e.key==='Enter'||e.key===' '){e.preventDefault();const s=sessionRef.current;onChoose(layers[Math.round(s.position)].id);update(null)}
    }
    window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key)
  },[!!session,layers,onChoose]) // eslint-disable-line react-hooks/exhaustive-deps
  const selected=session?Math.round(session.position):0,step=layers.length>1?360/layers.length:360,radius=layers.length>2?322/(2*Math.tan(Math.PI/layers.length)):0
  return <><button ref={button} aria-label="Cycle layers" aria-expanded={!!session} title="Press and drag to preview layers; release to choose. Click for keyboard or wheel navigation." onPointerDown={e=>{const rect=e.currentTarget.getBoundingClientRect();gesture.current={y:e.clientY,index:Math.max(0,layers.findIndex(l=>l.id===active)),moved:false};e.currentTarget.setPointerCapture(e.pointerId);update({position:Math.max(0,layers.findIndex(l=>l.id===active)),top:Math.min(rect.bottom+18,window.innerHeight-180),height:Math.max(120,Math.min(360,window.innerHeight-rect.bottom-90)),left:rect.left+rect.width/2-26})}} onPointerMove={e=>{if(gesture.current&&Math.abs(e.clientY-gesture.current.y)>5){gesture.current.moved=true;const s=sessionRef.current;update({...s,position:clamp(gesture.current.index+(e.clientY-gesture.current.y)/50,0,layers.length-1)})}}} onPointerUp={()=>{if(gesture.current?.moved)choose();gesture.current=null}} onPointerCancel={()=>{gesture.current=null;close()}} onClick={e=>{if(e.detail===0&&!session) {const rect=button.current.getBoundingClientRect();update({position:Math.max(0,layers.findIndex(l=>l.id===active)),top:rect.bottom+18,height:260,left:rect.left})}}}>◈ Cycle</button>
    {session&&createPortal(<div className={`genome-wheel-overlay al-wheel ${light?'light':''}`} onWheel={e=>{const s=sessionRef.current;update({...s,position:clamp(s.position+e.deltaY/160,0,layers.length-1)})}}>
      <div className="genome-wheel-scene"><div className="genome-wheel-drum" style={{'--face-height':'322px','--radius':`${radius}px`,'--face-step':`${step}deg`,'--wheel-position':session.position}}>{layers.map((layer,i)=><div key={layer.id} className={`genome-wheel-face ${i===selected?'selected':''}`} style={{'--face-index':i,'--accent':layer.color}} onClick={choose}><div className="genome-wheel-caption"><i style={{background:layer.color}}/>{layer.name}<small>{layer.fragments.length} {layer.id==='original'?'source blocks':'chunks'} · {new Set(layer.fragments.flatMap(f=>f.rowIds)).size} sequences</small></div>{Math.abs(i-selected)<=1&&<LayerPreview layer={layer} dataset={dataset} inventory={inventory} light={light} revision={revision}/>}</div>)}</div></div>
      <div className="genome-wheel-rail" role="slider" tabIndex={0} aria-label="Layer preview" aria-valuemin={1} aria-valuemax={layers.length} aria-valuenow={selected+1} aria-valuetext={layers[selected].name} style={{left:session.left,top:session.top,height:session.height}} onPointerDown={e=>{e.currentTarget.setPointerCapture(e.pointerId);move(e.clientY)}} onPointerMove={e=>{if(e.buttons)move(e.clientY)}} onPointerUp={choose}><div className="genome-wheel-line"/>{layers.map((l,i)=><i key={l.id} className="genome-wheel-dot" title={l.name} style={{top:16+i/Math.max(1,layers.length-1)*(session.height-32),background:l.color}}/>)}<i className="genome-wheel-indicator" style={{top:16+session.position/Math.max(1,layers.length-1)*(session.height-32)}}/></div>
      <button className="genome-cycle-cancel" style={{left:session.left+26,top:session.top+session.height+14,height:30}} onClick={close}>Cancel</button><div className="genome-wheel-status"><strong>{layers[selected].name}</strong><span>Drag the layer rail or scroll to rotate · Release to choose · Enter to choose · Esc to cancel</span><span>Previews show the first visible rows of each layer.</span></div>
    </div>,document.body)}
  </>
}
