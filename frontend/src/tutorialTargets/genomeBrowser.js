export default {
  viewId: 'genome_browser',
  label: 'Genome Browser',
  version: 1,
  targets: [
    { id: 'browser.hideInactive', anchor: 'browser-hide-inactive', label: 'Hide inactive tracks', kind: 'toggle', capabilities: ['spotlight', 'activate', 'set-state'], safety: 'sandbox-write' },
    ...[['pan', 'Pan'], ['zoom', 'Zoom'], ['linkRegion', 'Link region'], ['linkGene', 'Link gene']].map(([id, label]) => ({ id: `browser.${id}`, anchor: `browser-${id}`, label, kind: 'button', capabilities: ['spotlight', 'activate', 'set-state'], safety: 'sandbox-write' })),
    ...[['GF', 'forward'], ['GR', 'reverse'], ['SL', 'sequence']].map(([label, strand]) => ({ id: `browser.toggle${label}`, anchor: `browser-toggle-${strand}`, label: `${label} track switch`, kind: 'button', capabilities: ['spotlight', 'activate', 'set-state'], safety: 'sandbox-write' })),
    { id: 'browser.globalControls', anchor: 'browser-global-controls', label: 'General browser controls', kind: 'group', capabilities: ['spotlight'], safety: 'read' },
    { id: 'browser.tracks', anchor: 'browser-tracks-toggle', label: 'Tracks', kind: 'button', capabilities: ['spotlight', 'activate', 'set-state'], safety: 'sandbox-write' },
    { id: 'browser.detail', anchor: 'browser-detail', label: 'Detail', kind: 'toggle', capabilities: ['spotlight', 'activate', 'set-state'], safety: 'sandbox-write' },
    { id: 'browser.flatten', anchor: 'browser-flatten', label: 'Flatten', kind: 'toggle', capabilities: ['spotlight', 'activate', 'set-state'], safety: 'sandbox-write' },
    { id: 'browser.unfocus', anchor: 'browser-unfocus', label: 'Unfocus gene', kind: 'button', capabilities: ['spotlight', 'activate'], safety: 'sandbox-write' },
    { id: 'browser.biotypes', anchor: 'browser-biotype-filter', label: 'Gene type filters', kind: 'group', capabilities: ['spotlight'], safety: 'read' },
    { id: 'browser.biotype.proteinCoding', anchor: 'browser-biotype-proteinCoding', label: 'Protein-coding genes', kind: 'checkbox', capabilities: ['spotlight', 'activate', 'set-state'], safety: 'sandbox-write' },
    { id: 'browser.biotype.lncRNA', anchor: 'browser-biotype-lncRNA', label: 'Long non-coding genes', kind: 'checkbox', capabilities: ['spotlight', 'activate', 'set-state'], safety: 'sandbox-write' },
    { id: 'browser.biotype.pseudogene', anchor: 'browser-biotype-pseudogene', label: 'Pseudogenes', kind: 'checkbox', capabilities: ['spotlight', 'activate', 'set-state'], safety: 'sandbox-write' },
    { id: 'browser.biotype.smallNonCoding', anchor: 'browser-biotype-smallNonCoding', label: 'Small non-coding genes', kind: 'checkbox', capabilities: ['spotlight', 'activate', 'set-state'], safety: 'sandbox-write' },
    { id: 'browser.toolbar', selector: '[data-browser-toolbar]', label: 'Genome controls', kind: 'toolbar', capabilities: ['spotlight'], safety: 'read' },
    { id: 'browser.regionSelect', anchor: 'browser-region-select', label: 'Region selector', kind: 'select', capabilities: ['spotlight', 'activate'], safety: 'sandbox-write' },
    { id: 'browser.locationSearch', anchor: 'browser-location-search', label: 'Location or gene search', kind: 'search', capabilities: ['spotlight', 'input'], safety: 'sandbox-write', recordValue: true },
    { id: 'browser.locationSearchField', anchor: 'browser-location-search-field', label: 'Search box and its go button', kind: 'region', capabilities: ['spotlight'], safety: 'read' },
    { id: 'browser.locationSearchGo', anchor: 'browser-location-search-go', label: 'Go to location', kind: 'button', capabilities: ['spotlight', 'activate'], safety: 'sandbox-write' },
    { id: 'browser.expandTranscripts', anchor: 'browser-expand-transcripts', label: 'Expand transcripts', kind: 'toggle', capabilities: ['spotlight', 'activate', 'set-state'], safety: 'sandbox-write' },
    { id: 'browser.coordinates', anchor: 'browser-coordinates', label: 'Visible coordinates', kind: 'status', capabilities: ['spotlight'], safety: 'read' },
    { id: 'browser.recenter', anchor: 'browser-recenter', label: 'Centre on focused gene', kind: 'button', capabilities: ['spotlight', 'activate'], safety: 'sandbox-write' },
    { id: 'browser.viewport', selector: '[data-browser-canvas-surface]', label: 'Browser track', kind: 'canvas', capabilities: ['spotlight', 'pan', 'zoom', 'set-locus', 'read-state'], safety: 'sandbox-write' },
    { id: 'browser.focusBar', selector: '[data-focus-bar]', label: 'Gene of focus bar', kind: 'region', capabilities: ['spotlight'], safety: 'read' },
    { id: 'browser.focusDrawer', selector: '[data-focus-drawer]', label: 'Gene drawer', kind: 'drawer', capabilities: ['spotlight', 'scroll'], safety: 'read' },
    { id: 'browser.focusDrawerOpen', selector: '[data-focus-drawer="true"]', label: 'Open gene drawer', kind: 'drawer', capabilities: ['spotlight', 'scroll'], safety: 'read' },
    {
      id: 'browser.geneTranscripts', anchorTemplate: 'browser-gene-transcripts-{geneId}',
      label: 'Show or hide a gene\u2019s other transcripts', kind: 'button',
      parameters: { geneId: { type: 'string', required: true } },
      capabilities: ['spotlight', 'activate', 'set-state'], safety: 'sandbox-write',
    },
    {
      id: 'browser.geneHiddenTranscripts', anchorTemplate: 'browser-gene-hidden-transcripts-{geneId}',
      label: 'Restore a gene\u2019s hidden transcripts', kind: 'button',
      parameters: { geneId: { type: 'string', required: true } },
      capabilities: ['spotlight', 'activate'], safety: 'sandbox-write',
    },
    { id: 'browser.trackGutter', anchor: 'browser-track-gutter', label: 'Track switches', kind: 'region', capabilities: ['spotlight'], safety: 'read' },
    { id: 'browser.trackGF', anchor: 'browser-track-gf', label: 'Gene forward track', kind: 'canvas-control', capabilities: ['spotlight'], safety: 'read' },
    { id: 'browser.trackGR', anchor: 'browser-track-gr', label: 'Gene reverse track', kind: 'canvas-control', capabilities: ['spotlight'], safety: 'read' },
    { id: 'browser.trackSL', anchor: 'browser-track-sl', label: 'Sequence track', kind: 'canvas-control', capabilities: ['spotlight'], safety: 'read' },
    { id: 'focus.dismiss', anchor: 'focus-gene-dismiss', label: 'Close gene drawer', kind: 'button', capabilities: ['spotlight', 'activate'], safety: 'sandbox-write' },
    { id: 'focus.transcriptsExpand', anchor: 'focus-transcripts-expand', label: 'Show all transcripts', kind: 'button', capabilities: ['spotlight', 'activate', 'set-state'], safety: 'sandbox-write' },
    { id: 'focus.notes', selector: '[data-focus-drawer-notes]', label: 'Notes section', kind: 'region', capabilities: ['spotlight'], safety: 'read' },
    { id: 'focus.notesAdd', anchor: 'focus-notes-add', label: 'Add note', kind: 'button', capabilities: ['spotlight', 'activate'], safety: 'sandbox-write' },
    { id: 'focus.noteTitle', anchor: 'focus-note-title', label: 'Note title', kind: 'input', capabilities: ['spotlight', 'input'], safety: 'sandbox-write', recordValue: true },
    { id: 'focus.noteBody', anchor: 'focus-note-body', label: 'Note text', kind: 'textarea', capabilities: ['spotlight', 'input'], safety: 'sandbox-write', recordValue: true, sensitiveReview: true },
    { id: 'focus.noteSave', anchor: 'focus-note-save', label: 'Save note', kind: 'button', capabilities: ['spotlight', 'activate'], safety: 'sandbox-write' },
    { id: 'focus.sequenceTypes', anchor: 'focus-sequence-types', label: 'Sequence types', kind: 'group', capabilities: ['spotlight'], safety: 'read' },
    { id: 'focus.sequenceCodingTypes', anchor: 'focus-sequence-coding-types', label: 'Coding sequence types', kind: 'group', capabilities: ['spotlight'], safety: 'read' },
    { id: 'focus.transcriptDetail', selector: '[data-focus-transcript-detail]', label: 'Transcript details', kind: 'drawer', capabilities: ['spotlight', 'scroll'], safety: 'read' },
    { id: 'focus.transcriptDetailClose', anchor: 'focus-transcript-detail-close', label: 'Close transcript details', kind: 'button', capabilities: ['spotlight', 'activate'], safety: 'sandbox-write' },
    {
      id: 'focus.transcriptInfo', anchorTemplate: 'focus-transcript-info-{transcriptId}', label: 'Transcript information', kind: 'button',
      parameters: { transcriptId: { type: 'string', required: true } }, capabilities: ['spotlight', 'activate'], safety: 'sandbox-write',
    },
    {
      id: 'focus.transcriptHide', anchorTemplate: 'focus-transcript-hide-{transcriptId}', label: 'Hide transcript', kind: 'button',
      parameters: { transcriptId: { type: 'string', required: true } }, capabilities: ['spotlight', 'activate'], safety: 'sandbox-write',
    },
    {
      id: 'focus.transcriptRow', selectorTemplate: '[data-drawer-transcript-row="{transcriptId}"]', label: 'Transcript row', kind: 'row',
      parameters: { transcriptId: { type: 'string', required: true } }, capabilities: ['spotlight', 'activate'], safety: 'sandbox-write',
    },
    {
      id: 'focus.sequenceType', anchorTemplate: 'focus-sequence-{featureType}', label: 'Sequence type', kind: 'button',
      parameters: { featureType: { type: 'enum', values: ['genomic', 'cdna', 'cds', 'protein', 'utr', 'exons', 'introns'], required: true } },
      capabilities: ['spotlight', 'activate', 'set-state'], safety: 'sandbox-write',
    },
    {
      id: 'browser.geneNote', anchorTemplate: 'browser-gene-note-{geneId}', label: 'Gene note marker', kind: 'canvas-marker',
      parameters: { geneId: { type: 'string', required: true } }, capabilities: ['spotlight', 'activate'], safety: 'read',
    },

    // ── Custom data tracks ──────────────────────────────────────────────────────
    // Registering a track in the Track Manager and showing it in a panel are different
    // acts in different apps, and this is the second half. Everything here takes the
    // `recipeId` parameter `index.js` adds to every browser target, so a step addresses
    // one genome's panel rather than the first one on the page.
    { id: 'browser.addTrack', anchor: 'browser-add-track', label: 'Add a registered track', kind: 'button', capabilities: ['spotlight', 'activate'], safety: 'sandbox-write' },
    { id: 'browser.trackPicker', anchor: 'browser-track-picker', label: 'Add Registered Track dialog', kind: 'dialog', capabilities: ['spotlight'], safety: 'read' },
    { id: 'browser.trackPickerList', anchor: 'browser-track-picker-list', label: 'Tracks available to add', kind: 'region', capabilities: ['spotlight', 'scroll'], safety: 'read' },
    // By label, for the same reason the Track Manager's card is: the registry id is minted
    // at registration and a portable document cannot know it.
    {
      id: 'browser.trackPickerRow', selectorTemplate: '[data-tutorial-picker-track="{label}"]', label: 'A track to add', kind: 'row',
      parameters: { label: { type: 'string', required: true } },
      capabilities: ['spotlight', 'activate'], safety: 'sandbox-write',
    },
    { id: 'browser.trackPickerAdd', anchor: 'browser-track-picker-add', label: 'Add the chosen tracks', kind: 'button', capabilities: ['spotlight', 'activate'], safety: 'sandbox-write' },
    // One custom track's switch in the gutter. An invisible button over the canvas-drawn
    // control, calling the same setter, so there is still one code path for the switch —
    // the same trick as the GF/GR/SL toggles above. By label, because the registry id is
    // minted at registration.
    {
      id: 'browser.trackSwitch', selectorTemplate: '[data-tutorial-track-switch="{label}"]', label: 'A custom track switch', kind: 'toggle',
      parameters: { label: { type: 'string', required: true } },
      capabilities: ['spotlight', 'activate', 'set-state'], safety: 'sandbox-write',
    },
    { id: 'browser.trackPickerClose', anchor: 'browser-track-picker-close', label: 'Close the track picker', kind: 'button', capabilities: ['spotlight', 'activate'], safety: 'read' },
  ],
}
