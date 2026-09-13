// The "add your own genome" path: the manual-add form at the foot of the Genome Selector,
// the app's own file browser, and the analysis reports both of them produce.
//
// These three surfaces belong together even though they live in three components. A step
// that asks the reader to pick a file crosses all of them — the Browse button is in the
// form, the row clicked is in the dialog, and the result lands back in the form — so
// splitting them across modules would put one exercise in three places.
//
// The file browser used to be listed here, because this was the only flow that drove it.
// The Track Manager tutorial drives it too, so `files.*` now lives in `fileBrowser.js`
// under `viewId: 'app'` — a dialog that opens over any view cannot belong to one of them.
export default {
  viewId: 'genome_selector',
  label: 'Add a genome',
  version: 1,
  targets: [
    // ── The form ────────────────────────────────────────────────────────────────
    { id: 'custom.panel', anchor: 'manual-add-panel', label: 'Manually add genomes', kind: 'region', capabilities: ['spotlight'], safety: 'read' },
    { id: 'custom.panelToggle', anchor: 'manual-add-toggle', label: 'Expand the add-a-genome form', kind: 'button', capabilities: ['spotlight', 'activate'], safety: 'read' },
    { id: 'custom.labels', anchor: 'manual-labels', label: 'Genome and assembly labels', kind: 'group', capabilities: ['spotlight'], safety: 'read' },
    { id: 'custom.genomeLabel', anchor: 'manual-genome-label', label: 'Genome label', kind: 'field', capabilities: ['spotlight', 'input'], safety: 'sandbox-write', recordValue: true },
    { id: 'custom.assemblyLabel', anchor: 'manual-assembly-label', label: 'Assembly label', kind: 'field', capabilities: ['spotlight', 'input'], safety: 'sandbox-write', recordValue: true },
    { id: 'custom.accession', anchor: 'manual-accession', label: 'Assembly accession', kind: 'field', capabilities: ['spotlight', 'input'], safety: 'sandbox-write', recordValue: true },

    // The path rows. The row is the spotlight — a reader submitting one needs its
    // buttons inside the light, and two rings three pixels apart read as one smudge.
    { id: 'custom.fastaRow', anchor: 'manual-fasta', label: 'FASTA file row', kind: 'group', capabilities: ['spotlight'], safety: 'read' },
    { id: 'custom.fastaBrowse', anchor: 'manual-fasta-browse', label: 'Browse for a FASTA', kind: 'button', capabilities: ['spotlight', 'activate'], safety: 'read' },
    { id: 'custom.fastaAnalyse', anchor: 'manual-fasta-analyse', label: 'Analyse the FASTA', kind: 'button', capabilities: ['spotlight', 'activate'], safety: 'read' },
    { id: 'custom.annotationRow', anchor: 'manual-annotation', label: 'Annotation file row', kind: 'group', capabilities: ['spotlight'], safety: 'read' },
    { id: 'custom.annotationBrowse', anchor: 'manual-annotation-browse', label: 'Browse for an annotation', kind: 'button', capabilities: ['spotlight', 'activate'], safety: 'read' },
    { id: 'custom.annotationAnalyse', anchor: 'manual-annotation-analyse', label: 'Analyse the annotation', kind: 'button', capabilities: ['spotlight', 'activate'], safety: 'read' },
    { id: 'custom.homologyRow', anchor: 'manual-homology', label: 'Homology file row', kind: 'group', capabilities: ['spotlight'], safety: 'read' },
    { id: 'custom.homologyBrowse', anchor: 'manual-homology-browse', label: 'Browse for a homology file', kind: 'button', capabilities: ['spotlight', 'activate'], safety: 'read' },
    { id: 'custom.indexRow', anchor: 'manual-index', label: 'Suggested index path', kind: 'group', capabilities: ['spotlight'], safety: 'read' },
    { id: 'custom.indexPath', anchor: 'manual-index-path', label: 'Index path', kind: 'field', capabilities: ['spotlight'], safety: 'read' },
    { id: 'custom.indexBrowse', anchor: 'manual-index-browse', label: 'Browse for an index location', kind: 'button', capabilities: ['spotlight', 'activate'], safety: 'read' },

    // `sandbox-write` rather than `read`: this is the press that registers a genome. It
    // lands in the tutorial's config override rather than the user's configuration, which
    // is what makes it safe, not the capability — but the capability should say so.
    { id: 'custom.addGenome', anchor: 'manual-add-genome', label: 'Add genome', kind: 'button', capabilities: ['spotlight', 'activate'], safety: 'sandbox-write' },

    // ── The analysis reports ────────────────────────────────────────────────────
    {
      id: 'custom.report', anchorTemplate: 'validation-report-{kind}', label: 'Analysis report', kind: 'region',
      parameters: { kind: { type: 'enum', values: ['genome', 'annotation'], required: true } },
      capabilities: ['spotlight'], safety: 'read',
    },
    // One section of one report. Both reports have an "Issues" section and anchors resolve
    // to the first match, so the section names are qualified by which report they belong
    // to and the enum lists them as they are actually written in the source.
    {
      id: 'custom.reportSection', anchorTemplate: 'validation-{section}', label: 'Analysis report section', kind: 'group',
      parameters: {
        section: {
          type: 'enum',
          values: [
            'genome-sequences', 'genome-base-composition', 'genome-longest-sequences', 'genome-issues',
            'annotation-detected', 'annotation-model', 'annotation-gene-classes',
            'annotation-sequence-regions', 'annotation-identifiers', 'annotation-issues',
          ],
          required: true,
        },
      },
      capabilities: ['spotlight'], safety: 'read',
    },

  ],
}
