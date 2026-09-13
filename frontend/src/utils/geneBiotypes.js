// Which display class a gene's biotype belongs to.
//
// Shared because three things have to agree about it: the browser canvas, which
// drops hidden classes before it draws; the control bar's class checkboxes; and
// the location drawer's feature list, which must list exactly what is drawn.

// ── Biotype classification ──────────────────────────────────────────────────
// Maps Ensembl biotype strings to one of four display classes.
// Genes whose class is in hiddenBiotypeClasses are excluded from rendering.
// Any biotype not listed falls back to pattern matching, then null (always shown).
export const BIOTYPE_CLASS = {
    // Protein-coding
    protein_coding: 'proteinCoding',
    IG_C_gene: 'proteinCoding', IG_D_gene: 'proteinCoding',
    IG_J_gene: 'proteinCoding', IG_V_gene: 'proteinCoding',
    TR_C_gene: 'proteinCoding', TR_D_gene: 'proteinCoding',
    TR_J_gene: 'proteinCoding', TR_V_gene: 'proteinCoding',
    // Pseudogene
    pseudogene: 'pseudogene',
    processed_pseudogene: 'pseudogene', unprocessed_pseudogene: 'pseudogene',
    transcribed_processed_pseudogene: 'pseudogene', transcribed_unprocessed_pseudogene: 'pseudogene',
    transcribed_unitary_pseudogene: 'pseudogene', translated_processed_pseudogene: 'pseudogene',
    unitary_pseudogene: 'pseudogene', polymorphic_pseudogene: 'pseudogene',
    IG_C_pseudogene: 'pseudogene', IG_D_pseudogene: 'pseudogene',
    IG_J_pseudogene: 'pseudogene', IG_V_pseudogene: 'pseudogene',
    TR_J_pseudogene: 'pseudogene', TR_V_pseudogene: 'pseudogene',
    // Long non-coding
    lncRNA: 'lncRNA', antisense: 'lncRNA',
    processed_transcript: 'lncRNA', retained_intron: 'lncRNA',
    sense_intronic: 'lncRNA', sense_overlapping: 'lncRNA',
    bidirectional_promoter_lncRNA: 'lncRNA', TEC: 'lncRNA',
    non_coding: 'lncRNA', macro_lncRNA: 'lncRNA',
    '3prime_overlapping_ncrna': 'lncRNA', '3prime_overlapping_ncRNA': 'lncRNA',
    // Small non-coding
    snRNA: 'smallNonCoding', snoRNA: 'smallNonCoding',
    miRNA: 'smallNonCoding', misc_RNA: 'smallNonCoding',
    rRNA: 'smallNonCoding', scRNA: 'smallNonCoding',
    scaRNA: 'smallNonCoding', vault_RNA: 'smallNonCoding',
    Mt_rRNA: 'smallNonCoding', Mt_tRNA: 'smallNonCoding',
    ribozyme: 'smallNonCoding', tRNA: 'smallNonCoding',
}
export function classifyBiotype(biotype) {
    if (!biotype) return 'proteinCoding'
    const direct = BIOTYPE_CLASS[biotype]
    if (direct) return direct
    const b = biotype.toLowerCase()
    if (b.includes('pseudogene')) return 'pseudogene'
    if (b.includes('lncrna') || b.includes('lnc_rna')) return 'lncRNA'
    if (b.includes('snrna') || b.includes('snorna') || b.includes('mirna') || b.includes('rrna')) return 'smallNonCoding'
    return null // unknown biotype — always show
}
