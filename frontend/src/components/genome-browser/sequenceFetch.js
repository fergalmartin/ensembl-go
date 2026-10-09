// Fetching the reference sequence for a Genome Browser panel's view when it is
// zoomed in far enough to show bases (served from the buffer when it already
// covers the view).
import { API_BASE } from '../../backendRuntime.js'

export function fetchViewSequence(ctx) {
    const {
        fetchingSeqRef,
        genome,
        genomicViewRange,
        isActive,
        pendingSeqTargetRef,
        selectedChrom,
        seqBufferRef,
        seqFetchEpochRef,
        serveSequenceFromBuffer,
        setSeqRange,
        setSequence,
        viewEnd,
        viewStart,
    } = ctx
        if (!isActive) return
        const epoch = ++seqFetchEpochRef.current
        const viewSpan = viewEnd - viewStart
        if (viewSpan > 1000 || !selectedChrom) {
            pendingSeqTargetRef.current = null
            setSequence(null)
            setSeqRange(null)
            return
        }

        const { start: gStart, end: gEnd } = genomicViewRange
        const visStart = Math.max(0, Math.floor(gStart))
        const visEnd = Math.ceil(gEnd)
        pendingSeqTargetRef.current = { genome, chrom: selectedChrom, visStart, visEnd }

        // Fast path: already covered by buffer.
        if (serveSequenceFromBuffer(selectedChrom, visStart, visEnd)) {
            return
        }

        // Buffer miss — chase the latest viewport target. If panning continues while
        // a request is in-flight, we fetch the newest target immediately afterwards.
        const fetchSeq = async () => {
            if (fetchingSeqRef.current) return
            fetchingSeqRef.current = true
            try {
                while (true) {
                    if (epoch !== seqFetchEpochRef.current) return
                    const target = pendingSeqTargetRef.current
                    if (!target) return

                    if (serveSequenceFromBuffer(target.chrom, target.visStart, target.visEnd)) {
                        const latest = pendingSeqTargetRef.current
                        if (
                            latest
                            && latest.genome === target.genome
                            && latest.chrom === target.chrom
                            && latest.visStart === target.visStart
                            && latest.visEnd === target.visEnd
                        ) {
                            pendingSeqTargetRef.current = null
                        }
                        continue
                    }

                    const gSpan = Math.max(1, target.visEnd - target.visStart)
                    const bufferSize = Math.min(Math.max(gSpan * 10, 2000), 50000)
                    const center = (target.visStart + target.visEnd) / 2
                    const fetchStart = Math.max(0, Math.floor(center - bufferSize / 2))
                    const fetchEnd = Math.ceil(center + bufferSize / 2)
                    const res = await fetch(
                        `${API_BASE}/api/browse/sequence?genome=${target.genome}&chrom=${target.chrom}&start=${fetchStart}&end=${fetchEnd}`
                    )
                    if (!res.ok) return
                    const data = await res.json()
                    seqBufferRef.current = {
                        chrom: target.chrom,
                        start: data.start,
                        end: data.end,
                        sequence: data.sequence,
                    }
                }
            } catch (e) {
                console.error('Failed to fetch sequence:', e)
            } finally {
                fetchingSeqRef.current = false
            }
        }

        const timer = setTimeout(fetchSeq, 10)
        return () => clearTimeout(timer)
    }
