export default {
  viewId: 'download',
  label: 'Download',
  version: 1,
  targets: [
    { id: 'download.fileTypes', anchor: 'download-file-types', label: 'Download file types', kind: 'group', capabilities: ['spotlight'], safety: 'read' },
    { id: 'download.search', anchor: 'download-search', label: 'Genome search', kind: 'search', capabilities: ['spotlight', 'input'], safety: 'read', recordValue: true },
    { id: 'download.speciesList', anchor: 'download-species-list', label: 'Genome results', kind: 'region', capabilities: ['spotlight'], safety: 'read' },
    {
      id: 'download.species', anchorTemplate: 'download-species-{speciesKey}', label: 'Genome result', kind: 'row',
      parameters: { speciesKey: { type: 'string', required: true } }, capabilities: ['spotlight'], safety: 'read',
    },
    {
      id: 'download.start', anchorTemplate: 'download-start-{speciesKey}', label: 'Download genome', kind: 'button',
      parameters: { speciesKey: { type: 'string', required: true } }, capabilities: ['spotlight', 'activate'], safety: 'sandbox-write',
    },
  ],
}
