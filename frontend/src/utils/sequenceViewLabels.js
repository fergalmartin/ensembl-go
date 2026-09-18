// How this view writes down the small facts about a feature.
//
// One module because the same three facts -- what kind of thing it is, which
// strand it is on, how long it is -- are written in the gene list, the transcript
// list, the record headings, the box a click opens and the hover readout, and
// they were being written five different ways: "Protein-coding" in one place and
// "protein coding" in another, a bare "+" here and "+ strand" there.
//
// The rules:
//
//   * A biotype is the annotation's own word, lower case, with underscores as
//     spaces. `protein_coding` is "protein coding" everywhere. Names that carry
//     an acronym keep it: lncRNA, snoRNA, TEC.
//   * A strand is "+ strand" or "- strand", never a bare sign.
//   * Facts are separated by space, not by punctuation. A row of middle dots is
//     furniture: it takes a line that reads as three facts and makes it read as
//     one sentence with something missing.

/**
 * One word of a biotype, in this view's case.
 *
 * Only an ordinary capitalised English word is lowered -- "Protein", "Small",
 * "Pseudogene". Anything else keeps the shape the annotation gave it, because
 * the alternative is turning lncRNA into lncrna, TEC into tec and the
 * mitochondrial Mt into mt, which are not the same words in lower case.
 */
function normaliseWord(word) {
    return /^[A-Z][a-z]{3,}$/.test(word) ? word.toLowerCase() : word
}

/**
 * A biotype as this view writes it.
 *
 * From the raw biotype rather than from a display class, so that the gene list
 * and the box say the same thing about the same gene. The classes -- protein
 * coding, lncRNA, pseudogene, small non-coding -- are a different question, and
 * `geneBiotypes.js` answers that one.
 */
export function biotypeText(biotype) {
    const raw = String(biotype || '').trim()
    if (!raw) return ''
    // Split on the separators and keep them, so that "Protein-coding" comes back
    // hyphenated and "protein_coding" comes back spaced -- one word at a time,
    // rather than one rule for the whole string.
    return raw
        .replace(/_/g, ' ')
        .split(/([\s-])/)
        .map((piece) => (/^[\s-]$/.test(piece) ? piece : normaliseWord(piece)))
        .join('')
        .replace(/\s+/g, ' ')
        .trim()
}

/**
 * Which strand, as the sign alone.
 *
 * For putting beside a name rather than under it. "+ strand" under the symbol
 * spent a line and a word on one character, and a reader scanning a list of
 * genes for the one on the minus strand was reading the second line of every
 * row to find it.
 */
export function strandMark(strand) {
    const sign = String(strand || '').trim()
    return sign === '+' || sign === '-' ? sign : ''
}

/** Which strand, in words. */
export function strandText(strand) {
    const sign = String(strand || '').trim()
    if (sign !== '+' && sign !== '-') return ''
    return `${sign} strand`
}

/**
 * Facts in a row, for the places that can only hold a string.
 *
 * Where the markup is ours the parts are drawn as separate spans with a gap,
 * which separates them without spending a character on it. This is the fallback
 * for a title attribute or a truncated single line.
 */
export function metaText(...parts) {
    return parts.flat().filter(Boolean).join(' ')
}
