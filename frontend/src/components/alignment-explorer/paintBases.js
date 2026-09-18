import { NUCLEOTIDE_TEXT_COLOR, NUCLEOTIDE_LETTER_THRESHOLD, getBaseColor } from '../../utils/nucleotideStyle'
import { firstMotifSpan } from './motifs.js'
import { readableTextOn } from '../../utils/genomePillColors.js'
import { monoFont } from '../../utils/typography'

/** One cell per alignment column, coloured by its base.
 *
 * Lifted out of the layer painter unchanged so that block context draws the
 * sequence with exactly the same code the sheet does. Two things read a
 * sequence and they must not be allowed to disagree about what a base looks
 * like, how wide a column is, or when a letter becomes legible.
 *
 * `top` and `height` are parameters rather than the constants they used to be,
 * because the same cells are drawn at row height on the sheet and at a
 * different height beside a gene model. Everything else is as it was.
 *
 * `sequence` is indexed from `sequenceStart`, which is the column its first
 * character stands for - a tile's own start, not the fragment's.
 */
export function paintBases(ctx,{sequence,sequenceStart,start,end,x,scale,fragmentStart,top,height,
  colors,baseColors,onScreen,light,motifMode=false,motifSpans=[],neutral=null,motifTextColors=null}) {
  let motifIndex=firstMotifSpan(motifSpans,start)
  for(let col=start;col<end;col++){
    const base=sequence[col-sequenceStart]
    if(base===undefined)continue
    const left=Math.round(x+(col-fragmentStart)*scale),right=Math.round(x+(col+1-fragmentStart)*scale)
    const width=Math.max(.5,right-left)
    while(motifIndex<motifSpans.length&&motifSpans[motifIndex][1]<=col)motifIndex++
    const motifColor=motifSpans[motifIndex]?.[0]<=col?motifSpans[motifIndex][2]:neutral
    ctx.fillStyle=base==='-'?colors.background:motifMode?motifColor:getBaseColor(base,baseColors)
    ctx.fillRect(left,top,width,height)
    if(onScreen>=6&&width>=2){
      ctx.strokeStyle=light?'rgba(0,0,0,0.35)':'rgba(255,255,255,0.25)';ctx.lineWidth=1
      ctx.beginPath();ctx.moveTo(right-.5,top+.5);ctx.lineTo(right-.5,top+height-.5);ctx.stroke()
    }
    // A gap's own dash is drawn with the run below, not here: this cell
    // is painted over by that pass, and a dash left under it was rubbed
    // out - visible only on a dimmed row, where the paint over it is
    // translucent enough to let it through.
    if(onScreen>=NUCLEOTIDE_LETTER_THRESHOLD&&base!=='-'){
      if(motifMode&&motifTextColors&&!motifTextColors.has(motifColor))motifTextColors.set(motifColor,readableTextOn(motifColor))
      ctx.fillStyle=motifMode?motifTextColors?.get(motifColor):NUCLEOTIDE_TEXT_COLOR;ctx.font=monoFont(12);ctx.textAlign='center';ctx.textBaseline='middle'
      ctx.fillText(base.toUpperCase(),left+width/2,top+height/2)
      ctx.textAlign='left';ctx.textBaseline='alphabetic'
    }
  }
}
