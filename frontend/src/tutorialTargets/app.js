export default {
  viewId: 'app',
  label: 'Application shell',
  version: 1,
  targets: [
    { id: 'app.datasetPill', selectorTemplate: '[data-tutorial-pill="{dataset}"]', label: 'Tutorial genome pill', kind: 'button', parameters: { dataset: { type: 'string', required: true } }, capabilities: ['spotlight', 'activate'], safety: 'sandbox-write' },
    {
      id: 'app.viewButton', anchorTemplate: 'app-button-{buttonId}', label: 'App view button', kind: 'button',
      parameters: { buttonId: { type: 'string', required: true } }, capabilities: ['spotlight', 'activate'], safety: 'read',
    },
    {
      id: 'app.genomePills', anchor: 'app-genome-pills', label: 'Selected genomes strip', kind: 'region',
      capabilities: ['spotlight'], safety: 'read', presentation: { deferUntilReady: true },
    },
    {
      id: 'app.genomePill', anchorTemplate: 'genome-pill-{speciesKey}', label: 'Selected genome', kind: 'button',
      parameters: { speciesKey: { type: 'string', required: true } }, capabilities: ['spotlight', 'activate'], safety: 'sandbox-write',
    },
    {
      id: 'app.genomePillRemove', anchorTemplate: 'genome-pill-remove-{speciesKey}', label: 'Remove selected genome', kind: 'button',
      parameters: { speciesKey: { type: 'string', required: true } }, capabilities: ['spotlight', 'activate'], safety: 'sandbox-write',
    },
    // The top-bar playlist popover. Its entries are keyed on the playlist's slugged name,
    // not its id: a tutorial dictates the name it asks the user to type, while the id is
    // minted at random when the playlist is created. See utils/playlistGenomes.js.
    {
      id: 'app.playlistPopover', anchor: 'app-playlist-popover', label: 'Genome playlist popover', kind: 'region',
      capabilities: ['spotlight'], safety: 'read',
    },
    {
      id: 'app.playlistOption', anchorTemplate: 'app-playlist-option-{playlist}', label: 'Playlist in the popover', kind: 'button',
      parameters: { playlist: { type: 'string', required: true } }, capabilities: ['spotlight', 'activate'], safety: 'sandbox-write',
    },
  ],
}
