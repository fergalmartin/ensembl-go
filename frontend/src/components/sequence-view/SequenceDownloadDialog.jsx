import { useEffect, useRef, useState } from 'react'

import {
    COLOURED_EXPORT_WARN_BP,
    estimateColouredBytes,
    exportFormat,
    formatBytes,
    formatIsColoured,
} from '../../utils/sequenceViewExport'
import { groupDigits } from '../../utils/sequenceViewDisplay'

/**
 * Naming the file, and then watching it be written.
 *
 * A save box rather than a line in the panel, for two reasons the reader feels
 * directly. A large export used to be written first and named afterwards, by
 * whatever the browser decided -- so the reader waited without ever being asked
 * what to call the thing they were waiting for. And the warning about a very
 * large coloured file sat permanently at the bottom of the panel, turning the
 * button into "Download anyway", which reads as a scolding for a choice nobody
 * had made yet. Said here it is what it actually is: something to know before
 * pressing Save, with Cancel right beside it.
 *
 * The same box then stays up while the file is written. Writing is usually a
 * second or two and the box simply passes through that state; when it is longer
 * the reader has somewhere to look and something to stop.
 */
export default function SequenceDownloadDialog({
    request = null,
    isLight,
    busy = false,
    progress = '',
    fraction = null,
    error = '',
    onSave,
    onCancel,
}) {
    // Seeded once, because the box is mounted fresh for every download -- see
    // the `key` where it is rendered. A name the reader has edited is theirs
    // until they close it.
    const [name, setName] = useState(() => request?.suggestedName || '')
    const field = useRef(null)

    // Selected up to the extension, so typing replaces the name and keeps the
    // suffix -- which is what every save box does and what the fingers expect.
    useEffect(() => {
        if (busy) return
        const input = field.current
        if (!input) return
        input.focus()
        const dot = input.value.lastIndexOf('.')
        input.setSelectionRange(0, dot > 0 ? dot : input.value.length)
    }, [busy])

    if (!request) return null

    const descriptor = exportFormat(request.format)
    const coloured = formatIsColoured(request.format)
    const bases = request.bases || 0
    const heavy = coloured && bases > COLOURED_EXPORT_WARN_BP
    const estimate = estimateColouredBytes(bases)

    const overlay = isLight ? 'bg-black/40' : 'bg-black/60'
    const panel = isLight
        ? 'bg-white border border-gray-200 shadow-xl'
        : 'bg-gray-800 border border-gray-700 shadow-xl'
    const text = isLight ? 'text-gray-900' : 'text-gray-100'
    const muted = isLight ? 'text-gray-500' : 'text-gray-400'
    const input = isLight
        ? 'bg-white border border-gray-300 text-gray-900 focus:border-blue-500'
        : 'bg-gray-700 border border-gray-600 text-gray-100 focus:border-blue-400'

    const save = () => onSave?.(name)

    return (
        <div
            className={`fixed inset-0 z-50 flex items-center justify-center ${overlay}`}
            data-sequence-download-dialog="true"
            // A click outside cancels, as every other box in this app does --
            // but not while the file is being written, where it would look like
            // the work had been thrown away when it had not.
            onClick={(event) => { if (event.target === event.currentTarget && !busy) onCancel?.() }}
        >
            <div className={`${panel} mx-4 w-full max-w-md rounded-lg p-5`} role="dialog" aria-modal="true">
                <h2 className={`mb-1 text-base font-semibold ${text}`}>
                    {busy ? 'Writing the file' : `Save ${descriptor.extension.toUpperCase()}`}
                </h2>
                <p className={`mb-4 text-xs ${muted}`}>
                    {[
                        request.targetLabel,
                        bases > 0 ? `${groupDigits(bases)} ${request.unit || 'bp'}` : '',
                        coloured ? `about ${formatBytes(estimate)}` : '',
                    ].filter(Boolean).join(' · ')}
                </p>

                {heavy && !busy ? (
                    <p
                        data-download-warning="true"
                        className={`mb-4 rounded px-3 py-2 text-xs ${
                            isLight ? 'bg-amber-50 text-amber-900' : 'bg-amber-950/40 text-amber-200'
                        }`}
                    >
                        {`This is about ${formatBytes(estimate)}. Word processors will likely struggle `}
                        {'with this size. Selecting a smaller region, or focusing on particular sets of '}
                        {'features, is better suited to RTF. FASTA is a better option for very large sequences.'}
                    </p>
                ) : null}

                {busy ? (
                    <div className="mb-4">
                        <p className={`text-sm ${text}`}>{progress || 'Working…'}</p>
                        {/* Real where the work is a known number of blocks, and
                            a pulse while reading, where the number of requests
                            is known but not how long each will take. A bar that
                            looks determinate and is not says less than nothing. */}
                        <div
                            className={`mt-2 h-1 overflow-hidden rounded ${isLight ? 'bg-gray-200' : 'bg-gray-700'}`}
                            role="progressbar"
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
                        >
                            <div
                                className={`h-full rounded bg-blue-500 ${fraction === null ? 'w-1/3 animate-pulse' : 'transition-[width] duration-200'}`}
                                style={fraction === null ? undefined : { width: `${Math.round(fraction * 100)}%` }}
                            />
                        </div>
                    </div>
                ) : (
                    <label className="mb-4 block">
                        <span className={`mb-1 block text-xs font-medium ${muted}`}>File name</span>
                        <input
                            ref={field}
                            type="text"
                            data-download-name="true"
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') { event.preventDefault(); save() }
                                if (event.key === 'Escape') { event.preventDefault(); onCancel?.() }
                            }}
                            className={`w-full rounded px-2 py-1.5 text-sm outline-none ${input}`}
                        />
                    </label>
                )}

                {error ? (
                    <p className={`mb-3 text-xs ${isLight ? 'text-red-700' : 'text-red-300'}`}>{error}</p>
                ) : null}

                <div className="flex justify-end gap-2">
                    <button
                        type="button"
                        data-download-cancel="true"
                        onClick={() => onCancel?.()}
                        className={`rounded px-3 py-1.5 text-sm ${
                            isLight ? 'bg-gray-100 text-gray-700 hover:bg-gray-200' : 'bg-gray-700 text-gray-200 hover:bg-gray-600'
                        }`}
                    >
                        {busy ? 'Stop' : 'Cancel'}
                    </button>
                    {busy ? null : (
                        <button
                            type="button"
                            data-download-save="true"
                            onClick={save}
                            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500"
                        >
                            Save
                        </button>
                    )}
                </div>
            </div>
        </div>
    )
}
