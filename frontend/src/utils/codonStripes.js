// Codon stripes that follow the alignment, not each row's own count.
//
// A CDS is drawn in two alternating shades, a codon each, so reading frame shows without
// counting. Counting each row's coding bases from its own start puts aligned codons out of
// step as soon as one row has an indel upstream (or a longer 5' end): the same codon, in
// the same columns, gets different shades in different rows. So the shade is worked out
// per alignment column instead. Every row votes, at each coding base, for that base's
// place in its codon (0, 1 or 2, counted from its start codon); a column takes the
// majority, and a new codon — the next shade — starts at each column whose majority place
// is 0. Every row's coding base in a column is then drawn in that column's shade, so
// aligned codons always match.

/**
 * `rows`: `[{ sequence, coding, anchor }]` — the aligned sequence, `coding` a per-column
 * mask (truthy where the row's CDS covers the column) and `anchor` the column its reading
 * frame starts at (its start codon). Returns `Int8Array(length)`: each column's shade
 * (0/1), or -1 where no row codes.
 */
export function alignedCodonStripes(rows, length) {
    const votes = [new Uint16Array(length), new Uint16Array(length), new Uint16Array(length)]
    for (const row of rows || []) {
        const seq = String(row?.sequence || '')
        const coding = row?.coding
        if (!coding) continue
        let n = 0
        for (let c = Math.max(0, Number(row.anchor) || 0); c < length; c += 1) {
            if (!coding[c] || seq.charCodeAt(c) === 45) continue
            votes[n % 3][c] += 1
            n += 1
        }
    }
    const stripes = new Int8Array(length).fill(-1)
    let codon = -1
    for (let c = 0; c < length; c += 1) {
        const a = votes[0][c], b = votes[1][c], d = votes[2][c]
        if (!a && !b && !d) continue
        const place = a >= b && a >= d ? 0 : b >= d ? 1 : 2
        if (place === 0 || codon < 0) codon += 1
        stripes[c] = codon % 2
    }
    return stripes
}

/**
 * A row's CDS as the stripes need it, from its alignment features (`{type, start, end}`
 * in columns): the coding mask and the reading frame's first column — a start codon that
 * reads ATG inside the CDS, else where the CDS begins. Null if the row has no CDS.
 */
export function rowCodingColumns(features, sequence, length) {
    const seq = String(sequence || '')
    const cds = (features || []).filter((f) => f?.type === 'cds')
    if (!cds.length) return null
    const coding = new Uint8Array(length)
    let first = Infinity
    for (const f of cds) {
        const lo = Math.max(0, Math.min(f.start, f.end)), hi = Math.min(length - 1, Math.max(f.start, f.end))
        for (let c = lo; c <= hi; c += 1) coding[c] = 1
        first = Math.min(first, lo)
    }
    let anchor = first
    const starts = (features || []).filter((f) => f?.type === 'start_codon').sort((a, b) => a.start - b.start)
    for (const sc of starts) {
        const codon = seq.substring(sc.start, sc.end + 1).replace(/-/g, '').toUpperCase()
        if (codon.startsWith('ATG') && coding[sc.start]) { anchor = sc.start; break }
    }
    return { coding, anchor }
}
