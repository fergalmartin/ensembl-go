import { MARGIN_X, MARGIN_Y, ROW_HEIGHT, HEADER_HEIGHT } from './data.js'
import { cellRanges, firstBlocks, rowSlot, panelRect, pinnedBottom, blockJumpMarkers, linkIsBuried, litRows, sourceViewAnchor, BLOCK_EDGE_GAP, blockAtLayoutX, planeOf, pickSlots } from './layers.js'
import { rowCoverage } from './tileCoverage'
import { visibleGaps } from './gapMemory'
import { columnPieces, collapseJoins, collapsedColumns, displayColumn, sourceColumn } from './collapse.js'
import { denseOriginal } from './originalLayout'
import { blockHeaderPlan, rulerTicks } from './headerPlan.js'
import { FEATURE_COLORS } from '../FeatureLegend'

import { NUCLEOTIDE_LETTER_THRESHOLD } from '../../utils/nucleotideStyle'
import { basePalette, presenceColour } from './palettes.js'
import { recordPerformance } from './performance.js'
import { schemeById } from './colourSchemes.js'
import { paintConservationSpan } from './paintConservation.js'
import { paintUniformSpan } from './paintUniform.js'
import { binRuns } from './paintBins.js'
import { paintMotifSpan } from './paintMotifs.js'
import { paintBases } from './paintBases.js'
import { monoFont } from '../../utils/typography'
export { panelRect, pointInPanel } from './layers.js'
function rounded(ctx,x,y,w,h,r=5){ctx.beginPath();ctx.roundRect(x,y,Math.max(0,w),Math.max(0,h),r)}
function dashed(ctx,x,y,width,height,color) {
  ctx.save();ctx.beginPath();ctx.rect(x,y,width,height);ctx.clip();ctx.strokeStyle=color;ctx.lineWidth=1
  for(let a=x-height;a<x+width;a+=9){ctx.beginPath();ctx.moveTo(a,y+height);ctx.lineTo(a+height,y);ctx.stroke()}
  ctx.restore()
}
// A gap narrower than this is noise along the bottom of every block rather than
// a feature; it waits until the camera makes it one. Only ever adds gaps on
// zooming in, never removes them.
const MIN_VISIBLE_GAP=2
// Two marks nearer than this are one mark as far as the eye is concerned, and
// drawing both only thickens it.
const MIN_JOIN_GAP=5
// Breathing room at both ends of a header, so a name never touches the edge it
// is measured against.
const HEADER_PAD=6
// One colour for everything picked out, so a picked block's outline and the name
// of a picked sequence read as the same act rather than two unrelated marks.
const PICKED='#edc263'
// The edge of anything picked, and the wash inside it. A region drawn with
// Select is the same act as clicking a name or a header - it was told apart in
// teal, which read as a different kind of mark altogether. The wash is what
// still separates a picked stretch from a merely lit row, since both now carry
// the same gold edge.
const PICKED_EDGE='#f2c766',WASH_ALPHA='33',MARQUEE_WASH='#edc26322',EDGE_SHADOW='#152032'
function niceStep(scale){const raw=80/scale,mag=10**Math.floor(Math.log10(raw));return [1,2,5,10].map(x=>x*mag).find(x=>x>=raw)||mag*10}
function rowChunks(fragment,rowId){return cellRanges(fragment,rowId)}

/** Paint an alignment layer to a viewport-sized texture: no chromosome-sized canvases. */
/** The sheet's palette, in one place.
 *
 * Both painters take it from here. When the overlay built its own it was short
 * of `text`, and every name it drew kept whatever fill happened to be current -
 * which is a class of bug that only an unshared palette can have. */
