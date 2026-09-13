// The Track Manager: registering data files, and the Track Hub Registry beside it.
//
// Two surfaces, one module, for the same reason `customGenome.js` keeps the form and its
// reports together — a single exercise crosses both. The reader presses Add Track in the
// view, fills the wizard in a modal, and the result lands back in the view's list.
//
// What is *not* here is the browser half of the same job. Registering a track and showing
// it are different acts in different apps, so the Add Custom Track button and the track
// picker are in `genomeBrowser.js` with the rest of the panel's controls, and they get the
// `recipeId` scoping that every genome-browser target gets.
export default {
  viewId: 'track_manager',
  label: 'Track Manager',
  version: 1,
  targets: [
    // ── The view ────────────────────────────────────────────────────────────────
    { id: 'tracks.view', anchor: 'track-manager-view', label: 'Track Manager', kind: 'region', capabilities: ['spotlight', 'scroll'], safety: 'read' },
    { id: 'tracks.header', anchor: 'track-manager-header', label: 'Track Manager header', kind: 'region', capabilities: ['spotlight'], safety: 'read' },
    { id: 'tracks.add', anchor: 'track-manager-add', label: 'Add Track', kind: 'button', capabilities: ['spotlight', 'activate'], safety: 'read' },
    { id: 'tracks.filters', anchor: 'track-manager-filters', label: 'Search and filters', kind: 'group', capabilities: ['spotlight'], safety: 'read' },
    { id: 'tracks.search', anchor: 'track-manager-search', label: 'Search tracks', kind: 'field', capabilities: ['spotlight', 'input'], safety: 'read', recordValue: true },
    { id: 'tracks.list', anchor: 'track-manager-list', label: 'Registered tracks', kind: 'region', capabilities: ['spotlight'], safety: 'read' },

    // One registered track's card. Addressed by the label the tutorial typed, not by the
    // registry id, which is minted at registration and cannot be written into a document.
    {
      id: 'tracks.card', selectorTemplate: '[data-tutorial-track-label="{label}"]', label: 'A registered track', kind: 'row',
      parameters: { label: { type: 'string', required: true } },
      capabilities: ['spotlight'], safety: 'read',
    },

    // The Track Hub Registry. Spotlight only: the tutorial says what it is for and does
    // not import anything, which would reach the network and the user's own genomes.
    { id: 'tracks.hub', anchor: 'track-manager-hub', label: 'Track Hub Registry', kind: 'region', capabilities: ['spotlight'], safety: 'read' },

    // ── The registration wizard ─────────────────────────────────────────────────
    { id: 'tracks.wizard', anchor: 'track-wizard', label: 'Register Track dialog', kind: 'dialog', capabilities: ['spotlight'], safety: 'read' },
    { id: 'tracks.wizardBrowse', anchor: 'track-wizard-browse', label: 'Browse for a data file', kind: 'button', capabilities: ['spotlight', 'activate'], safety: 'read' },
    { id: 'tracks.wizardFile', anchor: 'track-wizard-file', label: 'Selected file', kind: 'group', capabilities: ['spotlight'], safety: 'read' },
    { id: 'tracks.wizardType', anchor: 'track-wizard-type', label: 'Track type', kind: 'select', capabilities: ['spotlight', 'set-state'], safety: 'read' },
    { id: 'tracks.wizardLabel', anchor: 'track-wizard-label', label: 'Track label', kind: 'field', capabilities: ['spotlight', 'input'], safety: 'sandbox-write', recordValue: true },

    // BigWig only, and the data type is not optional: Register stays disabled until one is
    // chosen, and the choice is what decides whether the track draws as a zoned heatmap or
    // as a signal plot. That is the lesson, so it gets its own contract.
    { id: 'tracks.wizardBigWig', anchor: 'track-wizard-bigwig', label: 'BigWig plot settings', kind: 'group', capabilities: ['spotlight'], safety: 'read' },
    { id: 'tracks.wizardDataType', anchor: 'track-wizard-datatype', label: 'BigWig data type', kind: 'select', capabilities: ['spotlight', 'set-state'], safety: 'read' },
    { id: 'tracks.wizardDisplay', anchor: 'track-wizard-display', label: 'BigWig display mode', kind: 'select', capabilities: ['spotlight', 'set-state'], safety: 'read' },
    // The display mode every other type uses — a separate control in a separate branch.
    { id: 'tracks.wizardDisplayMode', anchor: 'track-wizard-display-mode', label: 'Display mode', kind: 'select', capabilities: ['spotlight', 'set-state'], safety: 'read' },
    { id: 'tracks.wizardVcf', anchor: 'track-wizard-vcf', label: 'VCF colours', kind: 'group', capabilities: ['spotlight'], safety: 'read' },

    // Without this the track registers and is then never drawn, which is the quietest
    // failure in the whole flow — hence a contract of its own rather than a step pointing
    // at the wizard and hoping.
    { id: 'tracks.wizardGenome', anchor: 'track-wizard-genome', label: 'Genome association', kind: 'group', capabilities: ['spotlight'], safety: 'read' },

    // `sandbox-write`: this is the press that registers. While a tutorial runs the registry
    // it writes to is the workspace's own (`main._tracks_config`), which is what makes it
    // safe — but the capability should say what it does.
    { id: 'tracks.wizardRegister', anchor: 'track-wizard-register', label: 'Register Track', kind: 'button', capabilities: ['spotlight', 'activate'], safety: 'sandbox-write' },
    { id: 'tracks.wizardBack', anchor: 'track-wizard-back', label: 'Back to the file step', kind: 'button', capabilities: ['spotlight', 'activate'], safety: 'read' },
  ],
}
