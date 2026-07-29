const ANALYSABLE_FILE_TYPES = new Set(['fasta', 'gff3'])

export function isAnalysableGenomeFileType(fileType) {
  return ANALYSABLE_FILE_TYPES.has(String(fileType || '').trim())
}

export function genomeAnalysisKind(fileType) {
  if (fileType === 'fasta') return 'genome'
  if (fileType === 'gff3') return 'annotation'
  return ''
}

export function buildGenomeAnalysisEntry(fileType, files, report, analysedAt = '') {
  const path = String(files?.[fileType] || '').trim()
  if (!isAnalysableGenomeFileType(fileType) || !path || !report) return null
  return {
    kind: genomeAnalysisKind(fileType),
    path,
    fasta_path: fileType === 'gff3' ? String(files?.fasta || '').trim() : '',
    analysed_at: String(analysedAt || '').trim(),
    report,
  }
}

export function getCurrentGenomeAnalysis(cache, genomeKey, fileType, files) {
  const key = String(genomeKey || '').trim()
  const path = String(files?.[fileType] || '').trim()
  if (!key || !path || !isAnalysableGenomeFileType(fileType)) return null
  const entry = cache?.[key]?.[fileType]
  if (!entry || String(entry.path || '').trim() !== path) return null
  if (
    fileType === 'gff3'
    && String(entry.fasta_path || '').trim() !== String(files?.fasta || '').trim()
  ) {
    return null
  }
  return entry
}

export function withGenomeAnalysis(cache, genomeKey, fileType, files, report, analysedAt = '') {
  const key = String(genomeKey || '').trim()
  const entry = buildGenomeAnalysisEntry(fileType, files, report, analysedAt)
  if (!key || !entry) return cache || {}
  return {
    ...(cache || {}),
    [key]: {
      ...((cache || {})[key] || {}),
      [fileType]: entry,
    },
  }
}

export function withoutGenomeAnalysis(cache, genomeKey, fileType) {
  const key = String(genomeKey || '').trim()
  if (!key || !cache?.[key]?.[fileType]) return cache || {}
  const nextGenome = { ...cache[key] }
  delete nextGenome[fileType]
  const next = { ...cache }
  if (Object.keys(nextGenome).length > 0) next[key] = nextGenome
  else delete next[key]
  return next
}
