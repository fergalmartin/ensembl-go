import { API_BASE } from '../../backendRuntime'
import { rowSlot, clamp } from './layers.js'

export async function api(path, body, signal, method) {
  const response = await fetch(`${API_BASE}/api/alignment-explorer${path}`, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal,
  })
  if (!response.ok) {
    let detail
    try { detail = (await response.json()).detail } catch { detail = response.statusText }
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
  }
  return response.headers.get('content-type')?.includes('json') ? response.json() : response.text()
}
export function download(name, text, type='text/plain') {
  const url=URL.createObjectURL(new Blob([text],{type})),a=document.createElement('a')
  a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
}
import { MARGIN_X, MARGIN_Y, ROW_HEIGHT } from './layout.js'
export { MARGIN_X, MARGIN_Y, ROW_HEIGHT, HEADER_HEIGHT } from './layout.js'
export function visibleRequest(fragment,camera,size) {
  if(fragment.aggregate)return null
  const x=MARGIN_X+(fragment.x-camera.x)*camera.scale
  const y=MARGIN_Y+fragment.y*ROW_HEIGHT-camera.y
  const width=(fragment.end-fragment.start)*camera.scale
  if(x>size.width+300||x+width<-300)return null
  const ids=fragment.rowIds.filter((_,i)=>{
    const pos=y+rowSlot(fragment,i)*ROW_HEIGHT
    return pos>=-ROW_HEIGHT*2&&pos<size.height+ROW_HEIGHT*2
  })
  if(!ids.length)return null
  const step=Math.max(1,2**Math.ceil(Math.log2(4/Math.max(0.000001,camera.scale))))
  const quantum=Math.max(256,step*128)
  const visibleStart=fragment.start+Math.max(0,(0-x)/camera.scale)
  const visibleEnd=fragment.start+Math.max(0,(size.width-x)/camera.scale)
  // Padded on both sides. With padding only after the view, panning back the way
  // you came immediately exposes columns the request never asked for, and they
  // stay blank until a whole new tile lands.
  const start=Math.max(fragment.start,Math.floor(visibleStart/quantum)*quantum-quantum)
  const end=Math.min(fragment.end,Math.ceil(visibleEnd/quantum)*quantum+quantum)
  if(end<=start)return null
  return { block:fragment.sourceBlock,start,end,ids:[...new Set([fragment.rowIds[0],...ids])],bins:clamp(Math.ceil((end-start)/step),16,2048),focus:fragment.rowIds[0],summary:camera.scale<0.65 }
}
export const requestKey = request => JSON.stringify(request)
export function demoAlignment() {
  const source='ACGT'.repeat(300)
  return Array.from({length:16},(_,i)=>{
    const seq=[...source]
    for(let j=160;j<205;j++)if(i>=5&&i<=10)seq[j]='T'
    for(let j=360;j<378;j++)if(i<4)seq[j]='-'
    for(let j=710;j<734;j++)if(i>=8)seq[j]='G'
    for(let j=840;j<870;j++)if(i===15)seq[j]='N'
    return `>Sequence_${String(i+1).padStart(2,'0')}\n${seq.join('')}\n`
  }).join('')
}
