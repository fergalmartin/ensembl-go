import { buildAvailableSvAlignmentRows } from './svCatalog.js'

/** Summarise the parsed config, including records that cannot yet be browsed. */
export function buildSvConfigSummary(config, {
  missingFiles = [], filesChecked = false, catalog = null, configPath = '',
  activeSpecies = [], inactiveSpecies = [],
} = {}) {
  const missing = new Set(missingFiles)
  const availability = buildAvailableSvAlignmentRows(catalog, activeSpecies, inactiveSpecies)
  const genomes = config?.genomes || {}
  const rows = []
  const usedGenomes = new Set()
  for (const pair of config?.pairs || []) {
    for (const alignment of pair.alignments || []) {
      const reference = genomes[alignment.reference] || {}
      const target = genomes[alignment.target] || {}
      usedGenomes.add(alignment.reference)
      usedGenomes.add(alignment.target)
      const tracks = [
        ...(reference.tracks || []), ...(target.tracks || []),
        ...((alignment.tracks || {})[alignment.reference] || []),
        ...((alignment.tracks || {})[alignment.target] || []),
      ]
      const paths = [alignment.chain, ...Object.values(alignment.legacy_mappings || {}), ...tracks.map((track) => track.path)]
      const rowMissing = [...new Set(paths.filter((path) => path && missing.has(path)))]
      const available = availability.find((row) => row.id === alignment.id && row.alignment.config_path === configPath)
      const status = rowMissing.length ? 'Missing files'
        : available ? ({ usable: 'Ready to select', downloadable: 'Download genomes', unavailable: 'Genomes unavailable', missing_files: 'Missing files' }[available.status])
          : filesChecked ? 'Files found' : 'Not checked'
      rows.push({
        id: alignment.id,
        label: alignment.label,
        reference: reference.assembly_name || reference.accession || alignment.reference,
        target: target.assembly_name || target.accession || alignment.target,
        trackCount: new Set(tracks.filter((track) => track.path).map((track) => track.path)).size,
        missingFiles: [...new Set([...rowMissing, ...(available?.missingFiles || [])])],
        status,
      })
    }
  }
  return { rows, alignmentCount: rows.length, genomeCount: usedGenomes.size, readyCount: rows.filter((row) => row.status === 'Ready to select').length }
}

export function svConfigValidationFeedback(result) {
  if (!result?.ok) return { tone: 'error', message: 'Validation failed. Fix the errors below before saving.' }
  const count = result.alignment_count || 0
  const missingCount = new Set(result.missing_files || []).size
  const countText = `${count} alignment${count === 1 ? '' : 's'}`
  return missingCount
    ? { tone: 'warning', message: `Validation passed: ${countText}. ${missingCount} referenced file${missingCount === 1 ? ' is' : 's are'} missing.` }
    : { tone: 'success', message: `Validation passed: ${countText}. All referenced files were found.` }
}
