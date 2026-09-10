import { MARGIN_X, MARGIN_Y, ROW_HEIGHT, HEADER_HEIGHT } from './data.js'
import { cellRanges, firstBlocks, rowSlot, rowCount, panelGeometry, routedPath, pathIsOccluded } from './layers.js'
import { renderResolution } from './renderResolution'
import { denseOriginal } from './originalLayout'
import { FEATURE_COLORS } from '../FeatureLegend'

import { NUCLEOTIDE_COLORS, NUCLEOTIDE_TEXT_COLOR, NUCLEOTIDE_LETTER_THRESHOLD, getBaseColor } from '../../utils/nucleotideStyle'
import { monoFont } from '../../utils/typography'
// The left edge is the exact affine position; the body is compressed into the
// rect minus a constant pixel gap, leaving a channel before the next block.
export const panelRect=(f,camera)=>({...panelGeometry(f,camera,MARGIN_X),y:MARGIN_Y+f.y*ROW_HEIGHT-camera.y,height:rowCount(f)*ROW_HEIGHT})
export function pointInPanel(px,py,f,camera){const r=panelRect(f,camera);return px>=r.x&&px<=r.x+r.width&&py>=r.y-HEADER_HEIGHT&&py<=r.y+r.height}
function rounded(ctx,x,y,w,h,r=5){ctx.beginPath();ctx.roundRect(x,y,Math.max(0,w),Math.max(0,h),r)}
function dashed(ctx,x,y,width,height,color) {
  ctx.save();ctx.beginPath();ctx.rect(x,y,width,height);ctx.clip();ctx.strokeStyle=color;ctx.lineWidth=1
  for(let a=x-height;a<x+width;a+=9){ctx.beginPath();ctx.moveTo(a,y+height);ctx.lineTo(a+height,y);ctx.stroke()}
  ctx.restore()
}
function niceStep(scale){const raw=80/scale,mag=10**Math.floor(Math.log10(raw));return [1,2,5,10].map(x=>x*mag).find(x=>x>=raw)||mag*10}
function rowChunks(fragment,rowId){return cellRanges(fragment,rowId)}

