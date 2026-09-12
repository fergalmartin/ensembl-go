import { useCallback, useEffect, useRef, useState } from 'react'

/** Portable prepare/publish lifecycle. Transport owns the sequence source.
 * Cancellation retains the previously published snapshot, including when a
 * response arrives after the user's cancel click or a newer Apply.
 */
export default function useMotifPreparation(transport, onReady) {
  const [progress, setProgress] = useState(null), [visible, setVisible] = useState(false)
  const current = useRef(null), ready = useRef(onReady)
  ready.current = onReady
  const cancel = useCallback(() => {
    const run = current.current
    if (!run) return
    run.cancelled = true
    run.controller.abort()
    if (run.id) transport.cancel(run.id).catch(() => {})
    current.current = null
    setProgress(null); setVisible(false)
  }, [transport])
  useEffect(() => () => {
    const run = current.current
    if (run) { run.cancelled = true; run.controller.abort(); if (run.id) transport.cancel(run.id).catch(() => {}) }
  }, [transport])
  const start = useCallback(async (settings, context) => {
    cancel()
    const run = { cancelled: false, controller: new AbortController(), id: null }
    current.current = run
    setProgress({ status: 'queued', total: 0, completed: 0, searched: 0, cached: 0 }); setVisible(false)
    const timer = setTimeout(() => { if (current.current === run) setVisible(true) }, 2000)
    try {
      // Do not abort job creation: even a cancellation during POST must receive
      // the ID and cancel the server job, rather than orphaning background work.
      let job = await transport.start(settings, context)
      run.id = job.id
      if (run.cancelled) { await transport.cancel(job.id); return }
      while (!['ready', 'failed', 'cancelled'].includes(job.status)) {
        setProgress(job)
        await new Promise(resolve => {
          const stop = () => { clearTimeout(wait); resolve() }
          const wait = setTimeout(() => { run.controller.signal.removeEventListener('abort', stop); resolve() }, 500)
          run.controller.signal.addEventListener('abort', stop, { once: true })
        })
        if (run.cancelled) return
        job = await transport.status(job.id, run.controller.signal)
      }
      if (job.status === 'failed') throw Error(job.error || 'Motif preparation failed')
      if (job.status === 'cancelled' || run.cancelled) {
        if (current.current === run) {
          current.current = null; setProgress(null); setVisible(false)
        }
        return
      }
      setProgress({ ...job, phase: 'publishing' })
      const result = await transport.finish(job, settings, run.controller.signal)
      if (current.current !== run || run.cancelled) return
      ready.current({ ...result, id: job.id, settings, context, stats: job })
      current.current = null; setProgress(null); setVisible(false)
    } catch (error) {
      if (current.current === run && !run.cancelled) {
        current.current = null
        setProgress(previous => ({ ...previous, status: 'failed', error: error.message })); setVisible(true)
      }
    } finally { clearTimeout(timer) }
  }, [transport, cancel])
  return { start, cancel, progress, visible, running: !!progress && progress.status !== 'failed', dismiss: () => { setProgress(null); setVisible(false) } }
}
