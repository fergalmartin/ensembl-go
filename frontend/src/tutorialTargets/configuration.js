export default {
  viewId: 'configuration',
  label: 'Configuration',
  version: 1,
  targets: [
    { id: 'config.outputs', anchor: 'config-section-outputs', label: 'Outputs section', kind: 'section', capabilities: ['spotlight', 'activate'], safety: 'read' },
    { id: 'config.outputDir', anchor: 'config-output-dir', label: 'Output directory', kind: 'path', capabilities: ['spotlight', 'input'], safety: 'sandbox-write', recordValue: false },
    { id: 'config.configuration', anchor: 'config-section-configuration', label: 'Configuration section', kind: 'section', capabilities: ['spotlight', 'activate'], safety: 'read' },
    { id: 'config.save', anchor: 'config-save', label: 'Save configuration', kind: 'button', capabilities: ['spotlight', 'activate'], safety: 'sandbox-write' },
    // The colour every genome wears until it is given one of its own. The
    // per-genome colours themselves live in the Genome Selector's targets.
    { id: 'config.defaultGenomeColor', anchor: 'config-default-genome-color', label: 'Default genome colour', kind: 'button', capabilities: ['spotlight', 'activate'], safety: 'sandbox-write' },
  ],
}