export function explorerColors(light) {
  const colors=light?{background:'#f6f8fb',panel:'#fff',text:'#27394c',muted:'#738196',border:'#cbd5e1',head:'#edf2f8',void:'#eef2f7'}:{background:'#152032',panel:'#1c293d',text:'#e3eaf4',muted:'#8f9fb3',border:'#3a4d65',head:'#24354c',void:'#152032'}
  // A gap is sequence that is not there to say anything, which is the same
  // statement the Feature Explorer outlines unannotated genomic sequence to
  // make. Same colour, from its own table, so the two views stay one
  // vocabulary and cannot drift apart.
  colors.gap=FEATURE_COLORS.genomic?.bg||'#60a5fa'
  return colors
}
export function paintLayer(ctx,{layer,camera,size,inventory,rowsById=null,tiles,annotations,connections,offWindow=[],counts,state,drag,hover,gaps,reorder,selectionRect,conservation=null,hoverPick=null,ghost=false,light=false,focusOf=null}) {
  const colors=explorerColors(light)
  const linkedPill=(row,x,y,width)=>{
    if(row?.linkStatus!=='topbar'&&row?.linkStatus!=='local')return
    ctx.save();ctx.fillStyle=light?'#dbeafe':'#17365f';ctx.strokeStyle=colors.gap;ctx.lineWidth=1
    if(row.linkStatus==='local')ctx.setLineDash([3,2])
    rounded(ctx,x-4,y+3,width+8,ROW_HEIGHT-6,5);ctx.fill();ctx.stroke();ctx.restore()
  }
  // The palette is chosen here and nowhere else: the inner loops still read one
  // table by key, whichever set of colours it holds.
  const baseColors=basePalette(state.palette?.bases,light)
  // Chosen once per paint. A scheme without a ramp is the original one, and the
  // loops below never learn that any other exists.
  const scheme=schemeById(state.colourScheme),ramp=scheme.ramp?scheme.ramp(light,state.palette?.[scheme.id]):null
  const motifMode=scheme.id==='motif',neutral=light?'#cbd5e1':'#566477'
  const motifTextColors=new Map()
  // Uniform shading is not a scheme of its own: it is what `bases` does where a
  // column is too narrow to be a base. Close up the sequence is still drawn,
  // which is the whole point of it being one mode rather than two.
  const presence=presenceColour(light)
  const uniform=scheme.shading&&state.shading==='uniform'?presence:null
  const cohortSize=conservation?.cohort||0,paintCount={fills:0}
  ctx.clearRect(0,0,size.width,size.height)
  ctx.fillStyle=colors.background;ctx.fillRect(0,0,size.width,size.height)
  // Everything here is drawn in plane units and the canvas carries the plane
  // factor, so the alignment shrinks as one sheet. Marks that are interface
  // rather than alignment - the dotted ground, glyphs, tick spacing, hairlines -
  // divide by that factor to hold their size on screen. `size` is already the
  // enlarged viewport, so the loops below stay the same length at any zoom.
  const plane=planeOf(camera),onScreen=camera.scale*plane
  const hair=w=>Math.max(w,1/plane),grid=28/plane,gridFrom=16/plane
  // The gold edge of a pick, armed against the ground the way a picked label is.
  // Over the background - a row outline, a header - gold reads on its own, but a
  // region is drawn over the bases, and half that palette is warm enough to
  // swallow it. The dark line underneath is what carries it across them.
  const armedEdge=(colour,x,y,w,h,dash)=>{
    // The dark line is not the panel ground but a constant: it is there to be
    // read against the bases, which are the same saturated colours in either
    // theme, and in light mode a pale backing left the gold with nothing behind
    // it. The backing stays solid under a dashed edge too - dashes that broke
    // with it put the gold back on bare bases in every gap.
    ctx.globalAlpha=.5;ctx.strokeStyle=EDGE_SHADOW;ctx.lineWidth=hair(3);ctx.strokeRect(x,y,w,h)
    ctx.globalAlpha=1;ctx.strokeStyle=colour;ctx.lineWidth=hair(1.5)
    if(dash)ctx.setLineDash(dash)
    ctx.strokeRect(x,y,w,h);ctx.setLineDash([]);ctx.lineWidth=1
  }
  const pickEdge=(x,y,w,h,dash)=>armedEdge(PICKED_EDGE,x,y,w,h,dash)
  // A glyph under about four pixels is texture, not a word.
  const legible=11*plane>=4,flatRows=ROW_HEIGHT*plane<3,rowPad=ROW_HEIGHT*plane<6?0:4
  ctx.fillStyle=light?'#ced8e599':'#51617a33'
  for(let x=gridFrom;x<size.width;x+=grid)for(let y=gridFrom;y<size.height;y+=grid)ctx.fillRect(x,y,1/plane,1/plane)
  // Several sequences can be picked at once now, so emphasis is a set: picking a
  // name lights its whole path, and clicking a cell or a string lights that row
  // without disturbing what is picked. Both add up, because on screen they look
  // the same and a reader lighting a third row does not expect the second to go
  // out.
  const lit=litRows(state)
  const anyLit=lit.size>0
  const drawLayer=drag?.fragmentId?{...layer,fragments:layer.fragments.map(f=>f.id===drag.fragmentId?{...f,x:drag.x,y:drag.y}:f)}:layer
  const dense=denseOriginal(drawLayer,camera,size,plane),aligned=state.original&&((state.originalRows||'aligned')==='aligned'||drawLayer.fragments.some(f=>f.aggregate))
  const headerBoxes=[],labelBoxes=[],fragmentById=new Map(drawLayer.fragments.map(f=>[f.id,f]))
  // Every row the sheet might draw, not only the ones Original is listing. A
  // layer holds what the reader put in it, and Original's filter has no say
  // over that - looked up in the listed rows alone, a layer's own sequences
  // came out as bare identifiers the moment a filter excluded them.
  const first=firstBlocks(drawLayer),byId=rowsById||new Map(inventory.map(r=>[r.id,r])),hits=[]
  ctx.font='11px "IBM Plex Mono", monospace'
  // Strings are drawn first so the sequence panels cover their endpoints.
  // Panels paint over strings, so a link skipping blocks it is not in would be
  // buried under them. Those are carried by edge markers drawn after the panels.
  const drawnRects=drawLayer.fragments.filter(f=>!f.aggregate).map(f=>({sourceBlock:f.sourceBlock,...panelRect(f,camera)}))
  const buried={original:!!state.original,packed:!!drawLayer.packed}
  for(const connection of connections) {
    const originalA=fragmentById.get(connection.from.id),originalB=fragmentById.get(connection.to.id)
    if(!originalA||!originalB)continue
    const selected=lit.has(connection.rowId)
    if(dense&&!selected)continue
    const a=panelRect(originalA,camera),b=panelRect(originalB,camera)
    // Through the collapse map, the same as the cells the ends sit against. A
    // link is anchored to a column, and a column's place on a collapsed panel is
    // not its distance from the block's start: placed that way the ends ran off
    // the panel they belong to, so the curves wrapped, leaned and were then
    // discarded as buried by blocks they were nowhere near.
    const ax=a.x+displayColumn(originalA,connection.fromEnd)*a.scale
    const bx=b.x+displayColumn(originalB,connection.toStart)*b.scale
    const ay=a.y+(rowSlot(originalA,originalA.rowIds.indexOf(connection.rowId))+0.5)*ROW_HEIGHT
    const by=b.y+(rowSlot(originalB,originalB.rowIds.indexOf(connection.rowId))+0.5)*ROW_HEIGHT
    if(Math.max(ax,bx)<0||Math.min(ax,bx)>size.width||Math.min(ay,by)>size.height||Math.max(ay,by)<0)continue
    const reach=Math.max(28,Math.abs(bx-ax)*0.42)
    const backwards=bx<ax,arc=backwards?30:0
    // A link that skips blocks is carried by a marker on each block edge rather
    // than a line routed around everything in between.
    if(linkIsBuried(connection,drawnRects,buried))continue
    ctx.strokeStyle=selected?PICKED_EDGE:light?'#526f91':'#9eb9d9';ctx.lineWidth=hair(selected?3:1.8);ctx.globalAlpha=anyLit&&!selected?0.3:0.95
    ctx.beginPath();ctx.moveTo(ax,ay);ctx.bezierCurveTo(ax+reach,ay-arc,bx-reach,by-arc,bx,by);ctx.stroke()
    const points=Array.from({length:17},(_,i)=>{const t=i/16,u=1-t;return {x:u*u*u*ax+3*u*u*t*(ax+reach)+3*u*t*t*(bx-reach)+t*t*t*bx,y:u*u*u*ay+3*u*u*t*(ay-arc)+3*u*t*t*(by-arc)+t*t*t*by}})
    const mx=(ax+bx)/2,my=(ay+by)/2-arc*.75
    // Restore before anything else paints: a leak here tints every later fill,
    // including the opaque name gutter, by whatever is beneath it.
    ctx.globalAlpha=1
    hits.push({kind:'connection',connection,points})
    const count=counts[connection.id],value=state.connectionUnit==='bases'?count?.bases:connection.columns
    const label=value==null?'?':value<0?`↔ ${Math.abs(value).toLocaleString()}`:value.toLocaleString()
    ctx.font=`${selected?'bold ':''}10px "IBM Plex Mono", monospace`
    const labelWidth=ctx.measureText(label).width+10
    if(legible&&(Math.abs(bx-ax)>38||backwards)&&(!state.original||connection.columns!=null)){ctx.fillStyle=colors.background;rounded(ctx,mx-labelWidth/2,my-8,labelWidth,15,4);ctx.fill();ctx.fillStyle=selected?'#d9a638':colors.muted;ctx.textAlign='center';ctx.fillText(label,mx,my+3);ctx.textAlign='left';hits.push({kind:'connection',x:mx-labelWidth/2,y:my-10,width:labelWidth,height:20,connection})}
  }
  for(const f of drawLayer.fragments) {
    const r=panelRect(f,camera),w=Math.max(1,r.width)
    if(r.x>size.width||r.x+w<0||r.y-HEADER_HEIGHT>size.height||r.y+r.height<0)continue
    if(f.aggregate){
      const left=Math.max(MARGIN_X,r.x),right=Math.min(size.width,r.x+w),top=MARGIN_Y
      const bottom=Math.min(size.height,r.y+r.height)
      // The header is its own band: filled, and ruled off from the bars below it.
      // Drawn as one undivided box, the group's name and its contents read as a
      // single object, and a highlight inside it had nothing to stop against.
      ctx.fillStyle=colors.head;ctx.fillRect(left,top-HEADER_HEIGHT,right-left,HEADER_HEIGHT)
      ctx.strokeStyle=colors.border;ctx.lineWidth=hair(1)
      ctx.strokeRect(left+.5,top-HEADER_HEIGHT+.5,right-left-1,bottom-top+HEADER_HEIGHT-1)
      ctx.beginPath();ctx.moveTo(left,top+.5);ctx.lineTo(right,top+.5);ctx.stroke()
      ctx.lineWidth=1
      // The individual block under the cursor: named in the header, outlined
      // below it, and the one a click on the header opens.
      const inner=hover?.fragmentId===f.id?blockAtLayoutX(f,hover.layoutX):null
      ctx.font='10px Lato, sans-serif';ctx.fillStyle=colors.muted
      const single=f.aggregate.first===f.aggregate.last
      const heading=single?`Block ${f.aggregate.first}`:`${f.aggregate.first}–${f.aggregate.last}`
      const labelWidth=Math.max(65,ctx.measureText(heading).width+12)
      if(legible&&left>=MARGIN_X&&!headerBoxes.some(b=>left<b.right+8&&left+labelWidth>b.left-8)){
        ctx.fillText(heading,left+5,top-26)
        // While a block is picked out below, the second line names that block
        // rather than counting the group, because that is what a click here
        // opens. A merged header is rarely wide enough for both.
        if(inner){
          const room=right-11-left,columns=(inner.end_x-inner.x).toLocaleString()
          const note=[`Block ${inner.block} \u00b7 ${columns} columns \u203a`,`Block ${inner.block} \u203a`,`${inner.block} \u203a`]
            .find(text=>ctx.measureText(text).width<=room)
          ctx.fillStyle=colors.text;ctx.fillText(note||String(inner.block),left+5,top-12);ctx.fillStyle=colors.muted
        } else ctx.fillText(single?'1 block':`${f.aggregate.count} blocks`,left+5,top-12)
        headerBoxes.push({left,right:left+labelWidth})
      }
      for(let i=0;i<f.rowIds.length;i++){
        const id=f.rowIds[i],y=MARGIN_Y+rowSlot(f,i)*ROW_HEIGHT-camera.y
        if(y+ROW_HEIGHT<0||y>size.height)continue
        const fraction=(f.aggregate.presence?.[id]||0)/f.aggregate.count
        ctx.fillStyle=lit.has(id)?PICKED_EDGE:light?'#598b9d':'#66a9b6';ctx.globalAlpha=anyLit&&!lit.has(id) ? .35 : .4+.6*fraction
        // Thin rows lose their padding and their minimum width in real pixels, so
        // a sheet of them reads as one texture rather than dissolving into it.
        ctx.fillRect(left,y+rowPad,Math.max(1/plane,(right-left)*fraction),ROW_HEIGHT-2*rowPad);ctx.globalAlpha=1
      }
      if(hover?.fragmentId===f.id){
        ctx.strokeStyle=colors.text;ctx.globalAlpha=.5
        ctx.strokeRect(left+.5,top-HEADER_HEIGHT+.5,right-left-1,bottom-top+HEADER_HEIGHT-1);ctx.globalAlpha=1
        // Within a merged group, point at the individual block under the cursor
        // rather than leaving the whole group as the only unit on offer.
        if(inner){
          const ix=r.x+(inner.x-f.x)*r.scale,iw=Math.max(2,(inner.end_x-inner.x)*r.scale)
          const a=Math.max(left,ix),z=Math.min(right,ix+iw)
          // Only the block, and only below the rule. Carrying the highlight up
          // through the header made the two look like one object and left it
          // unclear what clicking would open.
          ctx.fillStyle=light?'#26374d18':'#cfe0f818';ctx.fillRect(a,top+1,z-a,bottom-top-1)
          ctx.strokeStyle=PICKED_EDGE;ctx.lineWidth=hair(1.5)
          ctx.strokeRect(a+.5,top+1.5,z-a-1,bottom-top-2)
          ctx.lineWidth=1
        }
      }
      hits.push({kind:'aggregate',fragmentId:f.id,x:left,y:top-HEADER_HEIGHT,width:right-left,height:HEADER_HEIGHT});continue
    }
    const tile=tiles[f.id],sources=tile?.sources||[tile?.data].filter(Boolean)
    ctx.save();ctx.beginPath();const clipTop=Math.max(0,r.y-HEADER_HEIGHT,f.pinned?0:pinnedBottom(layer,camera));ctx.rect(Math.max(0,r.x),clipTop,Math.min(size.width,w+1),Math.max(0,Math.min(size.height,r.y+r.height)-clipTop));ctx.clip()
    ctx.fillStyle=colors.background;ctx.fillRect(r.x,r.y,w,r.height)
    if(aligned&&!f.compact&&!flatRows){ctx.strokeStyle=colors.border;ctx.globalAlpha=.28;for(let y=Math.max(r.y,MARGIN_Y+Math.floor(camera.y/ROW_HEIGHT)*ROW_HEIGHT-camera.y);y<Math.min(size.height,r.y+r.height);y+=ROW_HEIGHT)ctx.strokeRect(r.x+.5,y+.5,w,ROW_HEIGHT);ctx.globalAlpha=1}
    const hovered=hover?.fragmentId===f.id
    // What this block's header can carry, decided from its own visible span.
    // The ruler goes with the coordinates: a block too narrow to name its
    // interval is too narrow to tick it either.
    const headerLeft=Math.max(state.original?MARGIN_X:0,r.x),headerRight=Math.min(size.width,r.x+w)
    // The header names the columns the panel covers, which is still the whole
    // block: a collapse removes them from the drawing, not from the interval.
    // What it adds is how many of them are not being drawn, said in words - the
    // bare signed number it used to print was a quantity with no unit and no
    // verb, and nothing on screen said what it was counting or why.
    const cut=collapsedColumns(f)
    const interval=`${(f.start+1).toLocaleString()}–${f.end.toLocaleString()}`
    const cutNote=cut?`${cut.toLocaleString()} ${cut===1?'column':'columns'} hidden`:''
    const canBrowse=state.browserFragments?.has(f.id)
    // Block context is a lens onto one block, so it is offered from every sheet
    // that draws blocks and from none that is already one.
    const canContext=!state.blockContext&&!f.aggregate
    const actionCount=state.blockContext?0:(state.original?3:2)+(canBrowse?1:0)+(canContext?1:0)
    ctx.font=monoFont(10)
    const headerPlan=(!state.blockContext||f.pinned||!layer.fragments.some(part=>part.pinned))&&legible&&headerRight-headerLeft>2*HEADER_PAD?blockHeaderPlan({
      room:headerRight-headerLeft-2*HEADER_PAD,actionsWidth:actionCount*23,
      sourceBlock:f.sourceBlock,interval,note:cutNote,compact:f.compact&&!dense,
      measure:text=>ctx.measureText(text).width}):null
    ctx.fillStyle=colors.head;ctx.fillRect(r.x,r.y-HEADER_HEIGHT,w,HEADER_HEIGHT)
    // Pointing at a block's header picks the whole block out of the row of them.
    if(hovered){ctx.fillStyle=light?'#26374d12':'#cfe0f812';ctx.fillRect(r.x,r.y-HEADER_HEIGHT,w,r.height+HEADER_HEIGHT)}
    // A block picked by its header is outlined in the colour a picked name takes.
    const blockPicked=state.selection.some(s=>s.kind==='block'&&s.fragmentId===f.id)
    // The window in source columns, read back through the collapse map. Taken
    // as a plain division it would name columns that are not on screen at all
    // once anything between them has been collapsed, and every row would then
    // ask its tiles for the wrong stretch of the block.
    const visibleFrom=Math.max(f.start,sourceColumn(f,Math.max(0,-r.x)/r.scale))
    const visibleTo=Math.min(f.end,sourceColumn(f,Math.max(0,(size.width-r.x)/r.scale)))
    // How many columns of this panel land under half a screen pixel - one
    // device pixel on the displays this is read on, and the finest mark that
    // can be told from its neighbour. Everything here is drawn in plane units
    // and the canvas carries the plane factor, so a screen pixel is `1/plane`
    // of them. Both simplifications below are measured in this and in nothing
    // else, which is what makes them do nothing at all close up: at a pixel a
    // column or better it is under one column, and a rule that fires below one
    // column never fires.
    const subPixel=.5/Math.max(Number.EPSILON,r.scale*plane)
    // Kept runs nearer than that are one run. A collapsed block holds up to
    // four thousand of them and zoomed out every one became a piece of its own,
    // in every row, of every span - which is how a sheet that draws in
    // milliseconds close up came to take seconds a step out. Floored to whole
    // columns so that a pan or a nudge of the wheel asks for a run list that is
    // already built rather than a slightly different one.
    const joinTolerance=Math.floor(subPixel)
    const step=niceStep(onScreen)
    ctx.font='10px "IBM Plex Mono", monospace';ctx.fillStyle=colors.muted
    const tickLimit=Math.min(size.width,r.x+w)-HEADER_PAD
    // Ticks are laid per kept run rather than across the panel, because a
    // collapse breaks the one thing an evenly stepped ruler assumes: that the
    // column under a position is the position's own distance from the start.
    // Numbering it that way would print coordinates that are not in the block.
    if(headerPlan?.interval)for(const piece of columnPieces(f,visibleFrom,visibleTo,joinTolerance)){
      for(const tick of rulerTicks({from:piece.start,end:piece.end,x:r.x-piece.hidden*r.scale,start:f.start,scale:r.scale,step,
        limit:tickLimit,viewport:size.width,measure:text=>ctx.measureText(text).width})){
        if(tick.label)ctx.fillText(tick.label,tick.x+3,r.y-9)
        ctx.fillRect(tick.x,r.y-5,1,5)
      }
    }
    ctx.fillStyle=layer.color;ctx.fillRect(r.x,r.y-HEADER_HEIGHT,w,2)

    for(let index=0;index<f.rowIds.length;index++) {
      const id=f.rowIds[index],y=r.y+rowSlot(f,index)*ROW_HEIGHT
      const motifSpans=motifMode?(state.motifRows?.[`${f.sourceBlock}:${id}`]||[]):[]
      if(y+ROW_HEIGHT<0||y>size.height)continue
      const ranges=rowChunks(f,id),selected=lit.has(id)
      // Which geometry the row ended up drawn on, so the gap box sits exactly on
      // it. Taken from the spans rather than assumed: a box on the other one
      // left a sliver of the cells it was meant to cover showing above and below.
      let detailRow=false
      ctx.globalAlpha=anyLit&&!selected?0.36:1
      ctx.fillStyle=colors.void;ctx.fillRect(r.x,y,w,ROW_HEIGHT)
      for(const [rangeStart,rangeEnd] of ranges){
        const left=Math.max(rangeStart,Math.floor(visibleFrom)),right=Math.min(rangeEnd,Math.ceil(visibleTo))
        const coverage=rowCoverage(sources,id,left,right,onScreen,focusOf?focusOf(id):undefined)
        if(!detailRow&&!flatRows)detailRow=coverage.spans.some(s=>s.data?.detail&&s.row?.sequence!=null)
        for(const span of [...coverage.spans,...coverage.holes.map(([start,end])=>({start,end,data:null,row:null}))]){
        // One span of tile coverage becomes one drawn piece per kept run it
        // crosses. The loops below are untouched: each piece hands them its own
        // origin, shifted left by the columns collapsed before it, so they go on
        // placing a column at `origin + (column - f.start) * scale` as they always did.
        for(const piece of columnPieces(f,span.start,span.end,joinTolerance)){
        const {data,row}=span,start=piece.start,end=piece.end,ox=r.x-piece.hidden*r.scale
        if(end<=start)continue
        const x=ox+(start-f.start)*r.scale,width=(end-start)*r.scale
        if(!row||row.missing||row.sequence==null&&data?.detail){
          // Membership is known before bases arrive. Keep an explicitly neutral
          // presence mark instead of making the block body disappear.
          ctx.fillStyle=!row&&f.availableRows?.includes(id)?(light?'#aab8c6':'#415268'):colors.void;ctx.fillRect(x,y+2,width,ROW_HEIGHT-4)
          if(width>24&&!dense)dashed(ctx,x,y+2,width,ROW_HEIGHT-4,row?.missing?colors.border:light?'#e0e6ed':'#243247')
          if(width>160){ctx.fillStyle=colors.muted;ctx.font='10px Lato, sans-serif';ctx.fillText(tile?.error?'Unavailable · Retry loading':!data||!row?'Loading…':row?.missing?'No alignment coverage':'Unavailable',x+8,y+17)}
          continue
        }
        // One hoisted test, taken per span rather than per cell, so the two
        // branches under it stay exactly the straight-line loops they were.
        if(ramp&&cohortSize){
          paintConservationSpan(ctx,{start,end,row,data,sources:conservation?.sources?.[f.id],cohort:cohortSize,ramp,index:scheme.index,contrast:conservation?.scale,
            x:ox,scale:r.scale,fragmentStart:f.start,y,colors,onScreen,light,flat:flatRows,rowPad,counter:paintCount})
          continue
        }
        // Below a few pixels a row is a mark rather than a sequence: one rect
        // says "present here", and the bins, gaps and features it would carry
        // are not resolvable at that size anyway.
        if(flatRows){ctx.fillStyle=motifMode?neutral:uniform||presence;ctx.fillRect(x,y+rowPad,width,ROW_HEIGHT-2*rowPad)
          if(motifMode)paintMotifSpan(ctx,{spans:motifSpans,start,end,x:ox,scale:r.scale,fragmentStart:f.start,y:y+rowPad,height:ROW_HEIGHT-2*rowPad})
          continue}
        // Below the bases and nowhere else: the detail branch under this paints
        // the sequence exactly as it always did, whichever shading is chosen.
        if(uniform&&!data.detail){
          paintUniformSpan(ctx,{start,end,row,data,colour:uniform,x:ox,scale:r.scale,fragmentStart:f.start,y,
            colors,counter:paintCount})
          continue
        }
        if(motifMode&&onScreen<NUCLEOTIDE_LETTER_THRESHOLD){
          const top=data.detail?y+1:y+3,height=data.detail?24:ROW_HEIGHT-6
          ctx.fillStyle=neutral;ctx.fillRect(x,top,width,height)
          paintMotifSpan(ctx,{spans:motifSpans,start,end,x:ox,scale:r.scale,fragmentStart:f.start,y:top,height})
        } else if(data.detail){
          paintBases(ctx,{sequence:row.sequence,sequenceStart:data.start,start,end,x:ox,scale:r.scale,
            fragmentStart:f.start,top:y+1,height:24,colors,baseColors,onScreen,light,
            motifMode,motifSpans,neutral,motifTextColors})
        } else if(motifMode){
          paintUniformSpan(ctx,{start,end,row,data,colour:neutral,x:ox,scale:r.scale,fragmentStart:f.start,y,colors,counter:paintCount})
          paintMotifSpan(ctx,{spans:motifSpans,start,end,x:ox,scale:r.scale,fragmentStart:f.start,y:y+3,height:ROW_HEIGHT-6})
        } else {
          // One rectangle per run of bins rather than one per bin, and only
          // over the bins this piece actually covers. Both used to be the same
          // thing and neither is: coverage resolves finest-first, so zooming
          // out goes on drawing whatever detailed tiles are already in hand,
          // and those bins can be a small fraction of a pixel each.
          for(const run of binRuns(start,end,row,data,subPixel)){
            const bx=ox+(run.start-f.start)*r.scale,bw=(run.end-run.start)*r.scale
            ctx.fillStyle=run.gap?colors.background:run.fraction==null?(run.canonical?presence:'#877b9f'):`hsl(${168-run.fraction*130} ${light?30:36}% ${light?65:49}%)`
            ctx.fillRect(bx,y+3,bw,ROW_HEIGHT-6)
            if(run.gap){ctx.strokeStyle=colors.gap;ctx.lineWidth=.5;ctx.strokeRect(bx,y+3,bw,ROW_HEIGHT-6)}
            else if(run.canonical===0)dashed(ctx,bx,y+3,bw,ROW_HEIGHT-6,colors.border)
            paintCount.fills++
          }
        }
        if(state.annotations){
          const features=annotations[f.id]?.[id]||row.metadata?.features||[]
          for(const feature of features){
            const a=Math.max(start,feature.start),z=Math.min(end,feature.end+1)
            if(z<=a)continue
            const type=feature.type,color=FEATURE_COLORS[type]?.bg||'#60a5fa'
            ctx.fillStyle=color
            const h=type==='cds'?7:type==='exon'?4:3
            ctx.fillRect(ox+(a-f.start)*r.scale,y+ROW_HEIGHT-h,(z-a)*r.scale,h)
            if(type==='cds'&&onScreen>=4){ctx.fillStyle='#bfdbfe';for(let p=a;p<z;p+=6)ctx.fillRect(ox+(p-f.start)*r.scale,y+ROW_HEIGHT-h,Math.min(3,z-p)*r.scale,h)}
          }
        }
        }
        }
      }
      // Gaps last, from memory rather than from whichever tile is to hand, so one
      // resolved at any zoom stays resolved instead of flickering as tiles swap.
      // This pass paints over the cells, so it is also where a gap gets its
      // outline and its dash: one run is one box at every zoom, where an outline
      // per cell drew a row of little boxes at one zoom and a long one at the next.
      if(gaps&&!f.aggregate&&!flatRows){
        const gapTop=detailRow?y+1:y+3,gapHeight=detailRow?24:ROW_HEIGHT-6
        // A remembered gap can straddle a collapsed stretch, so each run is cut
        // on the same runs the cells were. Drawn whole it would paint its box
        // straight over the join and the columns beyond it.
        // One run is one box, collapse or no collapse. A collapsed stretch has
        // no width on the panel, so a run straddling one is still a single
        // unbroken box - and it has to be drawn as one: two boxes would meet in
        // a pair of outlines exactly where the alignment is meant to read as
        // continuous. What the box covers is gap either way, since a collapsed
        // stretch is by definition gap in every row on screen.
        const runs=visibleGaps(gaps,f.sourceBlock,id,visibleFrom,visibleTo,MIN_VISIBLE_GAP/(r.scale*plane))
        for(const [a,z] of runs){
          const gx=r.x+displayColumn(f,a)*r.scale,gw=(displayColumn(f,z)-displayColumn(f,a))*r.scale
          if(gw<=0)continue
          ctx.fillStyle=colors.background;ctx.fillRect(gx,gapTop,gw,gapHeight)
          ctx.strokeStyle=colors.gap;ctx.lineWidth=.5;ctx.strokeRect(gx+.5,gapTop+.5,Math.max(0,gw-1),gapHeight-1);ctx.lineWidth=1
        }
        // Dashes wherever a column is wide enough to hold one - not only where
        // the row's own bases have arrived. Memory is what proved the gap, and a
        // row still waiting on its detail tile is the same gap; gating on the
        // tile drew dashes on some rows and not their neighbours.
        if(onScreen>=NUCLEOTIDE_LETTER_THRESHOLD&&runs.length){
          ctx.fillStyle=colors.gap;ctx.font=monoFont(12);ctx.textAlign='center';ctx.textBaseline='middle'
          // A glyph per column, so unlike the box these follow the kept runs: a
          // collapsed column has no column of its own to put a dash in.
          for(const [a,z] of runs)
            for(const piece of columnPieces(f,a,z))
              for(let column=piece.start;column<piece.end;column++)
                ctx.fillText('-',r.x-piece.hidden*r.scale+(column+.5-f.start)*r.scale,gapTop+gapHeight/2)
          ctx.textAlign='left';ctx.textBaseline='alphabetic'
        }
      }
      ctx.globalAlpha=1
      if(selected){ctx.strokeStyle=PICKED_EDGE;ctx.lineWidth=hair(1.5);ctx.strokeRect(r.x,y+1,w,ROW_HEIGHT-2)}
      ctx.strokeStyle=colors.border;ctx.globalAlpha=.18;ctx.beginPath();ctx.moveTo(r.x,y+ROW_HEIGHT);ctx.lineTo(r.x+w,y+ROW_HEIGHT);ctx.stroke();ctx.globalAlpha=1
    }
    // Where columns were taken out, said so on the sheet itself.
    //
    // A collapse is the one thing this view does that makes neighbouring
    // columns on screen not neighbours in the alignment, so it cannot be silent.
    // The mark is drawn after the cells and through the whole panel, header
    // included: it is a property of the panel, not of any row in it, and a row
    // that happens to be empty there must not look like the one that was cut.
    const joinFrom=Math.max(0,-r.x-4)/r.scale,joinTo=Math.max(0,size.width-r.x+4)/r.scale
    // Marks closer together than they are wide are not marks any more. A real
    // alignment read down to a few sequences collapses in thousands of short
    // runs, and drawn one apiece they merged into a hatch that filled the block
    // header and striped the cells - which says "something happened all along
    // here" far less clearly than a handful of marks and a count does. The
    // header carries the total, so nothing is lost by drawing the ones that can
    // be told apart.
    let lastJoin=-Infinity
    for(const join of state.collapseMarks===false?[]:collapseJoins(f,joinFrom,joinTo)){
      const jx=r.x+join.offset*r.scale
      if(jx-lastJoin<MIN_JOIN_GAP/plane)continue
      lastJoin=jx
      // One hairline through the cells, and nothing in the header. It was a
      // banded mark with two edges and a dashed riser into the header, which is
      // a reasonable mark for the handful of joins a small alignment has and
      // completely wrong for the thousands a real one has: the risers hatched
      // the header solid and the bands turned the block into a barcode with the
      // sequence somewhere behind it. What is collapsed is a count in the
      // header; where it happened only needs a line fine enough to read past.
      ctx.strokeStyle=colors.gap;ctx.globalAlpha=.6;ctx.lineWidth=hair(1)
      ctx.beginPath();ctx.moveTo(jx,r.y);ctx.lineTo(jx,r.y+r.height);ctx.stroke()
      ctx.globalAlpha=1;ctx.lineWidth=1
      hits.push({kind:'collapse',fragmentId:f.id,x:jx-5,y:r.y-HEADER_HEIGHT,width:10,height:r.height+HEADER_HEIGHT,
        columns:join.columns,from:join.start,to:join.end})
    }
    // Optional provenance overlay on the immutable Original, never on by default.
    for(const placed of state.placedOverlay||[]){
      if(placed.sourceBlock!==f.sourceBlock)continue
      for(const id of placed.rowIds){const index=f.rowIds.indexOf(id);if(index<0)continue
        const y=r.y+rowSlot(f,index)*ROW_HEIGHT
        if(y+ROW_HEIGHT<0||y>size.height)continue
        for(const [a,z] of cellRanges(placed,id)){
          const x=r.x+displayColumn(f,a)*r.scale,width=(displayColumn(f,z)-displayColumn(f,a))*r.scale
          if(width<=0)continue
          // Another layer's colour, drawn the way a pick is drawn: the layer is
          // what the mark means, the weight and the inset are what kind of mark
          // it is, and those are the pick's.
          ctx.fillStyle=placed.color+WASH_ALPHA;ctx.fillRect(x,y,width,ROW_HEIGHT)
          armedEdge(placed.color,x,y+1,width,ROW_HEIGHT-2)
        }
      }
    }
    for(const selected of state.selection.filter(s=>s.fragmentId===f.id)){
      // A pick is stored in source columns and stays that way: only where it is
      // drawn moves. It stays one rectangle with one edge, because the columns
      // collapsed inside it are still inside it - they are picked, and they are
      // exported - and an edge drawn around each drawn piece would cut the
      // region into parts the reader never made.
      const x=r.x+displayColumn(f,selected.start)*r.scale
      const width=(displayColumn(f,selected.end)-displayColumn(f,selected.start))*r.scale
      for(const id of selected.rowIds){const i=f.rowIds.indexOf(id);if(i<0)continue;const y=r.y+rowSlot(f,i)*ROW_HEIGHT;ctx.fillStyle=PICKED+WASH_ALPHA;ctx.fillRect(x,y,width,ROW_HEIGHT);pickEdge(x,y+1,width,ROW_HEIGHT-2)}
      // Pointing at a region offers to drop it. On the region's own top right
      // corner rather than the block's, since several regions can share a block
      // and the one being pointed at is the one that would go.
      // Every pick that is a region rather than a named thing. Stated as what
      // it excludes on purpose: a drag stamps 'region', Select by coordinates
      // stamps nothing at all, and a rule that named the wanted kinds would
      // have to be found and corrected every time a third way of drawing a
      // region appears. A picked name or block is left out because clicking it
      // again already drops it, and a name carries a cross of its own that
      // removes the sequence from the layer - two crosses a few pixels apart
      // meaning different things is worse than no cross at all.
      const region=selected.kind!=='row'&&selected.kind!=='block'
      const slots=region&&hoverPick===selected&&pickSlots(f,selected)
      if(slots){
        const top=r.y+slots.top*ROW_HEIGHT,bottom=r.y+(slots.bottom+1)*ROW_HEIGHT
        // Held inside whatever of the region is on screen. A wide selection
        // scrolled past its own corner would otherwise put its only way out
        // somewhere the pointer cannot reach.
        const left=Math.max(0,x),right=Math.min(size.width,x+width)
        // Near the top of the region, pushed down only as far as it must be: to
        // clear the top of the window when the region starts above it, and no
        // further than the region's own bottom edge. Written as a max of the
        // two ends it sat on the bottom corner of anything taller than itself.
        const cx=Math.max(left+9,right-11),cy=Math.min(Math.max(bottom,top+18)-9,Math.max(Math.max(0,top)+9,9))
        if(right>left&&bottom>top){
          ctx.fillStyle=light?'#f6f8fbe8':'#152032e8';ctx.beginPath();ctx.arc(cx,cy,9,0,Math.PI*2);ctx.fill()
          ctx.strokeStyle=PICKED_EDGE;ctx.lineWidth=1.2;ctx.beginPath();ctx.arc(cx,cy,8.4,0,Math.PI*2);ctx.stroke()
          ctx.lineWidth=1.7;ctx.beginPath()
          ctx.moveTo(cx-3.4,cy-3.4);ctx.lineTo(cx+3.4,cy+3.4);ctx.moveTo(cx+3.4,cy-3.4);ctx.lineTo(cx-3.4,cy+3.4);ctx.stroke();ctx.lineWidth=1
          hits.push({kind:'deselect',pick:selected,x:cx-11,y:cy-11,width:22,height:22})
        }
      }
    }
    // The outline goes on after the rows. Drawn before them, the cells painted
    // over the left, right and bottom edges and a hovered or picked block was
    // marked along its header alone. Whole-pixel edges with the stroke held
    // inside them give all four sides the same weight; half-pixel rects left
    // one side crisp and the opposite one spread over two columns.
    const lw=hair(blockPicked?2:hovered?1.5:1)
    const ox=Math.round(r.x),oy=Math.round(r.y-HEADER_HEIGHT),oRight=Math.round(r.x+w),oBottom=Math.round(r.y+r.height)
    ctx.strokeStyle=blockPicked?PICKED:state.selection.some(s=>s.fragmentId===f.id)?layer.color:hovered?colors.text:colors.border
    ctx.lineWidth=lw;ctx.strokeRect(ox+lw/2,oy+lw/2,Math.max(0,oRight-ox-lw),Math.max(0,oBottom-oy-lw));ctx.lineWidth=1
    ctx.restore()
    hits.push({kind:'header',fragmentId:f.id,x:r.x,y:r.y-HEADER_HEIGHT,width:w,height:HEADER_HEIGHT})
    // Labels travel with the leftmost block. Only glyphs get a subtle halo;
    // there is no sticky opaque rectangle to erase bases or connecting strings.
    // Except where a fixed gutter is drawn instead - Original's, or block
    // context's - because two sets of names for the same rows is worse than
    // either on its own.
    for(let index=0;index<f.rowIds.length;index++) {
      const id=f.rowIds[index],y=r.y+rowSlot(f,index)*ROW_HEIGHT
      if(state.original||state.blockContext||dense||!legible||first.get(id)!==f.id||y+ROW_HEIGHT<0||y>size.height)continue
      let label=byId.get(id)?.label||byId.get(id)?.source||id
      ctx.font=`${lit.has(id)?'bold ':''}11px Lato, sans-serif`
      if(ctx.measureText(label).width>140){while(label.length&&ctx.measureText(label+'…').width>140)label=label.slice(0,-1);label+='…'}
      const width=ctx.measureText(label).width,labelRight=r.x-10,labelX=labelRight-width
      if(labelRight<0||labelX>size.width)continue
      // A picked name carries its own way out of the layer, so the room it needs
      // is reserved before anything decides the name fits.
      const cross=lit.has(id)?22:0
      const box={x:labelX-cross,y,width:width+cross,height:ROW_HEIGHT}
      if(drawLayer.fragments.some(other=>{if(other.id===f.id)return false;const rect=panelRect(other,camera);return box.x<rect.x+rect.width&&box.x+box.width>rect.x&&box.y<rect.y+rect.height&&box.y+box.height>rect.y-HEADER_HEIGHT})||labelBoxes.some(b=>box.x<b.x+b.width&&box.x+box.width>b.x&&box.y<b.y+b.height&&box.y+box.height>b.y))continue
      labelBoxes.push(box)
      linkedPill(byId.get(id),labelX,y,width)
      ctx.strokeStyle=colors.background;ctx.lineWidth=3;ctx.lineJoin='round';ctx.strokeText(label,labelX,y+17)
      ctx.fillStyle=lit.has(id)?PICKED:colors.text;ctx.fillText(label,labelX,y+17)
      hits.push({kind:'label',rowId:id,fragmentId:f.id,x:labelX-3,y,width:width+6,height:ROW_HEIGHT})
      // Pushed after the name's own region, because the hit test reads the list
      // backwards: the cross has to answer before the name it sits beside.
      if(cross){
        const cx=labelX-13,cy=y+ROW_HEIGHT/2,arm=(a,b)=>{ctx.beginPath();ctx.moveTo(cx-4,cy-4);ctx.lineTo(cx+4,cy+4);ctx.moveTo(cx+4,cy-4);ctx.lineTo(cx-4,cy+4);ctx.strokeStyle=a;ctx.lineWidth=b;ctx.stroke()}
        arm(colors.background,3.5);arm(PICKED,1.6);ctx.lineWidth=1
        hits.push({kind:'removeRow',rowId:id,x:cx-9,y,width:18,height:ROW_HEIGHT})
      }
    }
    if(!headerPlan||state.blockContext)continue
    const plan=headerPlan,textWidth=plan.width
    ctx.font=monoFont(10)
    // Alone in the header, a name sits in the middle of the block the way a
    // short label reads best; with actions beside it, it starts at the edge.
    const textX=plan.actions?headerLeft+HEADER_PAD:headerLeft+(headerRight-headerLeft-textWidth)/2
    const headerBox={left:textX,right:textX+textWidth}
    if(headerBoxes.some(b=>headerBox.left<b.right+4&&headerBox.right>b.left-4))continue
    headerBoxes.push(headerBox)
    ctx.save();ctx.beginPath();ctx.rect(headerLeft,r.y-HEADER_HEIGHT,headerRight-headerLeft,HEADER_HEIGHT);ctx.clip()
    ctx.fillStyle=colors.text
    ctx.fillText(plan.text,textX,plan.interval?r.y-35:r.y-27)
    if(plan.interval)ctx.fillText(plan.line,textX,r.y-21)
    ctx.restore()
    // Small header actions have their own hit regions, separate from dragging.
    // None of them in block context: copying and removing belong to the sheet
    // this is a lens onto, the lens has its own bar, and an icon that is drawn
    // but does nothing is worse than one that is not there.
    if(plan.actions&&!state.blockContext){
    // One cursor rather than hand-laid offsets. Every icon is the same width and
    // they run right to left, so the arithmetic that used to be written out at
    // each call site - and had to be corrected at each one whenever an icon was
    // added - is now the order of these blocks and nothing else.
    const iconY=r.y-HEADER_HEIGHT+6
    let taken=0
    const nextX=()=>headerRight-23-(taken++)*23
    const iconX=nextX()
    ctx.fillStyle=colors.head;rounded(ctx,iconX,iconY,20,22,3);ctx.fill()
    ctx.strokeStyle=colors.text;ctx.lineWidth=1.3;ctx.strokeRect(iconX+6,iconY+6,9,12);ctx.strokeRect(iconX+8,iconY+3,5,4)
    hits.push({kind:'copy',fragmentId:f.id,x:iconX,y:iconY,width:20,height:22})
    // A chunk is a piece someone put in this layer, so it can be taken back out
    // again. Never on the Original: that is a derived view of the source, where
    // the equivalent gesture is Hide, which is reversible and already exists.
    if(!state.original){const closeX=nextX();ctx.fillStyle=colors.head;rounded(ctx,closeX,iconY,20,22,3);ctx.fill()
      ctx.strokeStyle=colors.text;ctx.lineWidth=1.3;ctx.beginPath()
      ctx.moveTo(closeX+6,iconY+7);ctx.lineTo(closeX+14,iconY+15);ctx.moveTo(closeX+14,iconY+7);ctx.lineTo(closeX+6,iconY+15);ctx.stroke()
      hits.push({kind:'removeBlock',fragmentId:f.id,x:closeX,y:iconY,width:20,height:22})}
    if(state.original){const plusX=nextX();ctx.fillStyle=colors.head;rounded(ctx,plusX,iconY,20,22,3);ctx.fill();ctx.strokeStyle=colors.text;ctx.beginPath();ctx.moveTo(plusX+5,iconY+11);ctx.lineTo(plusX+15,iconY+11);ctx.moveTo(plusX+10,iconY+6);ctx.lineTo(plusX+10,iconY+16);ctx.stroke();hits.push({kind:'layer',fragmentId:f.id,x:plusX,y:iconY,width:20,height:22})
      const rowX=nextX();ctx.fillStyle=colors.head;rounded(ctx,rowX,iconY,20,22,3);ctx.fill();ctx.strokeStyle=colors.text;ctx.beginPath();for(let i=0;i<3;i++){const y=iconY+6+i*(f.compact?3:5);ctx.moveTo(rowX+5,y);ctx.lineTo(rowX+15,y)}ctx.stroke();hits.push({kind:'rows',fragmentId:f.id,x:rowX,y:iconY,width:20,height:22})}
    if(canBrowse){
      const browseX=nextX()
      ctx.fillStyle=light?'#dbeafe':'#17365f';rounded(ctx,browseX,iconY,20,22,3);ctx.fill()
      ctx.strokeStyle=colors.gap;ctx.lineWidth=1.25;rounded(ctx,browseX+4,iconY+4,12,14,2);ctx.stroke()
      ctx.beginPath();ctx.moveTo(browseX+4,iconY+9);ctx.lineTo(browseX+16,iconY+9);ctx.stroke()
      ctx.fillStyle=colors.gap
      for(const x of [browseX+7,browseX+10,browseX+13]){ctx.beginPath();ctx.arc(x,iconY+7,0.7,0,Math.PI*2);ctx.fill()}
      ctx.lineWidth=1;hits.push({kind:'browse',fragmentId:f.id,x:browseX,y:iconY,width:20,height:22})
    }
    if(canContext){
      // Corner brackets: this block, on its own, with everything else set aside.
      const cx=nextX()
      ctx.fillStyle=colors.head;rounded(ctx,cx,iconY,20,22,3);ctx.fill()
      ctx.strokeStyle=colors.text;ctx.lineWidth=1.3;ctx.beginPath()
      for(const [ax,ay,bx,by,mx,my] of [[4,9,4,5,8,5],[16,9,16,5,12,5],[4,13,4,17,8,17],[16,13,16,17,12,17]]){
        ctx.moveTo(cx+ax,iconY+ay);ctx.lineTo(cx+bx,iconY+by);ctx.lineTo(cx+mx,iconY+my)
      }
      ctx.stroke()
      ctx.fillStyle=colors.text;ctx.fillRect(cx+6,iconY+10,8,2)
      ctx.lineWidth=1;hits.push({kind:'context',fragmentId:f.id,x:cx,y:iconY,width:20,height:22})
    }
    }

  }
  if(state.original){
    ctx.fillStyle=colors.background;ctx.fillRect(0,0,MARGIN_X,size.height)
    ctx.strokeStyle=colors.border;ctx.beginPath();ctx.moveTo(MARGIN_X-.5,0);ctx.lineTo(MARGIN_X-.5,size.height);ctx.stroke()
    // The block the view is over, not the one whose start is nearest. A wide
    // block whose start is far off to the left still fills the screen, and
    // naming a small neighbour instead put the gutter on a different block's
    // rows from the ones being looked at.
    const focused=sourceViewAnchor(drawLayer.fragments.filter(f=>!f.aggregate&&panelRect(f,camera).y<size.height&&panelRect(f,camera).y+panelRect(f,camera).height>0),camera)
    const compactAnchor=focused?.compact?focused:null
    const gutter=compactAnchor?compactAnchor.rowIds.map((id,i)=>({row:byId.get(id),y:panelRect(compactAnchor,camera).y+rowSlot(compactAnchor,i)*ROW_HEIGHT})):inventory.map((row,i)=>({row,y:MARGIN_Y+i*ROW_HEIGHT-camera.y}))
    if(compactAnchor&&legible){ctx.fillStyle=colors.muted;ctx.font='10px Lato, sans-serif';ctx.fillText(`Rows: block ${compactAnchor.sourceBlock}`,8,14)}
    for(const {row,y} of gutter){
      if(!row||y+ROW_HEIGHT<0||y>size.height)continue
      // The names stop being drawn long before they stop being targets: a row
      // still answers to a click when it is too small to carry its own label.
      if(legible){
        let label=row.label||row.source||row.id;ctx.font='11px Lato, sans-serif';while(label.length&&ctx.measureText(label).width>MARGIN_X-18)label=label.slice(0,-2)+'…'
        const width=ctx.measureText(label).width
        linkedPill(row,MARGIN_X-10-width,y,width)
        ctx.fillStyle=lit.has(row.id)?PICKED:colors.text;ctx.textAlign='right';ctx.fillText(label,MARGIN_X-10,y+17);ctx.textAlign='left'
      }
      hits.push({kind:'label',rowId:row.id,anchor:compactAnchor?compactAnchor.sourceBlock:null,x:0,y,width:MARGIN_X,height:ROW_HEIGHT})
    }
  }
  // Only the aggregate overview needs a word: its bars are an encoding rather
  // than sequence. Plain blocks say what they are in their own headers.
  if(dense&&legible&&drawLayer.fragments.some(f=>f.aggregate)){ctx.fillStyle=colors.muted;ctx.font='11px Lato, sans-serif'
    ctx.fillText('Block presence · filled width = fraction of blocks containing each sequence · click a header to zoom',MARGIN_X+8,13)}
  // Both ends of a skipped link, and any path leaving the loaded window: a
  // chevron on the block edge and the block at the other end, drawn after the
  // panels so nothing buries them. Clicking one opens that block.
  //
  // Drawn after the gutter as well, so in Original they are held to the sheet's
  // side of it: panning sideways used to slide a jump label out over the names
  // and leave two pieces of text on top of each other. Clipped here, the label
  // passes under the name column the way the alignment itself does.
  ctx.save()
  if(state.original){ctx.beginPath();ctx.rect(MARGIN_X,0,Math.max(0,size.width-MARGIN_X),size.height);ctx.clip()}
  ctx.font='10px "IBM Plex Mono", monospace'
  for(const marker of blockJumpMarkers(connections,offWindow,drawnRects,buried)){
    const f=fragmentById.get(marker.fragmentId)
    if(!f)continue
    const index=f.rowIds.indexOf(marker.rowId)
    if(index<0)continue
    const selected=lit.has(marker.rowId)
    if(dense&&!selected)continue
    const r=panelRect(f,camera)
    const y=r.y+(rowSlot(f,index)+0.5)*ROW_HEIGHT
    if(y<MARGIN_Y-2||y>size.height-2)continue
    const anchor=marker.edge>0?r.x+r.width:r.x
    const label=String(marker.block)
    ctx.font=`${selected?'bold ':''}10px "IBM Plex Mono", monospace`
    const width=ctx.measureText(label).width+8
    // The label sits centred in the channel beside the block, so it has room on
    // both sides instead of being crushed against the next block.
    const mid=anchor+marker.edge*BLOCK_EDGE_GAP/2
    const labelX=mid-width/2
    const near=marker.edge>0?labelX-3:labelX+width+3
    // The chevron points the way a click would take the reader: out of the block
    // and toward the one named on the label, which is always the side the marker
    // sits on. Following the path's direction of travel instead left the marker
    // that joins back to an earlier block aiming away from the block it names.
    if(labelX+width<MARGIN_X||labelX>size.width)continue
    ctx.strokeStyle=selected?PICKED_EDGE:light?'#526f91':'#9eb9d9'
    ctx.lineWidth=hair(selected?2.2:1.5)
    ctx.globalAlpha=anyLit&&!selected?0.35:0.95
    ctx.beginPath();ctx.moveTo(anchor,y);ctx.lineTo(near,y);ctx.stroke()
    ctx.beginPath();ctx.moveTo(near-marker.edge*4,y-4);ctx.lineTo(near,y);ctx.lineTo(near-marker.edge*4,y+4);ctx.stroke()
    ctx.globalAlpha=1
    if(legible){
      ctx.fillStyle=colors.background;rounded(ctx,labelX,y-7,width,14,4);ctx.fill()
      ctx.strokeStyle=selected?'#d9a638':colors.border;ctx.lineWidth=1;rounded(ctx,labelX+.5,y-6.5,width-1,13,4);ctx.stroke()
      ctx.fillStyle=selected?'#d9a638':colors.muted;ctx.fillText(label,labelX+4,y+3)
    }
    const hitX=Math.min(anchor,labelX),hitRight=hitX+Math.abs(labelX+width/2-anchor)+width/2+4
    const clipped=state.original?Math.max(hitX,MARGIN_X):hitX
    if(hitRight>clipped)hits.push({kind:'blockjump',rowId:marker.rowId,block:marker.block,fragmentId:f.id,
      x:clipped,y:y-9,width:hitRight-clipped,height:18})
  }
  ctx.restore()
  // Where a dragged row would land, drawn over everything so the answer is
  // visible whichever block the cursor happens to be over.
  if(reorder){
    // At its real size, whatever the plane is doing. Where a row will land is a
    // piece of interface, and a hairline that shrinks with the sheet would be
    // invisible in exactly the overview where rows are dragged the furthest.
    ctx.save();ctx.scale(1/plane,1/plane)
    const y=reorder.lineY*plane,gutterX=MARGIN_X*plane
    ctx.fillStyle=PICKED
    // Marked on the blocks the move actually shows in, and nowhere else. A line
    // of one weight straight across the window is read against the gutter's
    // names, and those are a different list from the block being dragged into.
    if(reorder.spans?.length){
      for(const span of reorder.spans){
        const left=Math.max(gutterX,span.x*plane),right=Math.min(size.width*plane,(span.x+span.width)*plane)
        if(right<=left)continue
        ctx.globalAlpha=span.primary?.95:.45
        ctx.fillRect(left,span.y*plane-1.5,right-left,3)
      }
      ctx.globalAlpha=1
    } else {
      ctx.globalAlpha=.9;ctx.fillRect(0,y-1,size.width*plane,2);ctx.globalAlpha=1
      ctx.beginPath();ctx.arc(gutterX-6,y,4,0,Math.PI*2);ctx.fill()
    }
    const row=byId.get(reorder.rowId)
    const label=row?.label||row?.source||reorder.rowId
    ctx.font='bold 11px Lato, sans-serif'
    const width=ctx.measureText(label).width+14
    const boxY=reorder.y*plane
    const boxX=Math.min(Math.max(4,gutterX-width-8),size.width*plane-width-4)
    ctx.fillStyle=colors.head;rounded(ctx,boxX,boxY-9,width,18,5);ctx.fill()
    ctx.strokeStyle=PICKED;ctx.lineWidth=1;rounded(ctx,boxX+.5,boxY-8.5,width-1,17,5);ctx.stroke()
    ctx.fillStyle=PICKED;ctx.fillText(label,boxX+7,boxY+4)
    ctx.restore()
  }
  if(selectionRect){ctx.fillStyle=MARQUEE_WASH;ctx.fillRect(selectionRect.x,selectionRect.y,selectionRect.width,selectionRect.height)
    pickEdge(selectionRect.x,selectionRect.y,selectionRect.width,selectionRect.height,[5,3])}
  if(!layer.fragments.length){ctx.fillStyle=colors.muted;ctx.font='14px Lato, sans-serif';ctx.textAlign='center';ctx.fillText('This layer is empty. Move a selection here from another layer.',size.width/2,size.height/2);ctx.textAlign='left'}
  if(ghost){ctx.fillStyle=colors.head;ctx.fillRect(0,0,size.width,34);ctx.fillStyle=layer.color;ctx.font='bold 13px Lato, sans-serif';ctx.fillText(layer.name,16,23)}

  if(ramp||uniform)recordPerformance('scheme',{scheme:scheme.id,fills:paintCount.fills,cohort:cohortSize})
  return hits
}
