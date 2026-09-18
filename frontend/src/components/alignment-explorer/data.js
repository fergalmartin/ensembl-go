import { API_BASE } from '../../backendRuntime'


export async function api(path, body, signal, method) {
  const response = await fetch(`${API_BASE}/api/alignment-explorer${path}`, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal,
  })
  if (!response.ok) {
    let detail
    try { detail = (await response.json()).detail } catch { detail = response.statusText }
    const error=new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
    error.status=response.status;error.retryable=response.status===429||response.status>=500
    throw error
  }
  return response.headers.get('content-type')?.includes('json') ? response.json() : response.text()
}
export function download(name, text, type='text/plain') {
  const url=URL.createObjectURL(new Blob([text],{type})),a=document.createElement('a')
  a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
}
export { MARGIN_X, MARGIN_Y, ROW_HEIGHT, HEADER_HEIGHT } from './layout.js'
export { visibleRequests, visibleRequest } from './regionRequests.js'
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
