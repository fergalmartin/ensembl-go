// Whether each active genome is ready to browse (index built, files present).
import { API_BASE } from '../../../backendRuntime.js'
import { classifyReadiness } from '../../../utils/browserReadiness.js'

export function checkGenomeReadiness(ctx, panel) {
    const {
        readyCheckAttemptsRef,
        readyCheckInFlightRef,
        setBrowserReadyState,
    } = ctx
        const panelKey = panel.key
        const inFlight = readyCheckInFlightRef.current.get(panelKey)
        if (inFlight) return inFlight

        const updateState = (state, detail = '') => {
            setBrowserReadyState((prev) => {
                const current = prev?.[panelKey]
                if (current?.state === 'ready' && (state === 'checking' || state === 'pending')) {
                    return prev
                }
                if (current?.state === state && (current?.detail || '') === (detail || '')) {
                    // Nothing moved. Returning prev keeps a poll that is waiting
                    // out a long build from re-rendering every panel each time.
                    return prev
                }
                return {
                    ...prev,
                    [panelKey]: { state, detail },
                }
            })
        }

        // Counts consecutive "no such genome" answers only, not polls in
        // general: a genome that has just been added answers 404 until its files
        // land in the configuration, and that is the wait this budget is for.
        // Counting every poll would spend the budget waiting out a long index
        // build and then call the next blip fatal.
        const attemptKey = `${panelKey}|${panel.genomeParam}`
        const attempt = readyCheckAttemptsRef.current.get(attemptKey) || 0

        const run = (async () => {
            updateState('checking')
            let status = 0
            let ok = false
            let regionCount = 0
            let detail = ''
            try {
                const res = await fetch(`${API_BASE}/api/browse/regions?genome=${encodeURIComponent(panel.genomeParam)}`)
                status = res.status
                ok = res.ok
                if (ok) {
                    const data = await res.json()
                    regionCount = Array.isArray(data) ? data.length : 0
                } else {
                    try {
                        detail = (await res.json())?.detail || ''
                    } catch {
                        detail = ''
                    }
                }
            } catch {
                status = 0  // No response at all; treated as "try again".
            }

            if (status === 404) {
                readyCheckAttemptsRef.current.set(attemptKey, attempt + 1)
            } else {
                readyCheckAttemptsRef.current.delete(attemptKey)
            }

            const outcome = classifyReadiness({ ok, status, regionCount, attempt })
            updateState(outcome, outcome === 'ready' ? '' : detail)
            return outcome
        })()

        readyCheckInFlightRef.current.set(panelKey, run)
        run.finally(() => {
            if (readyCheckInFlightRef.current.get(panelKey) === run) {
                readyCheckInFlightRef.current.delete(panelKey)
            }
        })
        return run
    }
