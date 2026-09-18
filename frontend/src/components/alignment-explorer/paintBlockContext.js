import { ROW_HEIGHT, MARGIN_X } from './layout.js'
import { panelRect, pinnedBottom } from './layers.js'
import { FEATURE_COLORS } from '../FeatureLegend'
import { rowLanes, SEQUENCE_LANES, comparatorFor, activePair, emptyLaneReason, shownTranscript } from './detail.js'
import { monoFont } from '../../utils/typography'
import { bandSlices } from './comparisonBands.js'
import { annotationModels, MODEL_PITCH, orderedContextHits } from './contextModelLayout.js'

/** Gene models in alignment-column space, under the sequence they belong to.
 *
 * Drawn after the layer painter and over its panels, with its own clip, its own
 * hit regions and no opinion about anything the layer painter drew. Three
 * things are kept apart here and must stay apart:
 *
 * - a row's **own annotation**, which is solid and belongs to that genome;
 * - a **reference guide**, which is faint and outlined and is only the columns
 *   the reference's chosen transcript occupies, projected across;
 * - a **comparison band**, which is measured difference, not annotation.
 *
 * A guide drawn like an annotation would assert that another genome has a
 * feature there, which the alignment is not evidence of.
 */
/** Lane geometry. A track lane is one row tall; the band runs along its top
 * edge, and the models sit under it. */
const BAND_HEIGHT = 5
const MODEL_TOP = BAND_HEIGHT + 3
const EXON_HEIGHT = 9
const CDS_HEIGHT = 11
const UTR_HEIGHT = 7
/** Below this a model is a presence mark rather than a shape: its parts are
 * narrower than the ink outlining them. */
const MIN_MODEL_WIDTH = 3

const FEATURE_HEIGHT = { cds: CDS_HEIGHT, exon: EXON_HEIGHT, utr5: UTR_HEIGHT, utr3: UTR_HEIGHT, intron: 1 }
/** Painted low to high, so CDS lands over exon and never under it. */
const FEATURE_ORDER = { intron: 0, exon: 1, utr5: 2, utr3: 2, cds: 3 }

const colourFor = type => FEATURE_COLORS[type]?.bg || FEATURE_COLORS.exon?.bg || '#60a5fa'

function clipRange(a, z, from, to) {
  return [Math.max(a, from), Math.min(z, to)]
}

