// Shared definitions for the file types a genome can carry.
//
// These used to be duplicated across DownloadView (download badges) and
// GenomeSelectorView (the per-genome file editor). They live here so the
// portable genome bundle, the download view and the selector all agree on the
// key set and its ordering, and so the labels can be unit tested — the test
// runner is `node --test`, which cannot load `.jsx`.

export const DOWNLOAD_FILE_DEFS = {
    fasta: { label: 'Genome', shortLabel: 'Genome', category: 'Genome', subtype: 'FASTA', color: 'bg-amber-100 text-amber-800', tooltip: 'Genome FASTA; central to app views.' },
    gff3: { label: 'Genes', shortLabel: 'Genes', category: 'Annotation', subtype: 'GFF3', color: 'bg-purple-100 text-purple-800', tooltip: 'GFF3 annotation; central to app views.' },
    homology: { label: 'Homologies', shortLabel: 'Homologies', category: 'Homology', subtype: 'TSV', color: 'bg-teal-100 text-teal-800', tooltip: 'Homology table used by comparative views.' },
    cdna: { label: 'cDNAs', shortLabel: 'cDNAs', category: 'Transcript', subtype: 'cDNA', color: 'bg-lime-100 text-lime-800', tooltip: 'cDNA FASTA; downloaded for optional/external use.' },
    protein: { label: 'Proteins', shortLabel: 'Proteins', category: 'Protein', subtype: 'FASTA', color: 'bg-rose-100 text-rose-800', tooltip: 'Protein FASTA; downloaded for optional/external use.' },
    xref: { label: 'Xrefs', shortLabel: 'Xrefs', category: 'Xref', subtype: 'TSV', color: 'bg-cyan-100 text-cyan-800', tooltip: 'External references; downloaded for optional/external use.' },
    metadata: { label: 'Metadata', shortLabel: 'Meta', category: 'Metadata', subtype: 'Assembly', color: 'bg-sky-100 text-sky-800', tooltip: 'Assembly report / sequence metadata.' },
    index: { label: 'App index', shortLabel: 'Index', category: 'Index', subtype: 'App GFF3', color: 'bg-blue-100 text-blue-800', tooltip: 'Local app-generated GFF3 index.' },
    gff3_index: { label: 'GFF3 index', shortLabel: 'GFF3 idx', category: 'Index', subtype: 'GFF3', color: 'bg-indigo-100 text-indigo-800', tooltip: 'Remote sidecar index for annotation.' },
    gtf_index: { label: 'GTF index', shortLabel: 'GTF idx', category: 'Index', subtype: 'GTF', color: 'bg-indigo-100 text-indigo-800', tooltip: 'Remote sidecar index for GTF annotation.' },
    cdna_index: { label: 'cDNA index', shortLabel: 'cDNA idx', category: 'Index', subtype: 'cDNA', color: 'bg-emerald-100 text-emerald-800', tooltip: 'Remote sidecar index for cDNA FASTA.' },
    protein_index: { label: 'Protein index', shortLabel: 'Prot idx', category: 'Index', subtype: 'Protein', color: 'bg-pink-100 text-pink-800', tooltip: 'Remote sidecar index for protein FASTA.' },
    xref_index: { label: 'Xref index', shortLabel: 'Xref idx', category: 'Index', subtype: 'Xref', color: 'bg-cyan-100 text-cyan-800', tooltip: 'Remote sidecar index for xrefs.' },
    gtf: { label: 'GTF', shortLabel: 'GTF', category: 'Annotation', subtype: 'GTF', color: 'bg-violet-100 text-violet-800', tooltip: 'GTF annotation export.' },
    embl: { label: 'EMBL', shortLabel: 'EMBL', category: 'Annotation', subtype: 'EMBL', color: 'bg-gray-100 text-gray-700', tooltip: 'EMBL annotation export.' },
    alignment: { label: 'Alignments', shortLabel: 'Align', category: 'Alignment', subtype: 'MAF', color: 'bg-orange-100 text-orange-800', tooltip: 'Pairwise alignment archive from Ensembl Compara.' },
    other_annotation: { label: 'Other', shortLabel: 'Other', category: 'Annotation', subtype: 'Other', color: 'bg-gray-100 text-gray-700', tooltip: 'Additional annotation file.' },
}