/** Paint an alignment layer to a viewport-sized texture: no chromosome-sized canvases. */
export function paintLayer(ctx,{layer,camera,size,inventory,tiles,annotations,connections,counts,state,drag,selectionRect,ghost=false,light=false}) {
  const colors=light?{background:'#f6f8fb',panel:'#fff',text:'#27394c',muted:'#738196',border:'#cbd5e1',head:'#edf2f8',void:'#eef2f7'}:{background:'#152032',panel:'#1c293d',text:'#e3eaf4',muted:'#8f9fb3',border:'#3a4d65',head:'#24354c',void:'#152032'}
  const baseColors=NUCLEOTIDE_COLORS[light?'light':'dark']
  ctx.clearRect(0,0,size.width,size.height)
  ctx.fillStyle=colors.background;ctx.fillRect(0,0,size.width,size.height)
  ctx.fillStyle=light?'#ced8e599':'#51617a33'
  for(let x=16;x<size.width;x+=28)for(let y=16;y<size.height;y+=28)ctx.fillRect(x,y,1,1)
  const drawLayer=drag?.fragmentId?{...layer,fragments:layer.fragments.map(f=>f.id===drag.fragmentId?{...f,x:drag.x,y:drag.y}:f)}:layer
  const dense=denseOriginal(drawLayer,camera,size),aligned=state.original&&((state.originalRows||'aligned')==='aligned'||drawLayer.fragments.some(f=>f.aggregate))
  const headerBoxes=[],labelBoxes=[],fragmentById=new Map(drawLayer.fragments.map(f=>[f.id,f]))
  const first=firstBlocks(drawLayer),byId=new Map(inventory.map(r=>[r.id,r])),hits=[]
  ctx.font='11px "IBM Plex Mono", monospace'
  // Strings are drawn first so the sequence panels cover their endpoints.
  // Panels paint over strings, so a string skipping blocks it is not in would be
  // buried. Those are routed below the stack instead; the lane sits under the
  // deepest drawn panel, kept on screen, with a few offsets so parallel routes
  // stay readable.
  const drawnRects=drawLayer.fragments.filter(f=>!f.aggregate).map(f=>({sourceBlock:f.sourceBlock,...panelRect(f,camera)}))
  const stackBottom=drawnRects.length?Math.max(...drawnRects.map(r=>r.y+r.height)):MARGIN_Y
  // The row stack usually runs past the bottom of the viewport, so the lane
  // settles into the clear band just inside the canvas rather than below a
  // stack bottom that is not on screen.
  const laneTop=Math.min(Math.max(stackBottom+16,MARGIN_Y+16),size.height-34)
  let routed=0
  const routedQueue=[]
  for(const connection of connections) {
    const originalA=fragmentById.get(connection.from.id),originalB=fragmentById.get(connection.to.id)
    if(!originalA||!originalB)continue
    const selected=state.highlighted===connection.rowId
    if(dense&&!selected)continue
    const a=panelRect(originalA,camera),b=panelRect(originalB,camera)
    const ax=a.x+(connection.fromEnd-originalA.start)*a.scale,bx=b.x+(connection.toStart-originalB.start)*b.scale
    const ay=a.y+(rowSlot(originalA,originalA.rowIds.indexOf(connection.rowId))+0.5)*ROW_HEIGHT
    const by=b.y+(rowSlot(originalB,originalB.rowIds.indexOf(connection.rowId))+0.5)*ROW_HEIGHT
    if(Math.max(ax,bx)<0||Math.min(ax,bx)>size.width||Math.min(ay,by)>size.height||Math.max(ay,by)<0)continue
    const reach=Math.max(28,Math.abs(bx-ax)*0.42)
    const backwards=bx<ax,arc=backwards?30:0
    const buried=pathIsOccluded(connection,drawnRects)
    ctx.strokeStyle=selected?'#f2c766':light?'#526f91':'#9eb9d9';ctx.lineWidth=selected?3:1.8;ctx.globalAlpha=state.highlighted&&!selected?0.3:0.95
    let points,mx,my
    if(buried){
      // A block stack taller than the viewport reaches past any lane, so a
      // routed string is stroked after the panels instead of under them. That is
      // the point of routing it: it has to stay readable where it bypasses them.
      const lane=Math.min(laneTop+(routed++%4)*6,size.height-10)
      points=routedPath(ax,ay,bx,by,lane)
      routedQueue.push({points,selected,rowId:connection.rowId})
      mx=(points[2].x+points[3].x)/2;my=lane
    } else {
      ctx.beginPath();ctx.moveTo(ax,ay);ctx.bezierCurveTo(ax+reach,ay-arc,bx-reach,by-arc,bx,by);ctx.stroke();ctx.globalAlpha=1
      points=Array.from({length:17},(_,i)=>{const t=i/16,u=1-t;return {x:u*u*u*ax+3*u*u*t*(ax+reach)+3*u*t*t*(bx-reach)+t*t*t*bx,y:u*u*u*ay+3*u*u*t*(ay-arc)+3*u*t*t*(by-arc)+t*t*t*by}})
      mx=(ax+bx)/2;my=(ay+by)/2-arc*.75
    }
    hits.push({kind:'connection',connection,points})
    const count=counts[connection.id],value=state.connectionUnit==='bases'?count?.bases:connection.columns
    const label=value==null?'?':value<0?`↔ ${Math.abs(value).toLocaleString()}`:value.toLocaleString()
    ctx.font=`${selected?'bold ':''}10px "IBM Plex Mono", monospace`
    const labelWidth=ctx.measureText(label).width+10
    if((buried?Math.abs(mx-ax)>18:Math.abs(bx-ax)>38||backwards)&&(!state.original||connection.columns!=null)){ctx.fillStyle=colors.background;rounded(ctx,mx-labelWidth/2,my-8,labelWidth,15,4);ctx.fill();ctx.fillStyle=selected?'#d9a638':colors.muted;ctx.textAlign='center';ctx.fillText(label,mx,my+3);ctx.textAlign='left';hits.push({kind:'connection',x:mx-labelWidth/2,y:my-10,width:labelWidth,height:20,connection})}
  }
  for(const f of drawLayer.fragments) {
    const r=panelRect(f,camera),w=Math.max(1,r.width)
    if(r.x>size.width||r.x+w<0||r.y-HEADER_HEIGHT>size.height||r.y+r.height<0)continue
    if(f.aggregate){
      const left=Math.max(MARGIN_X,r.x),right=Math.min(size.width,r.x+w),top=MARGIN_Y
      ctx.strokeStyle=colors.border;ctx.strokeRect(left+.5,top-HEADER_HEIGHT,right-left,Math.min(size.height-top,r.height)+HEADER_HEIGHT)
      ctx.font='10px Lato, sans-serif';ctx.fillStyle=colors.muted
      const heading=`${f.aggregate.first}–${f.aggregate.last}`,labelWidth=Math.max(65,ctx.measureText(heading).width+12)
      if(left>=MARGIN_X&&!headerBoxes.some(b=>left<b.right+8&&left+labelWidth>b.left-8)){ctx.fillText(heading,left+5,top-26);ctx.fillText(`${f.aggregate.count} blocks`,left+5,top-12);headerBoxes.push({left,right:left+labelWidth})}
      for(let i=0;i<f.rowIds.length;i++){
        const id=f.rowIds[i],y=MARGIN_Y+rowSlot(f,i)*ROW_HEIGHT-camera.y
        if(y+ROW_HEIGHT<0||y>size.height)continue
        const fraction=(f.aggregate.presence?.[id]||0)/f.aggregate.count
        ctx.fillStyle=state.highlighted===id?'#f2c766':light?'#598b9d':'#66a9b6';ctx.globalAlpha=state.highlighted&&state.highlighted!==id ? .35 : .4+.6*fraction
        ctx.fillRect(left,y+4,Math.max(1,(right-left)*fraction),ROW_HEIGHT-8);ctx.globalAlpha=1
      }
      hits.push({kind:'aggregate',fragmentId:f.id,x:left,y:top-HEADER_HEIGHT,width:right-left,height:HEADER_HEIGHT});continue
    }
    const tile=tiles[f.id],data=renderResolution(tile?.data,camera.scale),rowData=new Map((data?.rows||[]).map(row=>[row.id,row]))
    ctx.save();ctx.beginPath();ctx.rect(Math.max(0,r.x),Math.max(0,r.y-HEADER_HEIGHT),Math.min(size.width,w+1),Math.min(size.height,r.height+HEADER_HEIGHT));ctx.clip()
    ctx.fillStyle=colors.background;ctx.fillRect(r.x,r.y,w,r.height)
    if(aligned&&!f.compact){ctx.strokeStyle=colors.border;ctx.globalAlpha=.28;for(let y=Math.max(r.y,MARGIN_Y+Math.floor(camera.y/ROW_HEIGHT)*ROW_HEIGHT-camera.y);y<Math.min(size.height,r.y+r.height);y+=ROW_HEIGHT)ctx.strokeRect(r.x+.5,y+.5,w,ROW_HEIGHT);ctx.globalAlpha=1}
    ctx.fillStyle=colors.head;ctx.fillRect(r.x,r.y-HEADER_HEIGHT,w,HEADER_HEIGHT)
    ctx.strokeStyle=state.selection.some(s=>s.fragmentId===f.id)?layer.color:colors.border;ctx.lineWidth=1;ctx.strokeRect(r.x+.5,r.y-HEADER_HEIGHT+.5,w,r.height+HEADER_HEIGHT)
    const leftVisible=Math.max(0,-r.x),firstCol=f.start+leftVisible/r.scale,step=niceStep(camera.scale)
    ctx.font='10px "IBM Plex Mono", monospace';ctx.fillStyle=colors.muted
    if(!dense)for(let col=Math.ceil(firstCol/step)*step;col<f.end;col+=step){const x=r.x+(col-f.start)*r.scale;if(x>size.width)break;ctx.fillText((col+1).toLocaleString(),x+3,r.y-9);ctx.fillRect(x,r.y-5,1,5)}
    ctx.fillStyle=layer.color;ctx.fillRect(r.x,r.y-HEADER_HEIGHT,w,2)

    for(let index=0;index<f.rowIds.length;index++) {
      const id=f.rowIds[index],y=r.y+rowSlot(f,index)*ROW_HEIGHT
      if(y+ROW_HEIGHT<0||y>size.height)continue
      const row=rowData.get(id),ranges=rowChunks(f,id),selected=state.highlighted===id
      ctx.globalAlpha=state.highlighted&&!selected?0.36:1
      ctx.fillStyle=colors.void;ctx.fillRect(r.x,y,w,ROW_HEIGHT)
      const background=tile?.overview,overviewRow=background?.rows.find(row=>row.id===id)
      if(background&&background!==data&&overviewRow?.bins){
        overviewRow.bins.forEach((bin,i)=>{
          const a=background.start+i*background.bin_size,z=Math.min(background.end,a+background.bin_size)
          const total=Object.values(bin).reduce((n,v)=>n+v,0),canonical='ACGT'.split('').reduce((n,c)=>n+(bin[c]||0),0),div=overviewRow.divergence_bins?.[i]?.fraction
          for(const [ra,rz] of ranges){const start=Math.max(a,ra),end=Math.min(z,rz);if(end<=start)continue
            ctx.fillStyle=bin['-']===total?colors.background:div==null?(canonical?(light?'#7baeb5':'#448d99'):'#877b9f'):`hsl(${168-div*130} ${light?30:36}% ${light?65:49}%)`
            ctx.fillRect(r.x+(start-f.start)*r.scale,y+3,(end-start)*r.scale,ROW_HEIGHT-6)
          }
        })
      }
      for(const [rangeStart,rangeEnd] of ranges){
        const start=Math.max(rangeStart,data?.start??rangeStart,Math.floor(f.start-r.x/r.scale)),end=Math.min(rangeEnd,data?.end??rangeEnd,Math.ceil(f.start+(size.width-r.x)/r.scale))
        if(end<=start)continue
        const x=r.x+(start-f.start)*r.scale,width=(end-start)*r.scale
        if(!row||row.missing||row.sequence==null&&data?.detail){
          ctx.fillStyle=colors.void;ctx.fillRect(x,y+2,width,ROW_HEIGHT-4)
          if(width>24&&!dense)dashed(ctx,x,y+2,width,ROW_HEIGHT-4,row?.missing?colors.border:light?'#e0e6ed':'#243247')
          if(width>160){ctx.fillStyle=colors.muted;ctx.font='10px Lato, sans-serif';ctx.fillText(tile?.error?'Unavailable · Retry loading':!data||!row?'Loading…':row?.missing?'No alignment coverage':'Unavailable',x+8,y+17)}
          continue
        }
        if(data.detail){
          for(let col=start;col<end;col++){
            const base=row.sequence[col-data.start]
            const left=Math.round(r.x+(col-f.start)*r.scale),right=Math.round(r.x+(col+1-f.start)*r.scale)
            const width=Math.max(.5,right-left),top=y+1,height=24
            ctx.fillStyle=base==='-'?colors.background:getBaseColor(base,baseColors)
            ctx.fillRect(left,top,width,height)
            if(base==='-'&&width>=2){ctx.strokeStyle=colors.border;ctx.lineWidth=.7;ctx.strokeRect(left+.5,top+.5,Math.max(0,width-1),height-1)}
            if(camera.scale>=6&&width>=2){
              ctx.strokeStyle=light?'rgba(0,0,0,0.35)':'rgba(255,255,255,0.25)';ctx.lineWidth=1
              ctx.beginPath();ctx.moveTo(right-.5,top+.5);ctx.lineTo(right-.5,top+height-.5);ctx.stroke()
            }
            if(camera.scale>=NUCLEOTIDE_LETTER_THRESHOLD){
              ctx.fillStyle=base==='-'?colors.muted:NUCLEOTIDE_TEXT_COLOR;ctx.font=monoFont(12);ctx.textAlign='center';ctx.textBaseline='middle'
              ctx.fillText(base.toUpperCase(),left+width/2,top+height/2)
              ctx.textAlign='left';ctx.textBaseline='alphabetic'
            }
          }
        } else {
          row.bins?.forEach((bin,i)=>{
            const ba=data.start+i*data.bin_size,bz=Math.min(data.end,ba+data.bin_size),a=Math.max(start,ba),z=Math.min(end,bz)
            if(z<=a)return
            const total=Object.values(bin).reduce((a,b)=>a+b,0),canonical='ACGT'.split('').reduce((n,c)=>n+(bin[c]||0),0),div=row.divergence_bins?.[i]?.fraction
            ctx.fillStyle=bin['-']===total?colors.background:div==null?(canonical?(light?'#7baeb5':'#448d99'):'#877b9f'):`hsl(${168-div*130} ${light?30:36}% ${light?65:49}%)`
            ctx.fillRect(r.x+(a-f.start)*r.scale,y+3,(z-a)*r.scale,ROW_HEIGHT-6)
            if(bin['-']===total){ctx.strokeStyle=colors.border;ctx.lineWidth=.5;ctx.strokeRect(r.x+(a-f.start)*r.scale,y+3,(z-a)*r.scale,ROW_HEIGHT-6)}
            if((bin['-']||0)>0){ctx.fillStyle=colors.background;ctx.fillRect(r.x+(a-f.start)*r.scale,y+ROW_HEIGHT-6,(z-a)*r.scale*(bin['-']/Math.max(1,total)),3)}
            if(canonical===0&&!(bin['-']===total))dashed(ctx,r.x+(a-f.start)*r.scale,y+3,(z-a)*r.scale,ROW_HEIGHT-6,colors.border)
          })
        }
        if(state.annotations){
          const features=annotations[f.id]?.[id]||row.metadata?.features||[]
          for(const feature of features){
            const a=Math.max(start,feature.start),z=Math.min(end,feature.end+1)
            if(z<=a)continue
            const type=feature.type,color=FEATURE_COLORS[type]?.bg||'#60a5fa'
            ctx.fillStyle=color
            const h=type==='cds'?7:type==='exon'?4:3
            ctx.fillRect(r.x+(a-f.start)*r.scale,y+ROW_HEIGHT-h,(z-a)*r.scale,h)
            if(type==='cds'&&camera.scale>=4){ctx.fillStyle='#bfdbfe';for(let p=a;p<z;p+=6)ctx.fillRect(r.x+(p-f.start)*r.scale,y+ROW_HEIGHT-h,Math.min(3,z-p)*r.scale,h)}
          }
        }
      }
      ctx.globalAlpha=1
      if(selected){ctx.strokeStyle='#f2c766';ctx.lineWidth=1.5;ctx.strokeRect(r.x,y+1,w,ROW_HEIGHT-2)}
      ctx.strokeStyle=colors.border;ctx.globalAlpha=.18;ctx.beginPath();ctx.moveTo(r.x,y+ROW_HEIGHT);ctx.lineTo(r.x+w,y+ROW_HEIGHT);ctx.stroke();ctx.globalAlpha=1
    }
    // Optional provenance overlay on the immutable Original, never on by default.
    for(const placed of state.placedOverlay||[]){
      if(placed.sourceBlock!==f.sourceBlock)continue
      for(const id of placed.rowIds){const index=f.rowIds.indexOf(id);if(index<0)continue
        const y=r.y+rowSlot(f,index)*ROW_HEIGHT
        if(y+ROW_HEIGHT<0||y>size.height)continue
        for(const [a,z] of cellRanges(placed,id)){
          const x=r.x+(a-f.start)*r.scale,width=(z-a)*r.scale
          ctx.fillStyle=placed.color+'35';ctx.fillRect(x,y,width,ROW_HEIGHT)
          ctx.strokeStyle=placed.color;ctx.lineWidth=2;ctx.strokeRect(x,y+1,width,ROW_HEIGHT-2)
        }
      }
    }
    for(const selected of state.selection.filter(s=>s.fragmentId===f.id)){
      const x=r.x+(selected.start-f.start)*r.scale,width=(selected.end-selected.start)*r.scale
      for(const id of selected.rowIds){const i=f.rowIds.indexOf(id);if(i<0)continue;const y=r.y+rowSlot(f,i)*ROW_HEIGHT;ctx.fillStyle='#82d4bc40';ctx.fillRect(x,y,width,ROW_HEIGHT);ctx.strokeStyle='#87deca';ctx.lineWidth=1;ctx.strokeRect(x,y,width,ROW_HEIGHT)}
    }
    ctx.restore()
    hits.push({kind:'header',fragmentId:f.id,x:r.x,y:r.y-HEADER_HEIGHT,width:w,height:HEADER_HEIGHT})
    // Labels travel with the leftmost block. Only glyphs get a subtle halo;
    // there is no sticky opaque rectangle to erase bases or connecting strings.
    for(let index=0;index<f.rowIds.length;index++) {
      const id=f.rowIds[index],y=r.y+rowSlot(f,index)*ROW_HEIGHT
      if(state.original||dense||first.get(id)!==f.id||y+ROW_HEIGHT<0||y>size.height)continue
      let label=byId.get(id)?.label||byId.get(id)?.source||id
      ctx.font=`${state.highlighted===id?'bold ':''}11px Lato, sans-serif`
      if(ctx.measureText(label).width>140){while(label.length&&ctx.measureText(label+'…').width>140)label=label.slice(0,-1);label+='…'}
      const width=ctx.measureText(label).width,labelRight=r.x-10,labelX=labelRight-width
      if(labelRight<0||labelX>size.width)continue
      const box={x:labelX,y,width,height:ROW_HEIGHT}
      if(drawLayer.fragments.some(other=>{if(other.id===f.id)return false;const rect=panelRect(other,camera);return box.x<rect.x+rect.width&&box.x+box.width>rect.x&&box.y<rect.y+rect.height&&box.y+box.height>rect.y-HEADER_HEIGHT})||labelBoxes.some(b=>box.x<b.x+b.width&&box.x+box.width>b.x&&box.y<b.y+b.height&&box.y+box.height>b.y))continue
      labelBoxes.push(box)
      ctx.strokeStyle=colors.background;ctx.lineWidth=3;ctx.lineJoin='round';ctx.strokeText(label,labelX,y+17)
      ctx.fillStyle=state.highlighted===id?'#edc263':colors.text;ctx.fillText(label,labelX,y+17)
      hits.push({kind:'label',rowId:id,fragmentId:f.id,x:labelX-3,y,width:width+6,height:ROW_HEIGHT})
    }
    // Source block identity stays above the coordinate range, even on a tiny chunk.
    const headerLeft=Math.max(state.original?MARGIN_X:4,r.x),headerRight=Math.min(size.width-4,r.x+w)
    const interval=`${(f.start+1).toLocaleString()}–${f.end.toLocaleString()}`
    const headerBox={left:Math.max(MARGIN_X,headerLeft),right:Math.max(MARGIN_X,headerLeft)+Math.max(85,Math.min(150,headerRight-headerLeft))}
    const labelHeader=headerRight>MARGIN_X&&!headerBoxes.some(b=>headerBox.left<b.right+8&&headerBox.right>b.left-8)
    if(labelHeader)headerBoxes.push(headerBox)
    if(!labelHeader)continue
    ctx.fillStyle=colors.text;ctx.font=monoFont(10)
    const compact=ctx.measureText(interval).width+12>headerRight-headerLeft
    const textX=compact?(headerLeft+headerRight)/2:headerLeft+6
    ctx.textAlign=compact?'center':'left'
    ctx.fillText(`Block ${f.sourceBlock}${f.compact&&!dense?' · compact':''}`,textX,r.y-35)
    if(!dense)ctx.fillText(interval,textX,r.y-21)
    ctx.textAlign='left'
    // Small header actions have their own hit regions, separate from dragging.
    if(!dense&&r.x+w>MARGIN_X+140&&w>=140){
    const iconX=Math.min(size.width-23,r.x+w-23),iconY=r.y-HEADER_HEIGHT+6
    ctx.fillStyle=colors.head;rounded(ctx,iconX,iconY,20,22,3);ctx.fill()
    ctx.strokeStyle=colors.text;ctx.lineWidth=1.3;ctx.strokeRect(iconX+6,iconY+6,9,12);ctx.strokeRect(iconX+8,iconY+3,5,4)
    hits.push({kind:'copy',fragmentId:f.id,x:iconX,y:iconY,width:20,height:22})
    if(state.original){const plusX=iconX-23;ctx.fillStyle=colors.head;rounded(ctx,plusX,iconY,20,22,3);ctx.fill();ctx.strokeStyle=colors.text;ctx.beginPath();ctx.moveTo(plusX+5,iconY+11);ctx.lineTo(plusX+15,iconY+11);ctx.moveTo(plusX+10,iconY+6);ctx.lineTo(plusX+10,iconY+16);ctx.stroke();hits.push({kind:'layer',fragmentId:f.id,x:plusX,y:iconY,width:20,height:22})
      const rowX=plusX-23;ctx.fillStyle=colors.head;rounded(ctx,rowX,iconY,20,22,3);ctx.fill();ctx.strokeStyle=colors.text;ctx.beginPath();for(let i=0;i<3;i++){const y=iconY+6+i*(f.compact?3:5);ctx.moveTo(rowX+5,y);ctx.lineTo(rowX+15,y)}ctx.stroke();hits.push({kind:'rows',fragmentId:f.id,x:rowX,y:iconY,width:20,height:22})}
    }

  }
  if(state.original){
    ctx.fillStyle=colors.background;ctx.fillRect(0,0,MARGIN_X,size.height)
    ctx.strokeStyle=colors.border;ctx.beginPath();ctx.moveTo(MARGIN_X-.5,0);ctx.lineTo(MARGIN_X-.5,size.height);ctx.stroke()
    const focused=[...drawLayer.fragments].filter(f=>!f.aggregate&&panelRect(f,camera).y<size.height&&panelRect(f,camera).y+panelRect(f,camera).height>0).sort((a,b)=>Math.abs(a.x-camera.x)-Math.abs(b.x-camera.x))[0]
    const compactAnchor=focused?.compact?focused:null
    const gutter=compactAnchor?compactAnchor.rowIds.map((id,i)=>({row:byId.get(id),y:panelRect(compactAnchor,camera).y+rowSlot(compactAnchor,i)*ROW_HEIGHT})):inventory.map((row,i)=>({row,y:MARGIN_Y+i*ROW_HEIGHT-camera.y}))
    if(compactAnchor){ctx.fillStyle=colors.muted;ctx.font='10px Lato, sans-serif';ctx.fillText(`Rows: block ${compactAnchor.sourceBlock}`,8,14)}
    for(const {row,y} of gutter){
      if(!row||y+ROW_HEIGHT<0||y>size.height)continue
      let label=row.label||row.source||row.id;ctx.font='11px Lato, sans-serif';while(label.length&&ctx.measureText(label).width>MARGIN_X-18)label=label.slice(0,-2)+'…'
      ctx.fillStyle=state.highlighted===row.id?'#edc263':colors.text;ctx.textAlign='right';ctx.fillText(label,MARGIN_X-10,y+17);ctx.textAlign='left'
      hits.push({kind:'label',rowId:row.id,x:0,y,width:MARGIN_X,height:ROW_HEIGHT})
    }
  }
  if(dense){ctx.fillStyle=colors.muted;ctx.font='11px Lato, sans-serif';ctx.fillText(drawLayer.fragments.some(f=>f.aggregate)?'Block presence · filled width = fraction of blocks containing each sequence · click a header to zoom':'Source-block overview · zoom in for coordinates and chunk actions',MARGIN_X+8,13)}
  for(const route of routedQueue){
    ctx.strokeStyle=route.selected?'#f2c766':light?'#526f91':'#9eb9d9'
    ctx.lineWidth=route.selected?3:1.8
    ctx.globalAlpha=state.highlighted&&!route.selected?0.32:0.95
    ctx.beginPath();ctx.moveTo(route.points[0].x,route.points[0].y)
    for(let i=1;i<route.points.length-1;i++)ctx.arcTo(route.points[i].x,route.points[i].y,route.points[i+1].x,route.points[i+1].y,6)
    ctx.lineTo(route.points.at(-1).x,route.points.at(-1).y);ctx.stroke()
  }
  ctx.globalAlpha=1
  if(selectionRect){ctx.fillStyle='#78cfbb27';ctx.fillRect(selectionRect.x,selectionRect.y,selectionRect.width,selectionRect.height);ctx.strokeStyle='#8ee1ce';ctx.setLineDash([5,3]);ctx.strokeRect(selectionRect.x,selectionRect.y,selectionRect.width,selectionRect.height);ctx.setLineDash([])}
  if(!layer.fragments.length){ctx.fillStyle=colors.muted;ctx.font='14px Lato, sans-serif';ctx.textAlign='center';ctx.fillText('This layer is empty. Move a selection here from another layer.',size.width/2,size.height/2);ctx.textAlign='left'}
  if(ghost){ctx.fillStyle=colors.head;ctx.fillRect(0,0,size.width,34);ctx.fillStyle=layer.color;ctx.font='bold 13px Lato, sans-serif';ctx.fillText(layer.name,16,23)}

  return hits
}
