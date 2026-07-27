export function localVcfType(v) {
    const explicit = String(v?.type || '').trim().toLowerCase()
    if (explicit === 'snp' || explicit === 'snv') return 'snv'
    if (explicit === 'ins' || explicit === 'del') return explicit
    if (explicit === 'indel' || explicit === 'other' || explicit === 'complex') return 'indel'

    const ref = String(v?.ref || '')
    const firstAlt = String(v?.alt || '').split(',')[0] || ''
    const N = ref.length
    const M = firstAlt.length
    if (N === 1 && M === 1) return 'snv'
    if (N === 1 && M > 1 && ref[0] === firstAlt[0]) return 'ins'
    if (N > 1 && M === 1 && ref[0] === firstAlt[0]) return 'del'
    return 'indel'
}

export function getVcfRefEndExclusive(v) {
    const vpos = Number(v?.pos)
    const pos = Number.isFinite(vpos) ? vpos : 0
    const vendRaw = Number(v?.end ?? v?.pos)
    const vend = Number.isFinite(vendRaw) ? Math.max(pos, vendRaw) : pos
    const refLen = Math.max(1, String(v?.ref || '').length)
    const byLenEndExcl = pos + refLen
    const byEndEndExcl = vend + 1
    return Math.max(byLenEndExcl, byEndEndExcl)
}

export function getVcfAltAlleleCount(v) {
    const altRaw = String(v?.alt ?? '').trim()
    if (!altRaw) return 1
    return Math.max(1, altRaw.split(',').length)
}

export function shouldRenderActiveAnchorBase(vtype, active) {
    return !!active && (vtype === 'ins' || vtype === 'del')
}

export function getVcfDetailVariantLayout(v, explicitType = '') {
    const vtype = explicitType || localVcfType(v)
    const vposRaw = Number(v?.pos)
    const vpos = Number.isFinite(vposRaw) ? vposRaw : 0
    const anchorStart = vpos
    const anchorEnd = vpos + 1
    const refEndExcl = getVcfRefEndExclusive(v)
    const delStart = anchorEnd
    const delEnd = Math.max(delStart, refEndExcl)
    const hasDelSpan = delEnd > delStart

    if (vtype === 'ins') {
        return {
            vpos,
            anchorStart,
            anchorEnd,
            refStart: anchorStart,
            refEnd: anchorEnd,
            markerXGenomic: anchorEnd,
            hasDelSpan: false,
            delStart,
            delEnd,
        }
    }
    if (vtype === 'del') {
        return {
            vpos,
            anchorStart,
            anchorEnd,
            refStart: delStart,
            refEnd: delEnd,
            markerXGenomic: hasDelSpan ? (delStart + 0.5) : anchorEnd,
            hasDelSpan,
            delStart,
            delEnd,
        }
    }
    return {
        vpos,
        anchorStart,
        anchorEnd,
        refStart: anchorStart,
        refEnd: Math.max(anchorEnd, refEndExcl),
        markerXGenomic: anchorStart + 0.5,
        hasDelSpan: false,
        delStart,
        delEnd,
    }
}

