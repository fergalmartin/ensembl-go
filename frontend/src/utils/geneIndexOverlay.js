// The gene track while its index is still being built.
//
// A genome can be browsed the moment its assembly is known — the ruler, the
// regions, the sequence track all come from the FASTA. Only the genes wait for
// the index, and on a large annotation that is minutes. So the panel opens on a
// real browser with an empty gene track and a note saying what is happening,
// rather than holding the whole view behind a spinner.
//
// Two things about that note matter more than they sound. It must not move: the
// user pans and zooms while they wait, and a message anchored to the genes drifts
// off screen the moment they do. And the gene track must not resize underneath
// it: laid out from its contents the track collapses to its minimum when empty,
// so the message would sit in a sliver and then everything below it would jump
// when the genes arrived.

/** Height held by each gene track while its index builds, in CSS pixels. */
export const GENE_INDEX_TRACK_HEIGHT = 104

/** States in which genes are on their way and the track should hold its height. */
const PENDING_STATES = new Set(['building', 'queued', 'absent'])

function isGeneIndexPending(status) {
  return PENDING_STATES.has(String(status?.state || ''))
}

function isGeneIndexFailed(status) {
  return String(status?.state || '') === 'failed'
}

/**
 * Should the gene tracks hold a fixed height rather than shrink to their
 * (empty) contents? True whenever the genes are coming or the build failed —
 * a failed build has a message to show in the same place.
 */
export function shouldHoldGeneTrackHeight(status) {
  return isGeneIndexPending(status) || isGeneIndexFailed(status)
}

/**
 * The band the message is centred in: the forward and reverse gene tracks
 * together, ignoring whichever of them the user has hidden.
 *
 * Returns null when neither is on screen, which is the signal not to draw it —
 * with both gene tracks hidden there is nothing the message would be about.
 */
export function geneIndexOverlayBand({
  forwardY = 0,
  forwardHeight = 0,
  reverseY = 0,
  reverseHeight = 0,
} = {}) {
  const bands = []
  if (forwardHeight > 0) bands.push([forwardY, forwardY + forwardHeight])
  if (reverseHeight > 0) bands.push([reverseY, reverseY + reverseHeight])
  if (bands.length === 0) return null

  const top = Math.min(...bands.map(([start]) => start))
  const bottom = Math.max(...bands.map(([, end]) => end))
  return { top, height: Math.max(0, bottom - top) }
}

const STAGE_LABELS = {
  parsing: 'Reading the annotation',
  writing: 'Writing transcripts',
}

/**
 * The copy and the meter reading for a given index status.
 *
 * `percent` is null when there is no meaningful fraction to show yet, which the
 * overlay renders as an indeterminate ring rather than a misleading zero.
 */
export function describeGeneIndexStatus(status) {
  const state = String(status?.state || '')
  const rawPercent = Number(status?.percent)
  const percent = Number.isFinite(rawPercent) ? Math.max(0, Math.min(100, rawPercent)) : null
  const position = Number(status?.queue_position) || 0
  const length = Number(status?.queue_length) || 0
  const genes = Number(status?.genes) || 0

  if (state === 'failed') {
    return {
      tone: 'error',
      title: 'Gene index could not be built',
      message: String(status?.error || status?.detail || 'The annotation could not be read.'),
      percent: null,
      showRetry: true,
    }
  }

  if (state === 'queued') {
    // Indexing is serial on purpose, so a second genome really does wait for
    // the first. Saying where it is in the line is the difference between a
    // wait and an apparent hang.
    const place = position > 1 ? ` — ${position} of ${length} in the queue` : ''
    return {
      tone: 'waiting',
      title: 'Gene index queued',
      message: `Waiting for another genome to finish indexing${place}.`,
      percent: null,
      showRetry: false,
    }
  }

  if (state === 'building') {
    const stage = STAGE_LABELS[String(status?.stage || '')] || 'Building the gene index'
    const found = genes > 0 ? `${genes.toLocaleString()} genes so far.` : 'Scanning for genes.'
    return {
      tone: 'building',
      title: stage,
      message: found,
      percent,
      showRetry: false,
    }
  }

  return {
    tone: 'waiting',
    title: 'Preparing the gene index',
    message: 'The gene track fills in as soon as the index is ready.',
    percent: null,
    showRetry: false,
  }
}
