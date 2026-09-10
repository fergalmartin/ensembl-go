import {
  DEEP_GENES_REGION,
  HAO2_REGION,
  OPENING_REGION,
  REG4,
  REG4_GENE_REGION,
  REG4_REGION,
  SLICE_WHOLE_REGION,
  TBX15,
  TBX15_EXON_VIEW,
  TBX15_REGION,
  TBX15_SEQUENCE_REGION,
  TBX15_WIDE_REGION,
} from './sliceGenome.js'

// The second tutorial: the genome browser, properly.
//
// Getting Started passes through the browser in four steps, on a twenty-two kilobase
// genome whose six genes have one transcript each. That is enough to show that the
// browser exists and nothing else — there is no second biotype to filter, no transcript
// layout to flatten, and no sequence worth zooming into.
//
// So this one runs on 1.68 megabases of real GRCh38 chromosome 1, at its true
// coordinates, with its real Ensembl annotation. Everything the steps below claim about
// that region — REG4's five transcripts, PHGDH's thirty-eight, the four gene classes — is
// checked against the bundled annotation by backend/tests/test_grch38_slice.py, so the
// copy cannot quietly go stale.
//
// Three things about the steps are worth knowing before editing them.
//
// **Every step declares the state it expects, in `arrive`.** That is what makes the
// tutorial re-watchable. A card that says "PHGDH has thirty-eight transcripts" has to be
// able to put PHGDH on screen, because Back is the first thing anyone presses when they
// miss something — and a step that only *described* where it had got to would, on the way
// back, describe wherever the user happened to be. `arrive` runs on every visit, forwards
// or backwards, so it sets rather than toggles.
//
// **The search box empties itself on a successful search** (`jumpToRange` calls
// `setSearchInput('')`), so no step here can use an `input` advance on it — the field
// never holds the value it was given. Gene searches wait on `browser.geneFocused` and
// region searches on `browser.regionSearched`, which means someone who types the region
// and presses Return moves straight on rather than watching the tutorial retype it.
//
// **Moving about uses the `browserView` action.** The browser has no zoom button and no
// slider, so there is nothing for a tutorial to click. Those steps stay interactive, so
// the user can drag and scroll the real track, and Next drives the browser's own animated
// move for them — unless they have already moved it themselves, which `skipIfMoved`
// leaves alone. See docs/TUTORIALS.md.

// Every step that lights up the whole track puts its card here: above the panel, clear of
// whatever the tracks are doing. Pinned, so it stays put as they grow and shrink.
const ABOVE_THE_BROWSER = { selector: '[data-browser-canvas-surface]' }
const SHOW_BROWSER_TRACK = { anchor: ABOVE_THE_BROWSER }
const SHOW_TRANSCRIPT_DETAIL = { anchor: { selector: '[data-focus-transcript-detail]' } }
const SHOW_FOCUS_DRAWER = { anchor: { selector: '[data-focus-drawer="true"]' } }

const SLICE = ['slice-genome-installed', 'slice-genome-active']
const FOCUSED = [...SLICE, 'reg4-gene-focused']

/** The transcript layout every step outside the Detail/Flatten section expects. */
const PLAIN_LAYOUT = { type: 'browserControls', detail: false, flatten: false, expanded: false }

const at = (locus) => ({ type: 'browserView', locus })

// One gene's own transcripts, which is not the window-wide expand control: the `+N` pill
// under a gene sets that gene alone, and a step about the pill has to be able to say which
// side of it the gene is on.
const TBX15_TRANSCRIPTS_PILL = `browser-gene-transcripts-${TBX15.id}`
const REG4_HIDDEN_TRANSCRIPTS_LABEL = `browser-gene-hidden-transcripts-${REG4.id}`
const EXPAND_TBX15 = { type: 'browserControls', geneTranscripts: { gene: TBX15.id, expanded: true } }
/** REG4-204 hidden, which is what puts the "Show 1 hidden" label on the gene. */
const REG4_TRANSCRIPT_HIDDEN = {
  type: 'browserControls',
  drawerTranscripts: 'expanded',
  hiddenTranscript: { transcript: REG4.hideableTranscript, hidden: true },
}
/** REG4-204 back on the track. The step that asks the reader to hide it has to *arrive*
 *  with it showing, or walking back into that step finds the job already done: the button
 *  still reading "hidden", the label still on the gene, and nothing left to demonstrate. */
const REG4_TRANSCRIPT_SHOWN = {
  type: 'browserControls',
  drawerTranscripts: 'expanded',
  hiddenTranscript: { transcript: REG4.hideableTranscript, hidden: false },
}
const COLLAPSE_TBX15 = { type: 'browserControls', geneTranscripts: { gene: TBX15.id, expanded: false } }

// Chapters are part of the tutorial's authored narrative rather than inferred from the
// controls a step happens to use. Keeping the labels here makes the boundaries explicit,
// keeps repeated wording consistent, and lets the overlay and catalogue share one source.
const SECTION = Object.freeze({
  orientation: 'Getting oriented',
  controls: 'General controls',
  navigation: 'Moving through the genome',
  transcripts: 'Displaying transcripts',
  filters: 'Filtering gene types',
  focus: 'Focusing on a gene',
  detail: 'Browsing a gene in detail',
  notes: 'Adding notes',
  finish: 'Wrapping up',
})