export function paintBlockContext(ctx, { layer, camera, size, detail, features, rowsById, inventory, comparison, comparisonPending, colors, light, pending, zoomRequired }) {
  const hits = []
  if (!detail) return hits
  const reference = detail.reference
  const pair = activePair(detail)
  // Only the reference's own pick projects across, and in adjacent mode only
  // onto the pair being inspected. A guide on every row of a stack compared
  // pairwise says nothing about most of them.
  const guideRow = detail.mode === 'adjacent' ? pair?.[0] : reference
  const guide = guideRow ? shownTranscript(features?.[guideRow], detail.picks?.[guideRow]) : null
  const chosen = detail.feature || null
  const guideColumns = guide
    ? guide.transcript.features.filter(f => f.type !== 'intron').flatMap(f => f.pieces.map(p => [p.start, p.end, f.type]))
    : []

  ctx.save()
  ctx.beginPath(); ctx.rect(0, 0, size.width, size.height); ctx.clip()
  for (const fragment of layer.fragments) {
    const rect = panelRect(fragment, camera)
    if (rect.x > size.width || rect.x + rect.width < 0) continue
    const from = Math.max(fragment.start, fragment.start + (MARGIN_X - rect.x) / rect.scale)
    const to = Math.min(fragment.end, fragment.start + (size.width - rect.x) / rect.scale)
    const px = column => rect.x + (column - fragment.start) * rect.scale
    // Text starts at the gutter's edge, never at the window's. The block slides
    // under the gutter as the camera moves, and anything written left of it is
    // painted over by the names at the end of this pass.
    const textX = x => Math.max(MARGIN_X + 6, x)
    ctx.save(); ctx.beginPath(); ctx.rect(MARGIN_X, fragment.pinned ? 0 : pinnedBottom(layer, camera), Math.max(0, size.width - MARGIN_X), size.height); ctx.clip()
    fragment.rowIds.forEach((rowId, index) => {
      const slot = fragment.slots?.[index] ?? index
      const laneTop = rect.y + (slot + SEQUENCE_LANES) * ROW_HEIGHT
      const laneHeight = (rowLanes(detail, rowId) - SEQUENCE_LANES) * ROW_HEIGHT
      if (laneTop > size.height || laneTop + laneHeight < 0) return
      const entry = features?.[rowId]
      const row = rowsById?.get(rowId)

      // -- what the comparison says, along the lane's top edge ---------------
      const against = comparatorFor(detail, rowId)
      const measured = against ? comparison?.get(rowId) : null
      if (against) {
        ctx.fillStyle = light ? '#e8edf3' : '#1d2b3f'
        ctx.fillRect(Math.max(0, rect.x), laneTop, Math.min(size.width, rect.width), BAND_HEIGHT)
        for (const bin of measured?.bins || []) {
          const a = measured.start + bin.start, z = measured.start + bin.end
          const [lo, hi] = clipRange(a, z, from, to)
          if (hi <= lo) continue
          const x = px(lo), binWidth = Math.max(.75, (hi - lo) * rect.scale)
          for (const slice of bandSlices(bin, binWidth)) {
            ctx.fillStyle = slice.colour
            ctx.fillRect(x + slice.x, laneTop, slice.width, BAND_HEIGHT)
          }
        }
      }

      // -- the reference's guide, under everything this row draws itself -----
      const showGuide = guideColumns.length && rowId !== guideRow &&
        (detail.mode === 'reference' || rowId === pair?.[1])
      if (showGuide) {
        ctx.save(); ctx.globalAlpha = light ? .5 : .42
        for (const [a, z, type] of guideColumns) {
          const [lo, hi] = clipRange(a, z, from, to)
          if (hi <= lo) continue
          const x = px(lo), width = Math.max(1, (hi - lo) * rect.scale)
          ctx.strokeStyle = colourFor(type); ctx.setLineDash([3, 2]); ctx.lineWidth = 1
          ctx.strokeRect(Math.round(x) + .5, laneTop + MODEL_TOP - 2.5, Math.max(1, width - 1), CDS_HEIGHT + 4)
        }
        ctx.setLineDash([]); ctx.restore()
      }

      // -- this row's own models --------------------------------------------
      if (!entry?.genes?.length) {
        const text = zoomRequired ? 'Zoom in to load gene models and comparisons' : emptyLaneReason(entry, row)
        if (rect.width > 120 && laneHeight >= 12) {
          ctx.fillStyle = colors.muted; ctx.font = '10px Lato, sans-serif'
          const measuring = against && !measured && comparisonPending ? ' · measuring the comparison…' : ''
          ctx.fillText((pending && !entry && !zoomRequired ? 'Loading annotation…' : text) + measuring, textX(rect.x + 8), laneTop + MODEL_TOP + 9)
        }
        return
      }
      for (const {gene, transcript, lane, start: modelStart, end: modelEnd} of annotationModels(entry).items) {
          const modelTop = laneTop + MODEL_TOP + lane * MODEL_PITCH
          const picked = detail.picks?.[rowId] === transcript.transcript_id
          const ordered = [...transcript.features].sort((a, b) => (FEATURE_ORDER[a.type] ?? 0) - (FEATURE_ORDER[b.type] ?? 0))
          // The spine first: one line across the whole model, so an intron
          // reads as a join rather than as absent sequence.
          const [spineFrom, spineTo] = clipRange(modelStart, modelEnd, from, to)
          if (spineTo > spineFrom) {
            ctx.fillStyle = colors.border
            ctx.fillRect(px(spineFrom), modelTop + CDS_HEIGHT / 2, (spineTo - spineFrom) * rect.scale, 1)
          }
          for (const feature of ordered) {
            const height = FEATURE_HEIGHT[feature.type] ?? EXON_HEIGHT
            const top = modelTop + (CDS_HEIGHT - height) / 2
            // Pieces, not the envelope. A gap inside a feature is another row's
            // insertion, and filling it would draw exon where this row has no
            // base at all.
            for (const piece of feature.pieces) {
              const [lo, hi] = clipRange(piece.start, piece.end, from, to)
              if (hi <= lo) continue
              const x = px(lo), width = Math.max(.75, (hi - lo) * rect.scale)
              if (picked && feature.type !== 'intron' && feature.type !== 'exon') {
                ctx.save(); ctx.globalAlpha = .2; ctx.fillStyle=colourFor(feature.type)
                ctx.fillRect(x,laneTop-ROW_HEIGHT+1,width,24); ctx.restore()
              }
              ctx.fillStyle = colourFor(feature.type)
              if (feature.type === 'intron') { ctx.fillRect(x, top, width, 1); continue }
              if (width < MIN_MODEL_WIDTH) { ctx.fillRect(x, top, Math.max(1, width), height); continue }
              // A UTR is the same exon drawn hollow, as the browser draws it.
              if (feature.type === 'utr5' || feature.type === 'utr3') {
                ctx.fillStyle = colors.background; ctx.fillRect(x, top, width, height)
                ctx.strokeStyle = colourFor(feature.type); ctx.lineWidth = 1
                ctx.strokeRect(Math.round(x) + .5, top + .5, Math.max(1, width - 1), height - 1)
              } else ctx.fillRect(x, top, width, height)
            }
            // Where a feature runs past the block or the loaded window, say so
            // rather than letting the clip read as the end of the feature.
            if (feature.clipped_start && feature.start >= from && feature.start <= to) markClipped(ctx, px(feature.start), top, height, -1, colors)
            if (feature.clipped_end && feature.end >= from && feature.end <= to) markClipped(ctx, px(feature.end), top, height, 1, colors)
            // A feature wide enough to point at is a feature that can be
            // measured. An intron is not offered: it is the space between two
            // exons, and measuring "the columns of the space" is not a question
            // anyone is asking.
            if (feature.type !== 'intron') {
              const [ha, hz] = clipRange(feature.start, feature.end, from, to)
              const featureWidth = (hz - ha) * rect.scale
              if (hz > ha && featureWidth >= 4) {
                const selected = chosen && chosen.rowId === rowId && chosen.type === feature.type &&
                  chosen.pieces?.[0]?.start === feature.pieces[0]?.start
                if (selected) {
                  ctx.strokeStyle = light ? '#1f2d3d' : '#f2f6fb'; ctx.lineWidth = 1
                  ctx.strokeRect(Math.round(px(ha)) - .5, top - 1.5, featureWidth + 1, height + 3)
                }
                hits.push({ kind: 'feature', rowId, fragmentId: fragment.id,
                  geneId: gene.gene_id, transcriptId: transcript.transcript_id,
                  feature: { rowId, transcriptId: transcript.transcript_id, geneId: gene.gene_id,
                    type: feature.type, pieces: feature.pieces, genomic: feature.genomic,
                    clipped: !!(feature.clipped_start || feature.clipped_end),
                    start: feature.start, end: feature.end },
                  label: `${gene.gene_name} ${feature.type.toUpperCase()} · ${feature.genomic.end - feature.genomic.start} bp of genome over ${feature.end - feature.start} alignment columns`,
                  x: px(ha), y: top - 1, width: Math.max(4, featureWidth), height: height + 2 })
              }
            }
          }
          const [hitFrom, hitTo] = clipRange(modelStart, modelEnd, from, to)
          if (hitTo > hitFrom) {
            const x = px(hitFrom), width = (hitTo - hitFrom) * rect.scale
            if (picked) {
              ctx.strokeStyle = colourFor('cds'); ctx.lineWidth = 1
              ctx.strokeRect(Math.round(x) - 1.5, modelTop - 3.5, width + 3, CDS_HEIGHT + 6)
            }
            hits.push({ kind: 'transcript', rowId, fragmentId: fragment.id,
              geneId: gene.gene_id, transcriptId: transcript.transcript_id,
              label: `${gene.gene_name} · ${transcript.transcript_id}${transcript.representative ? ' (representative)' : transcript.is_canonical ? ' (canonical)' : ''}`,
              x, y: modelTop - 3, width: Math.max(4, width), height: CDS_HEIGHT + 6 })
            if (width > 38) {
              ctx.fillStyle = colors.muted; ctx.font = monoFont(9)
              ctx.save(); ctx.beginPath(); ctx.rect(x, modelTop + CDS_HEIGHT, width, 13); ctx.clip()
              ctx.fillText(`${gene.gene_name} ${(transcript.strand||'+')===(row?.strand||'+')?'→':'←'}`, textX(x + 2), modelTop + CDS_HEIGHT + 10); ctx.restore()
            }
          }
      }
    })
    ctx.restore()
  }
  // -- the names, in a fixed gutter -------------------------------------------
  // Block context is about which genome is which, so a name may not scroll off
  // the side with the block it belongs to. The gutter is painted over the sheet
  // exactly as Original's is, and for the same reason.
  ctx.fillStyle = colors.background
  ctx.fillRect(0, 0, MARGIN_X, size.height)
  ctx.strokeStyle = colors.border
  ctx.beginPath(); ctx.moveTo(MARGIN_X - .5, 0); ctx.lineTo(MARGIN_X - .5, size.height); ctx.stroke()
  const byId = new Map((inventory || []).map(row => [row.id, row]))
  for (const fragment of layer.fragments) {
    const rect = panelRect(fragment, camera)
    ctx.save(); ctx.beginPath(); ctx.rect(0, fragment.pinned ? 0 : pinnedBottom(layer, camera), MARGIN_X, size.height); ctx.clip()
    fragment.rowIds.forEach((rowId, index) => {
      const slot = fragment.slots?.[index] ?? index
      const y = rect.y + slot * ROW_HEIGHT
      if (y > size.height || y + ROW_HEIGHT < 0) return
      const label = byId.get(rowId)?.label || byId.get(rowId)?.source || rowId
      const isReference = rowId === reference
      if (isReference) {
        ctx.fillStyle = light ? '#fdf3dc' : '#2c2716'
        ctx.fillRect(2, y + 2, MARGIN_X - 6, ROW_HEIGHT - 4)
      }
      ctx.fillStyle = colors.text
      ctx.font = `${isReference ? '600 ' : ''}11px Lato, sans-serif`
      ctx.textAlign = 'right'
      let text = label
      const room = MARGIN_X - 16
      if (ctx.measureText(text).width > room) {
        while (text.length > 2 && ctx.measureText(text + '…').width > room) text = text.slice(0, -1)
        text += '…'
      }
      ctx.fillText(text, MARGIN_X - 8, y + 17)
      ctx.textAlign = 'left'
      hits.push({ kind: 'label', rowId, fragmentId: fragment.id, x: 0, y, width: MARGIN_X, height: ROW_HEIGHT })
      // What this row is read against, under its name, so the direction of every
      // band and every guide beside it is never in doubt.
      const against = comparatorFor(detail, rowId)
      ctx.fillStyle = colors.muted
      ctx.font = '9px Lato, sans-serif'
      ctx.textAlign = 'right'
      ctx.fillText(isReference && detail.mode === 'reference' ? 'reference' : against ? `vs ${(byId.get(against)?.label || against).slice(0, 18)}` : 'not compared',
        MARGIN_X - 8, y + ROW_HEIGHT + 8)
      ctx.textAlign = 'left'
    })
    ctx.restore()
  }
  ctx.restore()
  return orderedContextHits(hits)
}

/** A feature that carries on past what is drawn: a notch on the edge it leaves,
 * never a clean end. */
function markClipped(ctx, x, top, height, direction, colors) {
  ctx.save(); ctx.fillStyle = colors.muted
  ctx.beginPath()
  ctx.moveTo(x, top); ctx.lineTo(x + 4 * direction, top + height / 2); ctx.lineTo(x, top + height)
  ctx.closePath(); ctx.fill(); ctx.restore()
}
