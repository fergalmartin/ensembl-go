import { useEffect, useMemo, useRef, useState } from 'react'

const ROW_HEIGHT = 26
const OVERSCAN = 6

/** A sortable grid over the whole inventory.
 *
 * Only the rows on screen are mounted, so the full list is browsable whether it
 * holds two hundred blocks or fifty thousand sequences: a capped list would
 * quietly hide exactly the rows someone scrolled down to find. Row height is
 * fixed, which is what lets the scrollbar be honest about how much is there.
 */
export default function FilterGrid({rows,columns,rowKey,chosen,onChosen,label,empty}) {
  const viewport=useRef(null)
  const [scrollTop,setScrollTop]=useState(0)
  const [height,setHeight]=useState(320)
  const [sort,setSort]=useState({key:columns[0].key,direction:1})

  useEffect(()=>{
    const el=viewport.current
    if(!el||typeof ResizeObserver==='undefined')return
    const observer=new ResizeObserver(()=>setHeight(el.clientHeight))
    observer.observe(el);setHeight(el.clientHeight)
    return()=>observer.disconnect()
  },[])

  const sorted=useMemo(()=>{
    const column=columns.find(c=>c.key===sort.key)||columns[0]
    const value=row=>column.sortValue?column.sortValue(row):column.value(row)
    return [...rows].sort((a,b)=>{
      const x=value(a),y=value(b)
      if(typeof x==='number'&&typeof y==='number')return (x-y)*sort.direction
      return String(x).localeCompare(String(y),undefined,{numeric:true})*sort.direction
    })
  },[rows,columns,sort])

  const first=Math.max(0,Math.floor(scrollTop/ROW_HEIGHT)-OVERSCAN)
  const count=Math.ceil(height/ROW_HEIGHT)+OVERSCAN*2
  const slice=sorted.slice(first,first+count)
  const allTicked=chosen.size>0&&sorted.every(row=>chosen.has(rowKey(row)))

  const toggle=row=>{
    const key=rowKey(row)
    // An untouched grid means the filter is the choice, so the first tick starts
    // from everything shown rather than from nothing.
    const base=chosen.size?chosen:new Set(sorted.map(rowKey))
    const next=new Set(base)
    next.has(key)?next.delete(key):next.add(key)
    onChosen(next)
  }

  return <div className="al-grid" role="group" aria-label={label}>
    <div className="al-grid-head" style={{gridTemplateColumns:`26px ${columns.map(c=>c.width).join(' ')}`}}>
      <input type="checkbox" aria-label={allTicked?`Untick all ${label}`:`Tick all ${label}`} checked={allTicked}
        onChange={()=>onChosen(allTicked?new Set():new Set(sorted.map(rowKey)))}/>
      {columns.map(c=><button key={c.key} className={sort.key===c.key?'selected':''} title={`Sort by ${c.title}`}
        onClick={()=>setSort(s=>s.key===c.key?{key:c.key,direction:-s.direction}:{key:c.key,direction:1})}>
        {c.title}{sort.key===c.key?<i>{sort.direction>0?'▲':'▼'}</i>:null}
      </button>)}
    </div>
    <div className="al-grid-body" ref={viewport} onScroll={e=>setScrollTop(e.currentTarget.scrollTop)}>
      {!sorted.length&&<p className="al-hint">{empty}</p>}
      <div style={{height:sorted.length*ROW_HEIGHT,position:'relative'}}>
        {slice.map((row,i)=>{
          const key=rowKey(row),ticked=chosen.size?chosen.has(key):true
          return <label key={key} className={`al-grid-row ${ticked?'ticked':''}`}
            style={{position:'absolute',top:(first+i)*ROW_HEIGHT,height:ROW_HEIGHT,left:0,right:0,
              gridTemplateColumns:`26px ${columns.map(c=>c.width).join(' ')}`}}>
            <input type="checkbox" checked={ticked} onChange={()=>toggle(row)}/>
            {columns.map(c=><span key={c.key} className={c.numeric?'numeric':''} title={String(c.value(row))}>{c.render?c.render(row):c.value(row)}</span>)}
          </label>
        })}
      </div>
    </div>
  </div>
}