// The canonical order a bundle writes and the review matrix displays. Mirrors
// BUNDLE_FILE_TYPES in backend/manual_genome_config.py — keep the two in step.
export const BUNDLE_FILE_TYPES = [
    'fasta',
    'gff3',
    'homology',
    'index',
    'metadata',
    'cdna',
    'protein',
    'xref',
    'gff3_index',
    'gtf_index',
    'cdna_index',
    'protein_index',
    'xref_index',
    'gtf',
    'embl',
    'alignment',
    'other_annotation',
]

// A genome without sequence cannot be opened, so this one is a hard requirement.
export const BUNDLE_REQUIRED_FILE_TYPE = 'fasta'

// Version 1 of the bundle spelled two keys differently.
export const BUNDLE_FILE_KEY_ALIASES = {
    annotation: 'gff3',
    homologies: 'homology',
}

export const GENOME_FILE_EDITOR_TYPES = ['fasta', 'gff3', 'homology', 'cdna', 'protein', 'xref', 'gff3_index', 'gtf_index', 'cdna_index', 'protein_index']
export const MANUAL_GENOME_FILE_EDITOR_TYPES = ['fasta', 'gff3', 'homology']

export const fileTypeLabel = (type) => DOWNLOAD_FILE_DEFS[type]?.shortLabel || String(type || '').toUpperCase()
export const fileTypeTooltip = (type) => DOWNLOAD_FILE_DEFS[type]?.tooltip || type

// Manual genomes present a friendlier vocabulary than the raw download keys.
export const localFileTypeLabel = (type, isManual = false) => {
    if (isManual && type === 'fasta') return 'Genome FASTA'
    if (isManual && type === 'gff3') return 'Annotation'
    if (isManual && type === 'homology') return 'Homologies'
    return type === 'protein_index' ? 'PROT_INDEX' : String(type || '').toUpperCase()
}

// Compact label used by the review matrix, where column headers are rotated and
// space is tight.
export const bundleFileTypeLabel = (type) => {
    if (type === 'fasta') return 'FASTA'
    if (type === 'gff3') return 'Annotation'
    if (type === 'homology') return 'Homology'
    return DOWNLOAD_FILE_DEFS[type]?.shortLabel || String(type || '').toUpperCase()
}

// A key we are willing to treat as a file type even though it is not in
// BUNDLE_FILE_TYPES. Keeps unknown-but-plausible types travelling with the
// genome instead of being silently dropped on export.
const FILE_TYPE_KEY_RE = /^[a-z0-9][a-z0-9_]*$/

// Resolve a bundle document's `files` object onto canonical keys. Canonical
// keys win over their legacy aliases when a document carries both, matching
// _collect_declared_files on the backend.
//
// Known types come first in canonical order; anything else the app produced
// follows, sorted, so a file type added later still round-trips without a
// change here.
export const canonicalBundleFiles = (files) => {
    const source = files && typeof files === 'object' ? files : {}
    const collected = {}
    for (const fileType of BUNDLE_FILE_TYPES) {
        const value = String(source[fileType] || '').trim()
        if (value) collected[fileType] = value
    }
    for (const [alias, canonical] of Object.entries(BUNDLE_FILE_KEY_ALIASES)) {
        if (collected[canonical]) continue
        const value = String(source[alias] || '').trim()
        if (value) collected[canonical] = value
    }
    const known = new Set([...BUNDLE_FILE_TYPES, ...Object.keys(BUNDLE_FILE_KEY_ALIASES)])
    for (const key of Object.keys(source).sort()) {
        if (known.has(key) || !FILE_TYPE_KEY_RE.test(key)) continue
        const value = String(source[key] || '').trim()
        if (value) collected[key] = value
    }
    return collected
}

// Order a set of file types for display: known ones canonically, extras after.
export const orderBundleFileTypes = (fileTypes) => {
    const wanted = new Set(fileTypes)
    const known = BUNDLE_FILE_TYPES.filter((fileType) => wanted.has(fileType))
    const extras = [...wanted].filter((fileType) => !BUNDLE_FILE_TYPES.includes(fileType)).sort()
    return [...known, ...extras]
}
