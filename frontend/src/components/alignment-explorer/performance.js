/** Opt-in, bounded diagnostics. No telemetry leaves this browser. */
const enabled=typeof window!=='undefined'&&new URLSearchParams(window.location.search).has('alignmentPerf')
const samples=[],latest={}
export function recordPerformance(kind,values={}) {
  if(!enabled)return
  samples.push({kind,time:performance.now(),...values});latest[kind]=values
  if(kind==='paint'||kind==='coverage')document.documentElement.dataset.alignmentPerformance=JSON.stringify(latest)
  if(samples.length>2000)samples.splice(0,500)
}
if(enabled)window.alignmentPerformance={samples,clear:()=>{samples.length=0}}
