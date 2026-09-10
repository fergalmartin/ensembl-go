/** Shared nucleotide colours for Genome Browser and Alignment Explorer. */
export const NUCLEOTIDE_COLORS = {
  light: { baseA: '#e74c3c', baseT: '#2ecc71', baseC: '#3498db', baseG: '#f39c12', baseN: '#95a5a6' },
  dark: { baseA: '#ff6b6b', baseT: '#51cf66', baseC: '#74c0fc', baseG: '#ffd43b', baseN: '#5c5f66' },
}
export const NUCLEOTIDE_GAP_COLOR = '#95a5a6'
export const NUCLEOTIDE_TEXT_COLOR = '#ffffff'
export const NUCLEOTIDE_LETTER_THRESHOLD = 10
export function getBaseColor(base, colors) {
  return colors[`base${String(base).toUpperCase()}`] || colors.baseN
}
