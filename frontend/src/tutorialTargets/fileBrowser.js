// The app's own file browser.
//
// Lifted out of `customGenome.js`, which anticipated this: it listed these contracts while
// the add-a-genome flow was the only thing that drove the dialog, and said to move them
// the moment a second flow needed them. The Track Manager tutorial is that second flow —
// its reader picks three data files through the same modal.
//
// `viewId: 'app'` rather than a view of its own, and this is the point of the move. The
// dialog opens over whichever view asked for it, so a contract tied to `genome_selector`
// would make `validateTutorialDocument` reject the same target used from the Track
// Manager. 'app' is the catalogue's existing word for "not tied to one view", and it is
// exempt from that check.
export default {
  viewId: 'app',
  label: 'File browser',
  version: 1,
  targets: [
    { id: 'files.dialog', anchor: 'file-browser', label: 'File browser', kind: 'dialog', capabilities: ['spotlight'], safety: 'read' },
    { id: 'files.path', anchor: 'file-browser-path', label: 'Current directory', kind: 'group', capabilities: ['spotlight'], safety: 'read' },
    { id: 'files.list', anchor: 'file-browser-list', label: 'Directory listing', kind: 'region', capabilities: ['spotlight', 'scroll'], safety: 'read' },
    // Parameterised on the file's *name*, not its path: a portable document may not carry
    // an absolute path, and the name is what the card tells the reader to look for.
    {
      id: 'files.entry', anchorTemplate: 'file-browser-entry-{name}', label: 'File or folder', kind: 'row',
      parameters: { name: { type: 'string', required: true } },
      capabilities: ['spotlight', 'activate'], safety: 'read',
    },
    { id: 'files.close', anchor: 'file-browser-close', label: 'Close the file browser', kind: 'button', capabilities: ['spotlight', 'activate'], safety: 'read' },
  ],
}