export default {
  id: 'browser-in-depth',
  title: 'The Genome Browser',
  blurb: 'Tracks, panning, zooming down to the bases, transcript layout, gene-class '
    + 'filters, the focus drawer and notes — on a real slice of human chromosome 1. Runs on '
    + 'temporary data and leaves your own setup untouched.',
  estimatedMinutes: 10,
  usesDemoGenome: true,
  // The state every step assumes, established on arrival at each of them. Zooming and
  // expanding transcripts change how tall the tracks are, and a step that inherited a
  // layout from three steps ago finds its anchors somewhere else entirely — which is how
  // a spotlight ends up around a patch of empty track. A step that wants something else
  // says so, and its own arrival runs second.
  defaultArrive: [{ type: 'browserControls', detail: false, flatten: false, expanded: false }],
  completionBody: 'Well done on completing the Genome Browser tutorial.',

  steps: [
    {
      id: 'welcome',
      section: SECTION.orientation,
      placement: 'center',
      title: 'A closer look at the genome browser',
      body: 'This tutorial covers the genome browser in more detail. It doesn\'t cover every '
        + 'possible feature or control, but is designed to help you get proficient in the '
        + 'basics of browsing.',
    },
    {
      id: 'open-browser',
      section: SECTION.orientation,
      view: 'genome_browser',
      anchor: 'app-button-genome_browser',
      placement: 'bottom',
      ensure: SLICE,
      title: 'Open the Genome Browser',
      body: 'Click the highlighted icon in the apps list to open the genome browser. We\'ll be '
        + 'looking at a small region of chromosome 1 on GRCh38, learning the basic controls and '
        + 'the different tracks and features.',
      advanceOn: { type: 'view', view: 'genome_browser' },
    },
    {
      id: 'the-track',
      section: SECTION.orientation,
      view: 'genome_browser',
      anchor: ABOVE_THE_BROWSER,
      placement: 'top',
      interactive: false,
      ensure: SLICE,
      arrive: [at(OPENING_REGION), PLAIN_LAYOUT],
      title: 'About the data',
      body: 'We\'ve loaded a megabase of chromosome 1, highlighted below with its tracks and a '
        + 'ruler along the top marking the position on the genome. At this zoom the window '
        + 'holds several genes, each drawn as a solid block.',
    },
    {
      id: 'global-controls',
      section: SECTION.controls,
      view: 'genome_browser',
      anchor: 'browser-global-controls',
      placement: 'bottom',
      interactive: false,
      ensure: SLICE,
      arrive: at(OPENING_REGION),
      title: 'The general controls',
      body: 'The general control bar applies to every active genome at once. Here there is only '
        + 'GRCh38, but several genomes can be active together, and some of these controls only '
        + 'appear when more than one is.',
    },
    {
      id: 'genome-controls',
      section: SECTION.controls,
      view: 'genome_browser',
      anchor: { selector: '[data-browser-toolbar]' },
      placement: 'bottom',
      interactive: false,
      ensure: SLICE,
      arrive: at(OPENING_REGION),
      title: 'Genome specific controls',
      body: 'Each active genome also has its own control bar; the one for GRCh38 is highlighted '
        + 'above. These search for features, change location, and change what is displayed for '
        + 'that genome alone.',
    },
    {
      id: 'region-select',
      section: SECTION.controls,
      view: 'genome_browser',
      anchor: 'browser-region-select',
      placement: 'bottom',
      interactive: false,
      ensure: SLICE,
      arrive: at(OPENING_REGION),
      title: 'Region select',
      body: 'The above dropdown can be used to move between the different primary regions '
        + 'within the genome. Regions that are <5kb are filtered out of the list, however '
        + 'these are still accessible via search.',
    },
    {
      id: 'search',
      section: SECTION.controls,
      // The box and its go button together, not the box alone. They are one control to a
      // reader, and lighting only the field leaves the button that submits it dimmed —
      // which matters here because the field empties itself the moment it is used.
      view: 'genome_browser',
      anchor: 'browser-location-search-field',
      // Beside the box rather than under it, bottom edges level, and pinned there: the
      // step lights up the whole track, and a card placed to clear that moves every time
      // the track's rectangle does — which is while you are reading it.
      placement: 'left',
      align: 'end',
      // The lit region holds two controls, so it names them: the document form needs to
      // say which are usable, and a region has no capability of its own to derive it from.
      allow: [
        { anchor: 'browser-location-search', capability: 'input' },
        { anchor: 'browser-location-search-go', capability: 'activate' },
      ],
      // The track is the thing that answers, so it is lit rather than dimmed while this
      // happens. Lit, not opened: the blocker bands still cover it.
      reveal: SHOW_BROWSER_TRACK,
      ensure: SLICE,
      arrive: at(OPENING_REGION),
      title: 'Search a region',
      body: 'The box takes a gene name or a region. Press the value below to drop it into the '
        + 'box, then hit Return or use the search button beside it to jump to the region. '
        + 'These coordinates frame HAO2 and some flanking sequence.',
      // Offered rather than quoted in the body: a coordinate string is a typo waiting to
      // happen, and nobody would type one out in earnest either.
      copy: HAO2_REGION,
      // And the chip puts it in the box rather than on the clipboard. Copying is only
      // half a step here: the app's right-click menu is not the browser's, so the gesture
      // anyone would reach for does nothing and only Command-V works, which nothing says.
      copyInto: 'browser-location-search',
      // Overwrites deliberately: only a location this genome contains will resolve. And
      // skipped entirely when the browser is already there — someone who has pasted the
      // region themselves should not have the tutorial type over their work; Next just
      // moves on.
      action: { type: 'type', anchor: 'browser-location-search', value: HAO2_REGION, submit: true, overwrite: true, skipIfShowing: HAO2_REGION },
      // The search landing is what finishes the step, whoever caused it. Waiting on the
      // box itself cannot work — it empties on a successful search — and waiting for Next
      // left anyone who pressed Return looking at the region they asked for beside a card
      // that still wanted something. `holdMs` is the beat that keeps the new view on
      // screen before the step moves on, since the result appears away from the control.
      advanceOn: { type: 'signal', name: 'browser.regionSearched' },
      holdMs: 2000,
      cardPosition: { x: 0.016, y: 0.069 },
    },
    {
      // The result of the step before it, which is the beat a tutorial most often leaves
      // out: the search was the task, and where it landed is the answer. Look-only —
      // there is nothing to do here but see that it worked.
      id: 'search-result',
      section: SECTION.controls,
      view: 'genome_browser',
      anchor: ABOVE_THE_BROWSER,
      placement: 'top',
      interactive: false,
      ensure: SLICE,
      // Declared rather than inherited, so the card is true when the step is jumped to
      // directly as well as when it is walked into.
      arrive: at(HAO2_REGION),
      title: 'HAO2 region',
      body: 'The browser has moved to the region copied into the search box, centered on HAO2. A '
        + 'region search frames those coordinates exactly in the browser track.',
      cardPosition: { x: 0.0177, y: 0.0716 },
    },
    {
      id: 'track-gutter',
      section: SECTION.controls,
      view: 'genome_browser',
      anchor: 'browser-track-gutter',
      placement: 'right',
      interactive: false,
      ensure: SLICE,
      arrive: at(HAO2_REGION),
      title: 'The left hand menu',
      body: 'This section controls the tracks. GF is genes on the forward strand, GR genes on the '
        + 'reverse, and SL the sequence level, which appears once you zoom far enough in. The '
        + 'power buttons toggle a track; drag to reorder them.',
    },
    {
      id: 'moving-about',
      section: SECTION.navigation,
      view: 'genome_browser',
      anchor: ABOVE_THE_BROWSER,
      placement: 'top',
      ensure: SLICE,
      // Zoomed in, which is the point: a step about zooming out needs somewhere to zoom
      // out from, and starting on the whole slice left the first half of the move with
      // nothing to show.
      arrive: at(HAO2_REGION),
      title: 'Panning and zooming',
      body: 'By default a two-finger swipe up or down (or the mouse wheel) zooms, and '
        + 'click-and-drag or a sideways swipe pans. Other schemes are available in the '
        + 'configuration menu. Try panning and zooming before moving on.',
      // Out, across, and back in, so where the gene *is* is something watched rather than
      // arrived at. Left alone entirely if the user has already gone somewhere themselves.
      action: { type: 'browserView', moves: [{ type: 'browserView', locus: SLICE_WHOLE_REGION }, { type: 'browserView', locus: TBX15_WIDE_REGION }, { type: 'browserView', locus: TBX15_REGION }], pauseMs: 1500, skipIfMoved: true },
    },
    {
      id: 'transcript-detail',
      section: SECTION.navigation,
      view: 'genome_browser',
      anchor: ABOVE_THE_BROWSER,
      placement: 'top',
      // The spotlight is the whole track, so there is nowhere for the card to go that is
      // not over the genes being described. Placed above the panel instead — pinned there,
      // so it stays put however tall the tracks grow.
      placeAgainst: ABOVE_THE_BROWSER,
      interactive: false,
      ensure: SLICE,
      arrive: [at(TBX15_REGION), PLAIN_LAYOUT],
      title: 'Genes and transcripts',
      body: 'Here we\'ve centered on TBX15, which has three transcripts; only the canonical one is '
        + 'drawn by default. It has several exons, and the gene is on the reverse strand — the '
        + 'GR track.',
    },
    {
      // The pill under the gene, which is DOM over the canvas rather than painted on it —
      // so it can be anchored directly, unlike the track switches in the gutter.
      id: 'gene-transcripts-expand',
      section: SECTION.navigation,
      view: 'genome_browser',
      anchor: TBX15_TRANSCRIPTS_PILL,
      placement: 'right',
      reveal: SHOW_BROWSER_TRACK,
      ensure: SLICE,
      // The gene's own transcripts are a separate control from the window-wide expand
      // above, so they are declared separately — collapsed here, so returning to this step
      // shows the pill being pressed rather than one already pressed.
      arrive: [at(TBX15_REGION), PLAIN_LAYOUT, COLLAPSE_TBX15],
      title: 'Viewing alternative transcripts',
      body: 'The tag under the gene counts the transcripts it is not currently showing: two more '
        + 'for TBX15. Click the label to show them.',
      advanceOn: { type: 'click' },
    },
    {
      id: 'gene-transcripts-expanded',
      section: SECTION.navigation,
      view: 'genome_browser',
      anchor: ABOVE_THE_BROWSER,
      placement: 'top',
      placeAgainst: ABOVE_THE_BROWSER,
      interactive: false,
      ensure: SLICE,
      arrive: [at(TBX15_REGION), PLAIN_LAYOUT, EXPAND_TBX15],
      title: 'The expanded transcript set',
      body: 'All three TBX15 transcripts are drawn now, one under the other. The reverse track '
        + 'has grown taller to display them.',
    },
    {
      id: 'gene-transcripts-flatten',
      section: SECTION.navigation,
      view: 'genome_browser',
      anchor: 'browser-flatten',
      placement: 'right',
      align: 'end',
      reveal: SHOW_BROWSER_TRACK,
      ensure: SLICE,
      arrive: [
        at(TBX15_REGION),
        { type: 'browserControls', detail: false, flatten: false, expanded: false },
        EXPAND_TBX15,
      ],
      title: 'Flatten to compact',
      body: 'The Flatten button reduces the space between transcript rows, which helps a gene '
        + 'with several of them fit more neatly in the track. Try clicking it now.',
      advanceOn: { type: 'click' },
    },
    {
      id: 'gene-transcripts-collapse',
      section: SECTION.navigation,
      view: 'genome_browser',
      anchor: TBX15_TRANSCRIPTS_PILL,
      placement: 'right',
      cardPosition: { x: 0.2569, y: 0.5382 },
      reveal: SHOW_BROWSER_TRACK,
      ensure: SLICE,
      // Flatten stays on through this step and the next. Turning it off here would undo
      // the result of the step before it while the reader was still looking at it, and
      // make the collapse below two changes at once instead of one.
      arrive: [
        at(TBX15_REGION),
        { type: 'browserControls', detail: false, flatten: true, expanded: false },
        EXPAND_TBX15,
      ],
      title: 'Hiding the alternatives again',
      body: 'If you want to remove the alternative transcripts and revert to just the '
        + 'canonical, you can use the X label. Try clicking it now.',
      advanceOn: { type: 'click' },
    },
    {
      id: 'gene-transcripts-collapsed',
      section: SECTION.navigation,
      view: 'genome_browser',
      anchor: ABOVE_THE_BROWSER,
      placement: 'top',
      cardPosition: { x: 0.3678, y: 0.5382 },
      placeAgainst: ABOVE_THE_BROWSER,
      interactive: false,
      ensure: SLICE,
      arrive: [
        at(TBX15_REGION),
        { type: 'browserControls', detail: false, flatten: true, expanded: false },
        COLLAPSE_TBX15,
      ],
      title: 'Canonical only',
      body: 'We\'re now back to having just the canonical transcript and the label has changed '
        + 'back to the hidden transcript count.',
    },
    {
      id: 'zoom-sequence',
      section: SECTION.navigation,
      view: 'genome_browser',
      anchor: ABOVE_THE_BROWSER,
      placement: 'top',
      placeAgainst: ABOVE_THE_BROWSER,
      interaction: 'zoom-only',
      ensure: SLICE,
      arrive: at(TBX15_EXON_VIEW),
      title: 'Viewing the sequence level',
      body: 'Try zooming in on the browser window below to bring up the sequence track. At 1kb or '
        + 'less it appears as coloured blocks for the bases, and zooming further still prints '
        + 'the single-letter code on each block.',
      action: { type: 'browserView', durationMs: 2400, pauseMs: 1800, skipIfMoved: true, skipIfSequenceVisible: true, locus: TBX15_SEQUENCE_REGION },
    },
    {
      id: 'deep-genes',
      section: SECTION.transcripts,
      view: 'genome_browser',
      anchor: ABOVE_THE_BROWSER,
      placement: 'top',
      cardPosition: { x: 0.3631, y: 0.0155 },
      interactive: false,
      ensure: SLICE,
      arrive: [at(DEEP_GENES_REGION), PLAIN_LAYOUT],
      title: 'Further compacting transcript information',
      body: 'PHGDH on the left has thirty-eight transcripts and HMGCS2 on the right has '
        + 'twenty-two — more than the window can show at once, even flattened. You can scroll '
        + 'to see the rest, but the next control helps more.',
    },
    {
      id: 'expand-transcripts',
      section: SECTION.transcripts,
      view: 'genome_browser',
      anchor: 'browser-expand-transcripts',
      placement: 'right',
      align: 'end',
      reveal: SHOW_BROWSER_TRACK,
      ensure: SLICE,
      arrive: [at(DEEP_GENES_REGION), PLAIN_LAYOUT],
      title: 'Show every transcript',
      body: 'The Expand Transcripts button expands every gene in the window at once, rather than '
        + 'clicking the ‘+’ label on each one. Try clicking it now.',
      advanceOn: { type: 'click' },
      cardPosition: { x: 0.6059, y: 0.0298 },
    },
    {
      id: 'expanded-transcripts',
      section: SECTION.transcripts,
      view: 'genome_browser',
      anchor: 'browser-expand-transcripts',
      placement: 'top',
      placeAgainst: ABOVE_THE_BROWSER,
      interactive: false,
      reveal: SHOW_BROWSER_TRACK,
      ensure: SLICE,
      arrive: [at(DEEP_GENES_REGION), { type: 'browserControls', detail: false, flatten: false, expanded: true }],
      title: 'All the transcript rows',
      body: 'Every transcript now has its own row. There are so many here that they run off the '
        + 'bottom of the window, and you have to scroll to see them all. The next control gets '
        + 'around that.',
      cardPosition: { x: 0.02, y: 0.02 },
    },
    {
      id: 'detail',
      section: SECTION.transcripts,
      view: 'genome_browser',
      anchor: 'browser-detail',
      placement: 'right',
      align: 'end',
      reveal: SHOW_BROWSER_TRACK,
      ensure: SLICE,
      arrive: [at(DEEP_GENES_REGION), { type: 'browserControls', detail: false, flatten: false, expanded: true }],
      title: 'The Detail button',
      body: 'The Detail button packs the rows closer together and shortens the exons, fitting far '
        + 'more into the same space. It is how you get an overall picture of a gene with a lot '
        + 'of transcripts. Try clicking it now.',
      advanceOn: { type: 'click' },
    },
    {
      id: 'detail-result',
      section: SECTION.transcripts,
      view: 'genome_browser',
      anchor: 'browser-detail',
      placement: 'right',
      align: 'end',
      interactive: false,
      reveal: SHOW_BROWSER_TRACK,
      ensure: SLICE,
      arrive: [at(DEEP_GENES_REGION), { type: 'browserControls', detail: true, flatten: false, expanded: true }],
      title: 'Highly compacted transcripts',
      body: 'Every transcript is still there, but the rows and labels are packed much more '
        + 'tightly. You lose the fine detail of any one transcript and gain the shape of the '
        + 'whole set.',
      cardPosition: { x: 0.2723, y: 0.0216 },
    },
    {
      id: 'detail-off',
      section: SECTION.transcripts,
      view: 'genome_browser',
      anchor: 'browser-detail',
      placement: 'right',
      align: 'end',
      reveal: SHOW_BROWSER_TRACK,
      ensure: SLICE,
      arrive: [at(DEEP_GENES_REGION), { type: 'browserControls', detail: true, flatten: false, expanded: true }],
      title: 'Turn Detail off again',
      body: 'Detail and Flatten solve different layout problems, so we will demonstrate them '
        + 'separately. Click Detail again, or press Next, to restore the normal transcript '
        + 'spacing before moving on.',
      advanceOn: { type: 'click' },
    },
    {
      id: 'layout-back',
      section: SECTION.transcripts,
      view: 'genome_browser',
      anchor: 'browser-expand-transcripts',
      placement: 'right',
      cardPosition: { x: 0.6135, y: 0.0155 },
      align: 'end',
      reveal: SHOW_BROWSER_TRACK,
      ensure: SLICE,
      arrive: [
        at(DEEP_GENES_REGION),
        { type: 'browserControls', detail: false, flatten: false, expanded: true },
      ],
      title: 'Collapsing all transcripts in the window',
      body: 'Everything is still expanded from earlier. The button\'s icon has changed to a single '
        + 'transcript with an arrow below it: it now collapses every gene in the window back to '
        + 'its canonical transcript. Try clicking it now.',
      advanceOn: { type: 'click' },
    },

    // ── Gene classes ───────────────────────────────────────────────────────
    {
      id: 'gene-classes',
      section: SECTION.filters,
      view: 'genome_browser',
      anchor: 'browser-biotype-filter',
      placement: 'left',
      cardPosition: { x: 0.3326, y: 0.0911 },
      align: 'end',
      reveal: SHOW_BROWSER_TRACK,
      interactive: false,
      ensure: SLICE,
      arrive: [
        at(DEEP_GENES_REGION),
        { type: 'browserControls', detail: false, flatten: false, expanded: false, biotypes: 'all' },
      ],
      title: 'Classes of gene',
      body: 'On the far right of the general control bar there are also controls for '
        + 'showing/hiding different classes of genes.',
    },
    {
      id: 'only-protein-coding',
      section: SECTION.filters,
      view: 'genome_browser',
      anchor: 'browser-biotype-filter',
      placement: 'left',
      cardPosition: { x: 0.3273, y: 0.0672 },
      align: 'end',
      reveal: SHOW_BROWSER_TRACK,
      ensure: SLICE,
      arrive: [at(DEEP_GENES_REGION), { type: 'browserControls', biotypes: 'all' }],
      // The one box the step asks for, and only that one: the spotlight is the whole grid,
      // which has no capability of its own, so without this the document form makes the
      // step look-only and the reader cannot do the thing the card asks for.
      allow: [{ anchor: 'browser-biotype-lncRNA', capability: 'activate' }],
      title: 'Hide a class of gene',
      body: 'In the current window there are a mix of protein-coding and long non-coding genes. '
        + 'Try clicking the ‘Long non-coding’ checkbox to hide the long non-coding genes.',
      action: { type: 'click', anchor: 'browser-biotype-lncRNA' },
      advanceOn: { type: 'click', anchor: 'browser-biotype-lncRNA' },
    },
    {
      id: 'protein-coding-result',
      section: SECTION.filters,
      view: 'genome_browser',
      anchor: 'browser-biotype-filter',
      placement: 'left',
      cardPosition: { x: 0.3249, y: 0.0155 },
      align: 'end',
      reveal: SHOW_BROWSER_TRACK,
      interactive: false,
      ensure: SLICE,
      // The state the step before it leaves behind, not "protein-coding only": it unticks
      // one box, and an arrival that unticked the other two would undo the demonstration
      // by changing two more things the reader never touched.
      arrive: [
        at(DEEP_GENES_REGION),
        { type: 'browserControls', biotypes: ['proteinCoding', 'pseudogene', 'smallNonCoding'] },
      ],
      title: 'The window without them',
      body: 'The three long non-coding genes have left the track, while ZNF697, PHGDH and '
        + 'HMGCS2 remain. The filter changes which genes are drawn; it does not alter the '
        + 'annotation stored on disk, and ticking it again brings them back.',
    },

    // ── One gene, in depth ─────────────────────────────────────────────────
    {
      id: 'find-reg4',
      section: SECTION.focus,
      view: 'genome_browser',
      // The box and its go button together, as on the region search: the card offers both
      // ways of submitting, so both have to be inside the lit, clickable area.
      anchor: 'browser-location-search-field',
      placement: 'left',
      cardPosition: { x: 0.0379, y: 0.0155 },
      align: 'end',
      reveal: SHOW_BROWSER_TRACK,
      ensure: SLICE,
      arrive: at(DEEP_GENES_REGION),
      title: 'Search a gene symbol',
      body: 'Focusing on a gene changes several things about the window. You can focus one by '
        + 'clicking it in the track, but here we\'ll search for it: type ‘REG4’ and press '
        + 'Return, or use the search button.',
      // The lit region holds two controls, so it names them: a region carries no
      // capability of its own to derive them from.
      allow: [
        { anchor: 'browser-location-search', capability: 'input' },
        { anchor: 'browser-location-search-go', capability: 'activate' },
      ],
      action: { type: 'type', anchor: 'browser-location-search', value: REG4.symbol, overwrite: true },
      // Whoever submits it: Return, the go button, or Next. The box empties itself on a
      // successful search, so its own contents can never be waited on.
      advanceOn: { type: 'signal', name: 'browser.geneFocused' },
      // Same reasoning as the region search above: the answer — the view travelling to
      // the gene, the focus bar appearing — happens away from the box that was typed in,
      // and moving on the instant it lands leaves it unread.
      holdMs: 1800,
    },
    {
      id: 'focus-bar',
      section: SECTION.focus,
      view: 'genome_browser',
      anchor: { selector: '[data-focus-bar]' },
      placement: 'top',
      cardPosition: { x: 0.01, y: 0.0155 },
      reveal: SHOW_BROWSER_TRACK,
      // Keep the white outline that identifies the bar, but not its usual dark drop
      // shadow: on a full-width bar that shadow reads as an extra border through the
      // drawer below it.
      spotlightRingShadow: false,
      interactive: false,
      ensure: FOCUSED,
      // Going back from here clears the focus, so the search step is something to watch
      // again rather than a search box whose gene is already in focus.
      undo: 'unfocus-gene',
      arrive: at(REG4_REGION),
      title: 'The gene in focus',
      body: 'Focus brings in several things at once: red dashed lines at the gene\'s boundaries, '
        + 'the gene centered in the view, the other genes dimmed, the focus bar highlighted '
        + 'below, and a drawer on the right.',
    },
    {
      id: 'pan-away',
      section: SECTION.focus,
      view: 'genome_browser',
      anchor: { selector: '[data-browser-canvas-surface]' },
      placement: 'top',
      cardPosition: { x: 0.015, y: 0.0155 },
      placeAgainst: ABOVE_THE_BROWSER,
      ensure: FOCUSED,
      arrive: at(REG4_REGION),
      title: 'Browser away from the gene',
      body: 'A focused gene stays focused however far you travel from it. Try zooming/panning '
        + 'with the gene in focus below and then click Next when you\'re ready to continue.',
      action: { type: 'browserView', locus: SLICE_WHOLE_REGION, skipIfMoved: true },
    },
    {
      id: 'recentre',
      section: SECTION.focus,
      view: 'genome_browser',
      anchor: 'browser-recenter',
      placement: 'right',
      cardPosition: { x: 0.01, y: 0.0858 },
      align: 'end',
      reveal: SHOW_BROWSER_TRACK,
      ensure: FOCUSED,
      // Start at the maximum useful contrast: the complete slice. Recentring then changes
      // both position and scale, rather than making a small sideways correction.
      arrive: at(SLICE_WHOLE_REGION),
      title: 'Re-centering on the gene',
      body: 'The view is zoomed right out and we can no longer see REG4. You can '
        + 'automatically re-center the view on the gene of focus by clicking the crosshair '
        + 'button highlighted below.',
      // Pressing the button is the step, so pressing it finishes the step — whoever does
      // it. The three seconds are what makes that readable: the advance is held while the
      // view travels back to the gene and settles, so the result of the press is watched
      // rather than glimpsed on the way to the next card. Next (and autoplay, which is
      // Next on a timer) performs the same click, and skips it when the gene is already
      // framed — someone who has pressed it themselves is not made to watch it twice.
      action: {
        type: 'click',
        anchor: 'browser-recenter',
        skipIfFeatureFramed: REG4_GENE_REGION,
      },
      advanceOn: { type: 'click' },
      holdMs: 3000,
    },
    {
      id: 'drawer',
      section: SECTION.detail,
      view: 'genome_browser',
      anchor: { selector: '[data-focus-drawer]' },
      placement: 'left',
      interactive: false,
      ensure: FOCUSED,
      arrive: [at(REG4_REGION), { type: 'browserControls', drawerTranscripts: 'collapsed' }],
      title: 'The focus drawer',
      body: 'The drawer arrives with the focused gene. From here you can show and hide individual '
        + 'transcripts, reach the sequences associated with each one, and write notes that stay '
        + 'attached to the gene.',
    },
    {
      id: 'show-transcripts',
      section: SECTION.detail,
      view: 'genome_browser',
      anchor: 'focus-transcripts-expand',
      placement: 'top',
      cardPosition: { x: 0.6651, y: 0.1516 },
      placeAgainst: ABOVE_THE_BROWSER,
      reveal: SHOW_BROWSER_TRACK,
      ensure: FOCUSED,
      // Whether the drawer opens folded or unfolded depends on what the window-wide
      // expand control was last set to, so the step says which it wants rather than
      // assuming — otherwise its click collapses the list instead of opening it.
      arrive: [at(REG4_REGION), { type: 'browserControls', drawerTranscripts: 'collapsed' }],
      title: 'Listing all transcripts in the drawer',
      body: 'Click the highlighted downward arrow to show the full list of transcripts for '
        + 'REG4.',
      advanceOn: { type: 'click' },
    },
    {
      id: 'hide-transcript',
      section: SECTION.detail,
      view: 'genome_browser',
      anchor: `focus-transcript-hide-${REG4.hideableTranscript}`,
      placement: 'top',
      placeAgainst: ABOVE_THE_BROWSER,
      reveal: SHOW_BROWSER_TRACK,
      ensure: FOCUSED,
      arrive: [at(REG4_REGION), REG4_TRANSCRIPT_SHOWN],
      title: 'Modifying the transcript set',
      body: 'Expanding the list in the drawer expands the set in the browser window too. Click '
        + 'the highlighted show/hide button beside a transcript id to hide that transcript.',
      advanceOn: { type: 'click' },
    },
    {
      // What hiding one actually did, which is the beat between the action and the next
      // idea: the transcript leaves the track, and the only thing left saying so is a
      // small label under the gene. Look-only — restoring it here would undo the step
      // before it and leave the two steps after it describing five rows instead of four.
      id: 'hidden-transcript',
      section: SECTION.detail,
      view: 'genome_browser',
      anchor: REG4_HIDDEN_TRANSCRIPTS_LABEL,
      placement: 'top',
      placeAgainst: ABOVE_THE_BROWSER,
      interactive: false,
      reveal: SHOW_BROWSER_TRACK,
      ensure: FOCUSED,
      arrive: [at(REG4_REGION), REG4_TRANSCRIPT_HIDDEN],
      title: 'Hidden transcripts',
      body: 'Now that we\'ve hidden the transcript, the gene now has a ‘Show 1 hidden’ label, '
        + 'to allow all hidden transcripts to be shown via a single click. There is also a '
        + 'show all/hide all button in the drawer.',
    },
    {
      // Pinning, which is the drawer's third gesture after showing and hiding: clicking a
      // row anchors it, and the browser both returns to the gene's focus framing and slides
      // the drawer until the row and its transcript are level. Hover does none of that on
      // purpose — it must never move the viewport out from under the pointer. A pin is a
      // toggle rather than a step forward, so the advance stays manual: clicking again
      // releases it, and a reader who tries that should not be carried off mid-experiment.
      id: 'highlight-transcript',
      section: SECTION.detail,
      view: 'genome_browser',
      anchor: { selector: `[data-drawer-transcript-row="${REG4.canonicalTranscript}"]` },
      placement: 'top',
      placeAgainst: ABOVE_THE_BROWSER,
      reveal: SHOW_BROWSER_TRACK,
      ensure: FOCUSED,
      arrive: [
        at(REG4_REGION),
        { ...REG4_TRANSCRIPT_HIDDEN, pinnedTranscript: 'none' },
      ],
      title: 'Pinning transcripts',
      body: 'Try clicking on the highlighted transcript to pin it. Pinning it highlights it '
        + 'both in the browser and the drawer until it\'s unpinned. It also causes the row for '
        + 'the transcript id in the drawer to line up with the corresponding transcript row in '
        + 'the browser. This is helpful for genes with a lot of transcript to allow you to '
        + 'easily transition from looking at the transcript in the browser to viewing more '
        + 'info about it in the drawer.',
      action: {
        type: 'click',
        anchor: { selector: `[data-drawer-transcript-row="${REG4.canonicalTranscript}"]` },
        skipIfEngaged: true,
      },
      advanceOn: { type: 'manual' },
      holdMs: 3000,
    },
    {
      id: 'transcript-info',
      section: SECTION.detail,
      view: 'genome_browser',
      anchor: `focus-transcript-info-${REG4.canonicalTranscript}`,
      placement: 'left',
      cardPosition: { x: 0.4055, y: 0.6003 },
      ensure: FOCUSED,
      arrive: [at(REG4_REGION), { type: 'browserControls', drawerTranscripts: 'expanded' }],
      title: 'Accessing transcript sequences',
      body: 'The information mark beside each transcript expands the drawer further to expose '
        + 'more information about a particular transcript, including sequences associated with '
        + 'it. Try clicking the information mark icon now.',
      advanceOn: { type: 'click' },
    },
    {
      // The panel as a whole, before anything inside it. Opening it is a big change — the
      // track narrows, the browser re-frames, and a second column of information appears
      // beside the drawer — and the step that follows goes straight to two buttons well
      // down inside it. Naming the panel first gives the reader somewhere to stand.
      //
      // Look-only: everything here is taught by the steps after it, and the panel scrolls,
      // so letting it be used would move the very thing the next step spotlights.
      id: 'transcript-detail-panel',
      section: SECTION.detail,
      view: 'genome_browser',
      anchor: { selector: '[data-focus-transcript-detail]' },
      placement: 'left',
      cardPosition: { x: 0.2015, y: 0.4758 },
      placeAgainst: { selector: '[data-focus-transcript-detail]' },
      align: 'center',
      interactive: false,
      // The panel animates open and the browser re-frames behind it. Wait for both before
      // drawing a spotlight the size of the whole panel, or it is traced around a shape
      // that is still growing.
      deferUntilReady: true,
      ensure: FOCUSED,
      // Panel first, view second, for the reason given on the step below: opening the
      // panel narrows the track, so a view set before it lands somewhere slightly else.
      arrive: [
        { type: 'browserControls', transcriptDetail: 'open', transcriptSequence: 'genomic' },
        at(REG4_REGION),
      ],
      title: 'The transcript panel',
      body: 'This transcript panel. At the top there\'s some metadata on the gene (which is '
        + 'identical across the transcripts), followed by some transcript-specific metadata.  '
        + 'Below that is a sequence section that we\'ll look at in the next step. This drawer '
        + 'acts as a simple and quick way to fetch metadata and sequences related to a '
        + 'transcript while in the Genome Browser view. The Feature Explorer, which we\'ll '
        + 'look at in a different tutorial, provides a much deeper insight in the features and '
        + 'sequences associated with a gene.',
    },
    {
      id: 'sequences',
      section: SECTION.detail,
      view: 'genome_browser',
      // A tight wrapper around just these two buttons keeps the rest of the detail pane
      // out of the spotlight. The wrapper is a group, so it grants nothing on its own —
      // the two buttons inside it are named below.
      anchor: 'focus-sequence-coding-types',
      placement: 'left',
      cardPosition: { x: 0.2047, y: 0.4738 },
      placeAgainst: { selector: '[data-focus-transcript-detail]' },
      align: 'center',
      reveal: SHOW_TRANSCRIPT_DETAIL,
      // The target sits below the initially visible transcript summary. Let the panel
      // finish opening and scroll the sequence selector into place before drawing the
      // card and spotlight, so the highlight never chases the buttons down the drawer.
      deferUntilReady: true,
      ensure: FOCUSED,
      // Panel first, view second. Opening the detail pane narrows the track and the
      // browser re-frames what it is showing, so setting the view before opening it
      // leaves the step somewhere slightly other than where it asked to be.
      arrive: [
        { type: 'browserControls', transcriptDetail: 'open', transcriptSequence: 'genomic' },
        at(REG4_REGION),
      ],
      allow: [
        { anchor: 'focus-sequence-cds', capability: 'activate' },
        { anchor: 'focus-sequence-protein', capability: 'activate' },
      ],
      title: 'Transcript sequences',
      body: 'For each transcript you can get a variety of different sequences in FASTA format, '
        + 'which can be seen along the right hand edge of the drawer beside the sequence '
        + 'itself. The default selection is the genomic sequence for the transcript. In this '
        + 'case the transcript is protein-coding, so the CDS and protein sequences are '
        + 'available. Try clicking on each to switch the sequence displayed in the panel and '
        + 'then use Next to continue.',
      action: {
        type: 'click',
        anchor: 'focus-sequence-coding-types',
        anchors: ['focus-sequence-cds', 'focus-sequence-protein'],
        pauseMs: 4000,
        endPauseMs: 4000,
        skipIfEngaged: true,
      },
      advanceOn: { type: 'manual' },
    },
    {
      id: 'close-transcript-detail',
      section: SECTION.detail,
      view: 'genome_browser',
      anchor: 'focus-transcript-detail-close',
      placement: 'top',
      cardPosition: { x: 0.5259, y: 0.2122 },
      reveal: SHOW_TRANSCRIPT_DETAIL,
      ensure: FOCUSED,
      arrive: [
        { type: 'browserControls', transcriptDetail: 'open', transcriptSequence: 'protein' },
        at(REG4_REGION),
      ],
      title: 'Close the transcript panel',
      body: 'Use the X to close the transcript information panel and return to the gene '
        + 'drawer.',
      action: { type: 'click', anchor: 'focus-transcript-detail-close' },
      advanceOn: { type: 'click' },
    },

    // ── Notes ──────────────────────────────────────────────────────────────
    {
      // The section before the button in it, for the same reason as the transcript panel
      // above: a reader who has been shown transcripts and sequences has no reason to
      // expect the drawer to hold their own writing as well, and the step after this one
      // goes straight for a small plus icon.
      //
      // Look-only. The one thing to do here is add a note, which is the next step's job.
      id: 'notes-section',
      section: SECTION.notes,
      view: 'genome_browser',
      anchor: { selector: '[data-focus-drawer-notes]' },
      placement: 'left',
      interactive: false,
      ensure: FOCUSED,
      // The same arrival as the step below, so walking back into it from a written note
      // takes the note away again and the section reads as it does the first time.
      arrive: [
        at(REG4_REGION),
        { type: 'browserControls', transcriptDetail: 'closed', tutorialNote: 'none' },
      ],
      title: 'Notes on a gene',
      body: 'The bottom part of the gene draw is for notes. You can write notes on a '
        + 'particular gene for future reference. This could be about an issue you\'ve found, '
        + 'or a particular exon you\'re studying, anything you might find useful when looking '
        + 'at the gene in future. There is a dedicated Notes view that we\'ll look at in a '
        + 'separate tutorial where you can look at all the notes you\'ve written across all '
        + 'the genomes you, with the ability to search and jump from a note into the genome '
        + 'browser.',
    },
    {
      id: 'add-note',
      section: SECTION.notes,
      view: 'genome_browser',
      anchor: 'focus-notes-add',
      placement: 'left',
      cardPosition: { x: 0.4056, y: 0.6683 },
      ensure: FOCUSED,
      // Always starts with no note, so the step writes exactly one however many times it
      // is walked through.
      arrive: [
        at(REG4_REGION),
        { type: 'browserControls', transcriptDetail: 'closed', tutorialNote: 'none' },
      ],
      title: 'Create a new note',
      body: 'Trying clicking the \'+\' button to add a new note to REG4.',
      action: { type: 'click', anchor: 'focus-notes-add' },
      advanceOn: { type: 'signal', name: 'browser.noteCreated' },
    },
    {
      id: 'write-note',
      section: SECTION.notes,
      view: 'genome_browser',
      anchor: 'focus-note-body',
      placement: 'left',
      ensure: FOCUSED,
      arrive: [at(REG4_REGION), { type: 'browserControls', noteEditor: 'open' }],
      title: 'Add some text',
      body: 'Notes have an optional title, and then the note body where you can put the main '
        + 'text of the note. The note body is highlighted to the right, try entering some '
        + 'text. It will automatically save as you type. Click Next when you\'re ready to move '
        + 'on.',
      action: {
        type: 'type',
        anchor: 'focus-note-body',
        value: 'Five transcripts, one MANE Select',
        // A note body is prose; Return belongs to the note, not to the form.
        submit: false,
      },
      // Do not advance as soon as someone starts writing: they decide when the note is
      // ready and press Next. If they wrote anything, the action leaves it alone; if the
      // field is empty, Next demonstrates the example text before continuing.
      advanceOn: { type: 'manual' },
    },
    {
      id: 'note-icon',
      section: SECTION.notes,
      view: 'genome_browser',
      anchor: `browser-gene-note-${REG4.id}`,
      placement: 'top',
      cardPosition: { x: 0.2774, y: 0.0363 },
      placeAgainst: ABOVE_THE_BROWSER,
      reveal: SHOW_BROWSER_TRACK,
      interactive: false,
      ensure: FOCUSED,
      arrive: [at(REG4_REGION), { type: 'browserControls', noteEditor: 'open' }],
      title: 'The note has been saved',
      body: 'The note is now both listed in the gene drawer, and also there is a small note '
        + 'icon on the REG4 gene in the browser window, which you can see highlighted to the '
        + 'left. This is a simple visual indication that a gene has one or more notes. As the '
        + 'note panel is already open, the note icon is not active, but when browsing you can '
        + 'click on the icon to automatically open the most recent note on the gene.',
    },
    {
      id: 'unfocus',
      section: SECTION.notes,
      view: 'genome_browser',
      anchor: 'focus-gene-dismiss',
      placement: 'left',
      align: 'end',
      reveal: SHOW_FOCUS_DRAWER,
      ensure: FOCUSED,
      // Keeping the editor open also guarantees that a direct jump used for testing has
      // a tutorial note to preserve after the drawer closes.
      arrive: [at(REG4_REGION), { type: 'browserControls', noteEditor: 'open' }],
      title: 'Close the focus drawer',
      body: 'Use the X beside the gene identifier to clear REG4 as the gene in focus and close '
        + 'its drawer. The note stays attached to the gene after the drawer closes. The gene '
        + 'focus bar and highlighting of the gene will disappear from the browser window.',
      action: { type: 'click', anchor: 'focus-gene-dismiss' },
      advanceOn: { type: 'click' },
    },

    {
      id: 'finish',
      section: SECTION.finish,
      placement: 'center',
      title: 'The Genome Browser tutorial is complete',
      body: 'You should now have a good grasp on the basics of browsing the genome, how to '
        + 'look at and compact transcripts, focusing on a gene, the gene drawers, how to '
        + 'manipulate what transcript are displayed, how to quickly fetch transcript sequences '
        + 'and how to add notes. It\'s actually quite a lot of stuff.',
    },
  ],
}

// Editing a step's wording from the card rewrites this file, and a plain module change
// makes Vite reload the whole page — which ends the tutorial you were reading. Accepting
// the update keeps the session alive; the runtime already applied the edit in memory.
if (import.meta.hot) import.meta.hot.accept()
