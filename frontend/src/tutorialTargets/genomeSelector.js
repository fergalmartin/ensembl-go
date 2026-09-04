export default {
  viewId: 'genome_selector',
  label: 'Genome Selector',
  version: 1,
  targets: [
    { id: 'selector.search', anchor: 'selector-search', label: 'Genome search', kind: 'search', capabilities: ['spotlight', 'input'], safety: 'read', recordValue: true },
    {
      id: 'selector.genomeList', anchor: 'selector-genome-list', label: 'Genome list', kind: 'region',
      capabilities: ['spotlight'], safety: 'read',
      presentation: { scrollIntoView: 'center', deferUntilReady: true },
    },
    {
      id: 'selector.genome', anchorTemplate: 'selector-genome-{speciesKey}', label: 'Genome row', kind: 'row',
      parameters: { speciesKey: { type: 'string', required: true } }, capabilities: ['spotlight'], safety: 'read',
    },
    {
      id: 'selector.checkbox', anchorTemplate: 'selector-checkbox-{speciesKey}', label: 'Activate genome', kind: 'checkbox',
      parameters: { speciesKey: { type: 'string', required: true } }, capabilities: ['spotlight', 'activate', 'set-state'], safety: 'sandbox-write',
    },
    {
      id: 'selector.addToPlaylist', anchorTemplate: 'selector-playlist-{genomeKey}', label: 'Add genome to playlists', kind: 'button',
      parameters: { genomeKey: { type: 'string', required: true } }, capabilities: ['spotlight', 'activate'], safety: 'sandbox-write',
    },
    {
      id: 'selector.addSelectedToPlaylist', anchor: 'selector-playlist-selected', label: 'Add selected genomes to playlists', kind: 'button',
      capabilities: ['spotlight', 'activate'], safety: 'sandbox-write',
    },
    // The Genome Playlists panel below the list. Its rows are keyed on the playlist's
    // slugged name for the same reason the popover's are.
    {
      id: 'selector.playlistBar', anchor: 'selector-playlist-bar', label: 'Genome Playlists panel', kind: 'region',
      capabilities: ['spotlight'], safety: 'read',
    },
    {
      id: 'selector.playlistBarToggle', anchor: 'selector-playlist-bar-toggle', label: 'Expand the playlists panel', kind: 'button',
      capabilities: ['spotlight', 'activate'], safety: 'read',
    },
    {
      id: 'selector.playlistList', anchor: 'selector-playlist-list', label: 'The playlists', kind: 'region',
      capabilities: ['spotlight', 'scroll'], safety: 'read',
    },
    {
      id: 'selector.playlistRow', anchorTemplate: 'selector-playlist-row-{playlist}', label: 'Playlist', kind: 'row',
      parameters: { playlist: { type: 'string', required: true } }, capabilities: ['spotlight', 'activate'], safety: 'sandbox-write',
    },
    {
      id: 'selector.playlistEdit', anchorTemplate: 'selector-playlist-edit-{playlist}', label: 'Edit playlist', kind: 'button',
      parameters: { playlist: { type: 'string', required: true } }, capabilities: ['spotlight', 'activate'], safety: 'sandbox-write',
    },
    {
      id: 'selector.playlistDelete', anchorTemplate: 'selector-playlist-delete-{playlist}', label: 'Delete playlist', kind: 'button',
      parameters: { playlist: { type: 'string', required: true } }, capabilities: ['spotlight', 'activate'], safety: 'sandbox-write',
    },
    // The playlist dialog. A step can only reach these once something has opened it, which
    // is what the `selectorDialog` arrival is for; see docs/TUTORIALS.md.
    {
      id: 'selector.playlistDialog', anchor: 'playlist-membership-dialog', label: 'Playlist dialog', kind: 'dialog',
      capabilities: ['spotlight'], safety: 'read',
    },
    {
      id: 'selector.playlistDialogList', anchor: 'playlist-membership-existing', label: 'Existing playlists list', kind: 'region',
      capabilities: ['spotlight', 'scroll'], safety: 'read',
    },
    {
      id: 'selector.playlistDialogMember', anchorTemplate: 'playlist-membership-checkbox-{playlistId}', label: 'Existing playlist', kind: 'checkbox',
      parameters: { playlistId: { type: 'string', required: true } }, capabilities: ['spotlight', 'activate', 'set-state'], safety: 'sandbox-write',
    },
    {
      id: 'selector.playlistDialogNewName', anchor: 'playlist-membership-new-name', label: 'New playlist name', kind: 'field',
      capabilities: ['spotlight', 'input'], safety: 'sandbox-write', recordValue: true,
    },
    {
      id: 'selector.playlistDialogNewDescription', anchor: 'playlist-membership-new-description', label: 'New playlist description', kind: 'field',
      capabilities: ['spotlight', 'input'], safety: 'sandbox-write', recordValue: true,
    },
    {
      id: 'selector.playlistDialogSave', anchor: 'playlist-membership-save', label: 'Add genomes to playlists', kind: 'button',
      capabilities: ['spotlight', 'activate'], safety: 'sandbox-write',
    },
    {
      id: 'selector.playlistDialogCancel', anchor: 'playlist-membership-cancel', label: 'Cancel playlist dialog', kind: 'button',
      capabilities: ['spotlight', 'activate'], safety: 'read',
    },
    {
      id: 'selector.playlistDialogClose', anchor: 'playlist-membership-close', label: 'Close playlist dialog', kind: 'button',
      capabilities: ['spotlight', 'activate'], safety: 'read',
    },
  ],
}
