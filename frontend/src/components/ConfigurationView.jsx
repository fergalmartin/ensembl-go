import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import FileBrowserModal from './FileBrowserModal'
import AppButtonIcon from './AppButtonIcon'
import {
    APP_BUTTON_META,
    DATA_VIEW_BUTTON_IDS,
    ACTION_BUTTON_IDS,
    IN_PROGRESS_VIEW_BUTTON_IDS,
    DEFAULT_ACTIVE_APP_BUTTONS,
    NON_DEACTIVATABLE_APP_BUTTON_IDS,
    normalizeActiveAppButtons,
} from '../appButtonConfig'
import { API_BASE } from '../backendRuntime'
import {
    DEFAULT_GENOME_COLOR,
    genomeColorPalette,
    normalizeCustomGenomeColors,
    normalizeGenomeColorAssignments,
    normalizeGenomeDefaultColor,
    sanitizeHexColor,
    withoutCustomGenomeColor,
} from '../genomeColorSchemes'
import GenomeColorPicker from './GenomeColorPicker'
import {
    BROWSING_CONTROL_DEVICES,
    BROWSING_CONTROL_SCHEMES,
    DEFAULT_BROWSING_CONTROL_SCHEME_ID,
    describeBrowsingControls,
    normalizeBrowsingControlSchemeId,
    resolveBrowsingControls,
} from '../utils/browsingControls'

/**
 * PathInput — A file/directory path field with optional native "Browse" button.
 */
function PathInput({ label, value, onChange, type = 'file', theme, helpText, onBrowse, tourId = '' }) {
    const isLight = theme === 'light'
    const inputRef = useRef(null)

    useEffect(() => {
        if (inputRef.current) {
            inputRef.current.scrollLeft = inputRef.current.scrollWidth
        }
    }, [value])

    const handleBrowse = () => {
        if (onBrowse) onBrowse(type)
    }

    return (
        <div className="mb-4 last:mb-0">
            <label className={`block text-sm font-semibold mb-1.5 ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
                {label}
            </label>
            {helpText && (
                <p className={`text-xs mb-1.5 ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>{helpText}</p>
            )}
            <div className="flex gap-2">
                <input
                    ref={inputRef}
                    data-tour-id={tourId || undefined}
                    type="text"
                    value={value || ''}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder={type === 'directory' ? '/path/to/directory' : '/path/to/file'}
                    className={`flex-1 px-3 py-2 rounded-lg text-sm border transition-colors focus:outline-none focus:ring-2 font-mono ${isLight
                        ? 'bg-white border-gray-300 text-gray-900 placeholder-gray-400 focus:ring-[#0099ff]/40 focus:border-[#0099ff]'
                        : 'bg-gray-700 border-gray-600 text-gray-100 placeholder-gray-500 focus:ring-blue-500/40 focus:border-blue-500'
                        }`}
                />
                <button
                    type="button"
                    onClick={handleBrowse}
                    className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5 shrink-0 ${isLight
                        ? 'bg-gray-100 text-gray-700 hover:bg-gray-200 border border-gray-300'
                        : 'bg-gray-600 text-gray-200 hover:bg-gray-500 border border-gray-500'
                        }`}
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                    Browse
                </button>
            </div>
        </div>
    )
}

/**
 * CollapsibleSection — A titled card that can be expanded/collapsed.
 */
function CollapsibleSection({ title, icon, defaultOpen = true, theme, tourId = '', children }) {
    const [open, setOpen] = useState(defaultOpen)
    const isLight = theme === 'light'

    return (
        <div className={`rounded-xl overflow-hidden ${isLight
            ? 'bg-white border border-gray-200 shadow-sm'
            : 'bg-gray-800 border border-gray-700'
            }`}>
            <button
                type="button"
                data-tour-id={tourId || undefined}
                onClick={() => setOpen(o => !o)}
                className={`w-full flex items-center justify-between px-6 py-4 text-left transition-colors ${isLight
                    ? 'hover:bg-gray-50'
                    : 'hover:bg-gray-750'
                    }`}
            >
                <div className={`flex items-center gap-2.5 text-base font-bold ${isLight ? 'text-gray-800' : 'text-gray-200'}`}>
                    {icon}
                    {title}
                </div>
                <svg
                    width="16" height="16" viewBox="0 0 16 16" fill="none"
                    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                    className={`shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''} ${isLight ? 'text-gray-400' : 'text-gray-500'}`}
                >
                    <path d="M4 6l4 4 4-4" />
                </svg>
            </button>
            {open && (
                <div className={`px-6 pb-6 border-t ${isLight ? 'border-gray-100' : 'border-gray-700'}`}>
                    <div className="pt-5">
                        {children}
                    </div>
                </div>
            )}
        </div>
    )
}

// ── Icons ────────────────────────────────────────────────────────────────────

const OutputsIcon = () => (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 10v3h12v-3M8 2v8M5 7l3 3 3-3" />
    </svg>
)

const GeneralIcon = () => (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="8" cy="8" r="6" />
        <path d="M8 2a6 6 0 0 0 0 12V2z" fill="currentColor" />
    </svg>
)

const PaletteIcon = () => (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 2.2A5.8 5.8 0 0 0 2.2 8c0 3.2 2.6 5.8 5.8 5.8h.2c.8 0 1.4-.6 1.4-1.4 0-.4-.2-.8-.5-1.1-.3-.3-.5-.7-.5-1.1 0-.8.6-1.4 1.4-1.4h1.3A2.5 2.5 0 0 0 13.8 8 5.8 5.8 0 0 0 8 2.2Z" />
        <circle cx="5.2" cy="6" r="0.9" fill="currentColor" stroke="none" />
        <circle cx="7.9" cy="4.8" r="0.9" fill="currentColor" stroke="none" />
        <circle cx="10.7" cy="6.1" r="0.9" fill="currentColor" stroke="none" />
        <circle cx="5.9" cy="9.2" r="0.9" fill="currentColor" stroke="none" />
    </svg>
)

const OrganiseAppsIcon = () => (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2.5" y="2.5" width="4" height="4" rx="0.8" />
        <rect x="7" y="2.5" width="4" height="4" rx="0.8" />
        <rect x="11.5" y="2.5" width="4" height="4" rx="0.8" />
        <rect x="2.5" y="7" width="4" height="4" rx="0.8" />
        <rect x="7" y="7" width="4" height="4" rx="0.8" />
        <rect x="11.5" y="7" width="4" height="4" rx="0.8" />
        <rect x="2.5" y="11.5" width="4" height="4" rx="0.8" />
        <rect x="7" y="11.5" width="4" height="4" rx="0.8" />
        <rect x="11.5" y="11.5" width="4" height="4" rx="0.8" />
    </svg>
)

const ConfigurationIcon = () => (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 2.5h7l3 3V13a1 1 0 0 1-1 1H3.8A1.3 1.3 0 0 1 2.5 12.7V3.8A1.3 1.3 0 0 1 3.8 2.5Z" />
        <path d="M10 2.5V6h3" />
        <path d="M5.2 8.2h5.6M5.2 10.2h5.6" />
    </svg>
)

export const IconTrash = ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
        <path d="M10 11v6M14 11v6" />
    </svg>
)

export const IconRefresh = ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 8a6 6 0 0 1 10.2-4.3L14 2v4h-4l1.6-1.6A4 4 0 1 0 12 8" />
    </svg>
)

function InlineTooltip({ text, theme }) {
    const isLight = theme === 'light'
    return (
        <span className={`pointer-events-none absolute left-1/2 top-full z-20 mt-2 -translate-x-1/2 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs shadow-lg opacity-0 transition-opacity group-hover:opacity-100 ${isLight ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-900 border border-gray-300'}`}>
            {text}
        </span>
    )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ConfigurationView({ config, onConfigChange, onSave, theme }) {
    const isLight = theme === 'light'
    const [saving, setSaving] = useState(false)
    const [clearingCache, setClearingCache] = useState(false)
    const [statusMessage, setStatusMessage] = useState(null)
    const [isIndexing, setIsIndexing] = useState(false)
    const [configPath, setConfigPath] = useState('')
    const [loadingConfig, setLoadingConfig] = useState(false)
    const [desktopPath, setDesktopPath] = useState('')
    const saveInputRef = useRef(null)

    useEffect(() => {
        if (saveInputRef.current) {
            saveInputRef.current.scrollLeft = saveInputRef.current.scrollWidth
        }
    }, [configPath])

    // Web File Browser state
    const [modalOpen, setModalOpen] = useState(false)
    const [modalMode, setModalMode] = useState('file')
    const [activeField, setActiveField] = useState(null)
    const [draggedButtonId, setDraggedButtonId] = useState(null)
    const [dragOverButtonId, setDragOverButtonId] = useState(null)
    const [inactiveDataPriority, setInactiveDataPriority] = useState(DATA_VIEW_BUTTON_IDS)
    const [inactiveActionPriority, setInactiveActionPriority] = useState(ACTION_BUTTON_IDS)
    const [defaultColorPickerOpen, setDefaultColorPickerOpen] = useState(false)
    const dragMovedRef = useRef(false)

    const showStatus = (msg, isError = false) => {
        setStatusMessage({ text: msg, isError })
        setTimeout(() => setStatusMessage(null), 3500)
    }

    const truncatePath = (path, maxLength = 50) => {
        if (!path || path.length <= maxLength) return path
        return '...' + path.slice(-(maxLength - 3))
    }

    const updateField = (field, value) => {
        onConfigChange((prevConfig) => {
            const base = prevConfig || config
            const updates = { [field]: value }
            if (field === 'ref_fasta' || field === 'ref_gff') {
                updates.ref_index = ''
            } else if (field === 'target_fasta' || field === 'target_gff') {
                updates.target_index = ''
            }
            return { ...base, ...updates }
        })
    }

    const openWebBrowser = (field, type) => {
        setActiveField(field)
        setModalMode(type)
        setModalOpen(true)
    }

    useEffect(() => {
        let cancelled = false

        const loadDesktopPath = async () => {
            try {
                const nextDesktopPath = await window.electronAPI?.getDesktopPath?.()
                if (!cancelled && nextDesktopPath) {
                    setDesktopPath(nextDesktopPath)
                }
            } catch {
                // Browser builds do not expose the Electron desktop path bridge.
            }
        }

        loadDesktopPath()

        return () => {
            cancelled = true
        }
    }, [])

    const getModalInitialPath = () => {
        if (activeField === 'output_dir') {
            return desktopPath || config.working_dir || '.'
        }
        return config.working_dir || '.'
    }

    const activeAppButtons = useMemo(
        () => normalizeActiveAppButtons(config.active_app_buttons),
        [config.active_app_buttons]
    )

    // Colours belong to genomes now, and are picked in the Genome Selector. What
    // is left here is the colour a genome wears until it is given one of its
    // own, and the palette every picker offers.
    const defaultGenomeColor = useMemo(
        () => normalizeGenomeDefaultColor(config.genome_default_color),
        [config.genome_default_color]
    )
    const customGenomeColors = useMemo(
        () => normalizeCustomGenomeColors(config.genome_color_palette),
        [config.genome_color_palette]
    )
    const assignedGenomeColorCount = useMemo(
        () => Object.keys(normalizeGenomeColorAssignments(config.genome_colors)).length,
        [config.genome_colors]
    )
    const fullGenomeColorPalette = useMemo(() => genomeColorPalette(config), [config])

    const orderByPriority = useCallback((ids, priority) => {
        const prioritized = priority.filter((id) => ids.includes(id))
        const remainder = ids.filter((id) => !prioritized.includes(id))
        return [...prioritized, ...remainder]
    }, [])

    const inactiveDataButtons = useMemo(() => {
        const available = DATA_VIEW_BUTTON_IDS.filter(
            (id) => !IN_PROGRESS_VIEW_BUTTON_IDS.includes(id) && !activeAppButtons.includes(id)
        )
        return orderByPriority(available, inactiveDataPriority)
    }, [activeAppButtons, inactiveDataPriority, orderByPriority])

    const inactiveInProgressButtons = useMemo(() => {
        const available = IN_PROGRESS_VIEW_BUTTON_IDS.filter((id) => !activeAppButtons.includes(id))
        return orderByPriority(available, inactiveDataPriority)
    }, [activeAppButtons, inactiveDataPriority, orderByPriority])

    const inactiveActionButtons = useMemo(() => {
        const available = ACTION_BUTTON_IDS.filter((id) => !activeAppButtons.includes(id))
        return orderByPriority(available, inactiveActionPriority)
    }, [activeAppButtons, inactiveActionPriority, orderByPriority])

    const setActiveButtons = (nextButtonsOrUpdater) => {
        onConfigChange((prevConfig) => {
            const base = prevConfig || config
            const prevButtons = normalizeActiveAppButtons(base.active_app_buttons)
            const rawNext = typeof nextButtonsOrUpdater === 'function'
                ? nextButtonsOrUpdater(prevButtons)
                : nextButtonsOrUpdater
            return { ...base, active_app_buttons: normalizeActiveAppButtons(rawNext) }
        })
    }

    const handleDefaultGenomeColorChange = useCallback((nextColor) => {
        const color = sanitizeHexColor(nextColor, defaultGenomeColor)
        onConfigChange((prevConfig) => {
            const base = prevConfig || config
            // A genome explicitly set to the *old* default has no stored
            // assignment (see `assignGenomeColors`), so it follows the new one —
            // which is what "default" has to mean for the setting to be useful.
            return { ...base, genome_default_color: color }
        })
        showStatus(`Default genome colour set to ${color}`)
    }, [config, defaultGenomeColor, onConfigChange])

    const handleRemoveCustomGenomeColor = useCallback((color) => {
        onConfigChange((prevConfig) => {
            const base = prevConfig || config
            return { ...base, genome_color_palette: withoutCustomGenomeColor(base.genome_color_palette, color) }
        })
        showStatus(`Removed ${color} from the palette`)
    }, [config, onConfigChange])

    const handleResetGenomeColors = useCallback(() => {
        onConfigChange((prevConfig) => {
            const base = prevConfig || config
            return { ...base, genome_colors: {} }
        })
        showStatus('Every genome is back on the default colour')
    }, [config, onConfigChange])

    const activateAppButton = (buttonId) => {
        setActiveButtons((prevButtons) => {
            if (prevButtons.includes(buttonId)) return prevButtons
            // The action buttons live at the end of the top bar, so a returning
            // data view goes in front of them rather than after them.
            if (APP_BUTTON_META[buttonId]?.kind === 'action') return [...prevButtons, buttonId]
            const firstActionIndex = prevButtons.findIndex(
                (id) => APP_BUTTON_META[id]?.kind === 'action'
            )
            if (firstActionIndex < 0) return [...prevButtons, buttonId]
            const next = [...prevButtons]
            next.splice(firstActionIndex, 0, buttonId)
            return next
        })
        setInactiveDataPriority((prev) => prev.filter((id) => id !== buttonId))
        setInactiveActionPriority((prev) => prev.filter((id) => id !== buttonId))
    }

    const deactivateAppButton = (buttonId) => {
        if (NON_DEACTIVATABLE_APP_BUTTON_IDS.includes(buttonId)) {
            showStatus('The Configuration button cannot be deactivated.', true)
            return
        }
        setActiveButtons((prevButtons) => {
            if (!prevButtons.includes(buttonId)) return prevButtons
            return prevButtons.filter((id) => id !== buttonId)
        })

        const kind = APP_BUTTON_META[buttonId]?.kind
        if (kind === 'data_view') {
            setInactiveDataPriority((prev) => [buttonId, ...prev.filter((id) => id !== buttonId)])
        } else {
            setInactiveActionPriority((prev) => [buttonId, ...prev.filter((id) => id !== buttonId)])
        }
    }

    const reorderActiveButtons = (sourceButtonId, targetButtonId) => {
        if (!sourceButtonId || !targetButtonId || sourceButtonId === targetButtonId) return
        setActiveButtons((prevButtons) => {
            const sourceIndex = prevButtons.indexOf(sourceButtonId)
            const targetIndex = prevButtons.indexOf(targetButtonId)
            if (sourceIndex < 0 || targetIndex < 0) return prevButtons
            const next = [...prevButtons]
            const [moved] = next.splice(sourceIndex, 1)
            next.splice(targetIndex, 0, moved)
            return next
        })
    }

    const resetAppButtonsToDefault = () => {
        setActiveButtons(DEFAULT_ACTIVE_APP_BUTTONS)
        setInactiveDataPriority(DATA_VIEW_BUTTON_IDS)
        setInactiveActionPriority(ACTION_BUTTON_IDS)
        showStatus('App button layout reset to default')
    }

    // ── Handlers ────────────────────────────────────────────────────────────

    const handleSave = async () => {
        setSaving(true)
        try {
            const res = await fetch(`${API_BASE}/api/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            })
            if (res.ok) {
                showStatus('Configuration saved')
                if (onSave) onSave()
            } else {
                showStatus('Failed to save configuration', true)
            }
        } catch (e) {
            showStatus(`Error: ${e.message}`, true)
        } finally {
            setSaving(false)
        }
    }

    const handleSaveAs = async () => {
        let path = configPath.trim()
        if (!path) { showStatus('Please enter a file path', true); return }
        if (!path.startsWith('/') && !path.startsWith('~') && config.working_dir) {
            path = `${config.working_dir.replace(/\/$/, '')}/${path}`
        }
        setSaving(true)
        try {
            const res = await fetch(`${API_BASE}/api/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...config, save_path: path })
            })
            if (res.ok) {
                showStatus(`Saved to: ${truncatePath(path)}`)
            } else {
                const err = await res.json()
                showStatus(`Failed to save: ${err.detail || 'Unknown error'}`, true)
            }
        } catch (e) {
            showStatus(`Error: ${e.message}`, true)
        } finally {
            setSaving(false)
        }
    }

    const handleLoadConfig = () => {
        setActiveField('LOAD_CONFIG')
        setModalMode('file')
        setModalOpen(true)
    }

    const performLoadConfig = async (path) => {
        setLoadingConfig(true)
        try {
            const res = await fetch(`${API_BASE}/api/config/load`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path })
            })
            if (res.ok) {
                const data = await res.json()
                onConfigChange(data)
                setConfigPath(path)
                showStatus(`Loaded: ${truncatePath(path)}`)
            } else {
                const err = await res.json()
                showStatus(`Failed to load: ${err.detail || 'Unknown error'}`, true)
            }
        } catch (e) {
            showStatus(`Error: ${e.message}`, true)
        } finally {
            setLoadingConfig(false)
        }
    }

    const handleBrowseSave = () => {
        openWebBrowser('SAVE_DIRECTORY', 'directory')
    }

    const handleGenerateIndexes = async () => {
        setIsIndexing(true)
        try {
            const res = await fetch(`${API_BASE}/api/index/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ generate: true, output_dir: config.output_dir, ref_gff: config.ref_gff, target_gff: config.target_gff })
            })
            if (res.ok) {
                showStatus('Indexes generated successfully')
                // Re-fetch config from backend so the new index paths appear in the UI
                if (onSave) onSave()
            } else {
                const err = await res.json()
                showStatus(`Indexing failed: ${err.detail || 'Unknown error'}`, true)
            }
        } catch (e) {
            showStatus(`Error: ${e.message}`, true)
        } finally {
            setIsIndexing(false)
        }
    }

    const handleClearCache = async () => {
        setClearingCache(true)
        try {
            const res = await fetch(`${API_BASE}/api/cache/clear`, { method: 'POST' })
            if (res.ok) {
                const data = await res.json()
                showStatus(`Cleared ${data.cleared} cached alignment file(s)`)
            }
        } catch (e) {
            showStatus(`Error: ${e.message}`, true)
        } finally {
            setClearingCache(false)
        }
    }

    const browsingSchemeId = normalizeBrowsingControlSchemeId(config.browsing_control_scheme)
    const browsingScheme = BROWSING_CONTROL_SCHEMES.find((s) => s.id === browsingSchemeId)
        || BROWSING_CONTROL_SCHEMES[0]
    const [browsingDevice, setBrowsingDevice] = useState('mouse')
    const browsingCheatSheet = useMemo(
        () => describeBrowsingControls(
            resolveBrowsingControls({ browsing_control_scheme: browsingSchemeId }),
            browsingDevice
        ),
        [browsingSchemeId, browsingDevice]
    )

    // Arrow keys move between options, as expected of a radio group.
    const handleBrowsingSchemeKeyDown = (e) => {
        const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1
            : (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0)
        if (!step) return
        e.preventDefault()
        const ids = BROWSING_CONTROL_SCHEMES.map((s) => s.id)
        const nextIndex = (ids.indexOf(browsingSchemeId) + step + ids.length) % ids.length
        updateField('browsing_control_scheme', ids[nextIndex])
    }

    const handleReset = () => {
        onConfigChange({
            working_dir: '', ref_fasta: '', ref_gff: '', target_fasta: '', target_gff: '',
            homologies_file: '', output_dir: '', ref_index: '', target_index: '', default_light_mode: false, dim_non_selected_genes: true,
            browsing_control_scheme: DEFAULT_BROWSING_CONTROL_SCHEME_ID,
            genome_default_color: DEFAULT_GENOME_COLOR,
            genome_colors: {},
            active_app_buttons: DEFAULT_ACTIVE_APP_BUTTONS,
        })
        showStatus('Configuration reset to defaults')
    }

    const handleModalSelect = (path) => {
        if (activeField === 'LOAD_CONFIG') {
            performLoadConfig(path)
        } else if (activeField === 'SAVE_DIRECTORY') {
            const currentName = configPath.split('/').pop()
            const filename = (currentName && currentName !== configPath && currentName !== '') ? currentName : 'config.cfg'
            const newPath = path.endsWith('/') ? path + filename : path + '/' + filename
            setConfigPath(newPath.replace(/\/\//g, '/'))
        } else if (activeField) {
            updateField(activeField, path)
        }
        setModalOpen(false)
    }

    // ── Shared styles ────────────────────────────────────────────────────────

    const btnPrimary = `px-4 py-2 rounded-lg text-sm font-semibold transition-colors flex items-center justify-center gap-2 ${isLight
        ? 'bg-[#0099ff] text-white hover:bg-[#0088ee] disabled:bg-gray-300 disabled:cursor-not-allowed'
        : 'bg-blue-600 text-white hover:bg-blue-500 disabled:bg-gray-700 disabled:cursor-not-allowed'}`

    const btnSecondary = `px-4 py-2 rounded-lg text-sm font-semibold transition-colors flex items-center justify-center gap-2 ${isLight
        ? 'bg-gray-200 text-gray-700 hover:bg-gray-300 border border-gray-300'
        : 'bg-gray-700 text-gray-300 hover:bg-gray-600 border border-gray-600'}`

    const btnPurple = `px-4 py-2 rounded-lg text-sm font-semibold transition-colors flex items-center justify-center gap-2 ${isLight
        ? 'bg-purple-600 text-white hover:bg-purple-700 disabled:bg-gray-300 disabled:cursor-not-allowed'
        : 'bg-purple-600 text-white hover:bg-purple-500 disabled:bg-gray-700 disabled:cursor-not-allowed'}`

    const divider = `border-t my-5 ${isLight ? 'border-gray-100' : 'border-gray-700'}`

    const subLabel = `text-xs uppercase tracking-wider font-bold mb-3 ${isLight ? 'text-gray-500' : 'text-gray-400'}`
    const appIconButtonActive = `relative w-12 h-12 rounded-lg flex items-center justify-center transition-all duration-200 border-2 cursor-pointer text-white ${isLight
        ? 'bg-[#0099ff] hover:bg-[#0088ee] border-transparent'
        : 'bg-[#0099ff] hover:bg-[#0088ee] border-transparent'
        }`
    const appIconButtonActionActive = `relative w-12 h-12 rounded-lg flex items-center justify-center transition-all duration-200 border-2 cursor-pointer ${isLight
        ? 'bg-[#bfe6ff] text-[#006fbf] hover:bg-[#cbeeff] border-[#0099ff]'
        : 'bg-[#bfe6ff] text-[#006fbf] hover:bg-[#cbeeff] border-[#0099ff]'
        }`
    const appIconButtonInactive = `relative w-12 h-12 rounded-lg flex items-center justify-center transition-all duration-200 border-2 cursor-pointer ${isLight
        ? 'bg-gray-300 text-gray-700 hover:bg-gray-400 border-gray-400'
        : 'bg-gray-700 text-gray-300 hover:bg-gray-600 border-gray-600'
        }`
    const appIconButtonActionInactive = `relative w-12 h-12 rounded-lg flex items-center justify-center transition-all duration-200 border-2 cursor-pointer ${isLight
        ? 'bg-[#e1f4ff] text-[#0077cc] hover:text-[#005f9f] hover:bg-[#cbeeff] border-[#0099ff]'
        : 'bg-[#e1f4ff] text-[#0077cc] hover:text-[#005f9f] hover:bg-[#cbeeff] border-[#0099ff]'
        }`

    // ── Render ───────────────────────────────────────────────────────────────

    return (
        <div className="h-full overflow-y-auto pr-2">
            <div className="max-w-3xl mx-auto space-y-4 pb-8">

                <FileBrowserModal
                    isOpen={modalOpen}
                    onClose={() => setModalOpen(false)}
                    onSelect={handleModalSelect}
                    initialPath={getModalInitialPath()}
                    mode={modalMode}
                    theme={theme}
                    extensions={(() => {
                        if (activeField === 'LOAD_CONFIG') return ['.cfg']
                        if (['ref_fasta', 'target_fasta'].includes(activeField)) return ['.fa', '.fna', '.fasta', '.fa.gz', '.fna.gz', '.fasta.gz', '.fa.bgz', '.fna.bgz', '.fasta.bgz']
                        if (['ref_gff', 'target_gff'].includes(activeField)) return ['.gff3', '.gff3.gz', '.gff3.bgz']
                        if (activeField === 'homologies_file') return ['.tsv', '.csv', '.txt']
                        return []
                    })()}
                />

                {/* Toast notification */}
                {statusMessage && (
                    <div className={`fixed top-24 right-4 sm:right-6 z-50 rounded-lg px-6 py-4 shadow-lg border backdrop-blur-sm max-w-[calc(100vw-32px)] sm:max-w-md break-words ${statusMessage.isError
                        ? 'bg-red-500/90 text-white border-red-400'
                        : 'bg-emerald-500/90 text-white border-emerald-400'
                        }`}>
                        <div className="flex items-center gap-3">
                            {statusMessage.isError
                                ? <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
                                : <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" strokeLinecap="round" strokeLinejoin="round" /><polyline points="22 4 12 14.01 9 11.01" strokeLinecap="round" strokeLinejoin="round" /></svg>
                            }
                            <span className="font-medium">{statusMessage.text}</span>
                        </div>
                    </div>
                )}

                {/* ── 2. Outputs ────────────────────────────────────────────── */}
                <CollapsibleSection title="Outputs" icon={<OutputsIcon />} theme={theme} defaultOpen={true} tourId="config-section-outputs">

                    <p className={subLabel}>Cache Directory</p>
                    <PathInput
                        tourId="config-output-dir"
                        label="Output Directory"
                        value={config.output_dir}
                        onChange={(v) => updateField('output_dir', v)}
                        type="directory"
                        workingDir={config.working_dir}
                        theme={theme}
                        helpText="Where alignment cache files and GFF3 indices are written."
                        onBrowse={(type) => openWebBrowser('output_dir', type)}
                    />

                    <div className={divider} />

                    <div className="flex gap-3 mt-4">
                        <button onClick={handleClearCache} disabled={clearingCache} className={btnSecondary}>
                            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M3 5h10M5 5V3h6v2M6 8v4M10 8v4M4 5l1 9h6l1-9" />
                            </svg>
                            {clearingCache ? 'Clearing Cache…' : 'Clear Cached Alignments'}
                        </button>
                    </div>

                    <div className={divider} />

                    <p className={subLabel}>Downloaded Genomes</p>
                    <p className={`text-xs mb-3 ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                        Remove all locally downloaded genome data to free up disk space. You will need to re-download them to visualise them again.
                    </p>
                    <div className="flex gap-3 mt-4">
                        <button
                            onClick={async () => {
                                if (window.confirm(`Are you sure you want to delete all downloaded genomes from ${config.output_dir}/local_data? This cannot be undone.`)) {
                                    setClearingCache(true) // Re-use loading state
                                    try {
                                        const res = await fetch(`${API_BASE}/api/data/clear`, {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ output_dir: config.output_dir })
                                        })
                                        const data = await res.json()
                                        if (res.ok) {
                                            showStatus(data.message)
                                        } else {
                                            showStatus(`Failed to clear data: ${data.detail}`, true)
                                        }
                                    } catch (e) {
                                        showStatus(`Error: ${e.message}`, true)
                                    } finally {
                                        setClearingCache(false)
                                    }
                                }
                            }}
                            disabled={clearingCache || !config.output_dir}
                            className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors flex items-center justify-center gap-2 ${isLight
                                ? 'bg-red-100 text-red-700 hover:bg-red-200 border border-red-200 disabled:bg-gray-100 disabled:text-gray-400 disabled:border-gray-200'
                                : 'bg-red-900/30 text-red-400 hover:bg-red-900/50 border border-red-800 disabled:bg-gray-800 disabled:text-gray-600 disabled:border-gray-700'
                                }`}
                        >
                            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M3 5h10M5 5V3h6v2M6 8v4M10 8v4M4 5l1 9h6l1-9" />
                            </svg>
                            Clear Downloaded Data
                        </button>
                    </div>
                </CollapsibleSection>

                {/* ── 4. Configuration file ─────────────────────────────────── */}
                <CollapsibleSection title="Configuration" icon={<ConfigurationIcon />} theme={theme} defaultOpen={false} tourId="config-section-configuration">

                    {/* Save to file */}
                    <p className={subLabel}>Save Configuration</p>
                    <p className={`text-xs mb-3 ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                        Export all settings (including index paths) to a file you can reload later.
                    </p>
                    <div className="flex gap-2 items-end mb-2">
                        <div className="flex-1">
                            <label className={`block text-sm font-semibold mb-1.5 ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
                                Save Path
                            </label>
                            <input
                                ref={saveInputRef}
                                type="text"
                                value={configPath}
                                onChange={(e) => setConfigPath(e.target.value)}
                                placeholder={config.working_dir ? `${config.working_dir}/my_config.cfg` : 'my_config.cfg'}
                                className={`w-full px-3 py-2 rounded-lg text-sm border transition-colors focus:outline-none focus:ring-2 font-mono ${isLight
                                    ? 'bg-white border-gray-300 text-gray-900 placeholder-gray-400 focus:ring-[#0099ff]/40 focus:border-[#0099ff]'
                                    : 'bg-gray-700 border-gray-600 text-gray-100 placeholder-gray-500 focus:ring-blue-500/40 focus:border-blue-500'
                                    }`}
                            />
                        </div>
                        <button
                            type="button"
                            onClick={handleBrowseSave}
                            className={`shrink-0 px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5 h-10 ${isLight
                                ? 'bg-gray-100 text-gray-700 hover:bg-gray-200 border border-gray-300'
                                : 'bg-gray-600 text-gray-200 hover:bg-gray-500 border border-gray-500'
                                }`}
                        >
                            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M2 13h12M2 3h5l2 2h5v7H2V3z" />
                            </svg>
                            Browse
                        </button>
                        <button
                            data-tour-id="config-save"
                            onClick={handleSaveAs}
                            disabled={saving || !configPath.trim()}
                            className={`shrink-0 h-10 ${btnPrimary}`}
                        >
                            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 14H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h6l3 3v9a1 1 0 0 1-1 1z" />
                            </svg>
                            {saving ? 'Saving…' : 'Save'}
                        </button>
                    </div>

                    <div className={divider} />

                    {/* Load / utilities */}
                    <p className={subLabel}>Load & Utilities</p>
                    <div className="grid grid-cols-2 gap-3 max-w-[400px]">
                        <button onClick={handleLoadConfig} disabled={loadingConfig} className={btnPrimary}>
                            {loadingConfig ? 'Loading…' : 'Load Configuration'}
                        </button>

                        <button onClick={handleReset} className={btnSecondary}>
                            Reset to Defaults
                        </button>
                    </div>
                </CollapsibleSection>

                {/* ── 5. Organise Apps ─────────────────────────────────────── */}
                <CollapsibleSection title="Organise Apps" icon={<OrganiseAppsIcon />} theme={theme} defaultOpen={false}>
                    <p className={`text-xs mb-4 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                        Drag active buttons to reorder the top app bar. Click an active button to deactivate it, or click an inactive button to add it back.
                    </p>

                    <p className={subLabel}>Active Buttons (Drag to Rearrange)</p>
                    <div className="grid grid-cols-4 sm:grid-cols-5 lg:grid-cols-6 gap-2">
                        {activeAppButtons.map((buttonId) => {
                            const meta = APP_BUTTON_META[buttonId]
                            if (!meta) return null
                            const isLocked = NON_DEACTIVATABLE_APP_BUTTON_IDS.includes(buttonId)
                            return (
                                <button
                                    key={`active-${buttonId}`}
                                    type="button"
                                    draggable
                                    onClick={() => {
                                        if (dragMovedRef.current) {
                                            dragMovedRef.current = false
                                            return
                                        }
                                        deactivateAppButton(buttonId)
                                    }}
                                    onDragStart={(event) => {
                                        event.dataTransfer.effectAllowed = 'move'
                                        event.dataTransfer.setData('text/plain', buttonId)
                                        setDraggedButtonId(buttonId)
                                        setDragOverButtonId(buttonId)
                                        dragMovedRef.current = false
                                    }}
                                    onDragEnter={(event) => {
                                        event.preventDefault()
                                        if (draggedButtonId && draggedButtonId !== buttonId) {
                                            setDragOverButtonId(buttonId)
                                            dragMovedRef.current = true
                                        }
                                    }}
                                    onDragOver={(event) => event.preventDefault()}
                                    onDrop={(event) => {
                                        event.preventDefault()
                                        const source = draggedButtonId || event.dataTransfer.getData('text/plain')
                                        reorderActiveButtons(source, buttonId)
                                        setDraggedButtonId(null)
                                        setDragOverButtonId(null)
                                        dragMovedRef.current = false
                                    }}
                                    onDragEnd={() => {
                                        setDraggedButtonId(null)
                                        setDragOverButtonId(null)
                                        setTimeout(() => { dragMovedRef.current = false }, 0)
                                    }}
                                    className={`${meta.kind === 'action' ? appIconButtonActionActive : appIconButtonActive} ${draggedButtonId === buttonId ? 'opacity-50 scale-[0.98]' : ''} ${dragOverButtonId === buttonId && draggedButtonId !== buttonId ? (isLight ? 'ring-2 ring-[#0099ff]/70' : 'ring-2 ring-blue-300/80') : ''}`}
                                    title={isLocked ? `${meta.label} (cannot be deactivated)` : meta.label}
                                >
                                    <AppButtonIcon buttonId={buttonId} isLight={isLight} />
                                    {isLocked && (
                                        <span className={`absolute -top-1 -right-1 text-[8px] px-1.5 py-0.5 rounded-full ${isLight ? 'bg-white text-[#0077cc] border border-[#0077cc]/30' : 'bg-gray-900 text-blue-300 border border-blue-400/40'}`}>
                                            lock
                                        </span>
                                    )}
                                </button>
                            )
                        })}
                    </div>

                    <div className={divider} />

                    <p className={subLabel}>Data Views</p>
                    <div className="grid grid-cols-4 sm:grid-cols-5 lg:grid-cols-6 gap-2">
                        {inactiveDataButtons.length === 0 && (
                            <div className={`col-span-full text-sm ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                No inactive data views.
                            </div>
                        )}
                        {inactiveDataButtons.map((buttonId) => {
                            const meta = APP_BUTTON_META[buttonId]
                            if (!meta) return null
                            return (
                                <button
                                    key={`inactive-data-${buttonId}`}
                                    type="button"
                                    onClick={() => activateAppButton(buttonId)}
                                    className={appIconButtonInactive}
                                    title={meta.label}
                                >
                                    <AppButtonIcon buttonId={buttonId} isLight={isLight} />
                                </button>
                            )
                        })}
                    </div>

                    <div className={`my-4 border-t ${isLight ? 'border-gray-100' : 'border-gray-700'}`} />

                    <p className={subLabel}>Action Buttons</p>
                    <div className="grid grid-cols-4 sm:grid-cols-5 lg:grid-cols-6 gap-2">
                        {inactiveActionButtons.length === 0 && (
                            <div className={`col-span-full text-sm ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                No inactive action buttons.
                            </div>
                        )}
                        {inactiveActionButtons.map((buttonId) => {
                            const meta = APP_BUTTON_META[buttonId]
                            if (!meta) return null
                            return (
                                <button
                                    key={`inactive-action-${buttonId}`}
                                    type="button"
                                    onClick={() => activateAppButton(buttonId)}
                                    className={appIconButtonActionInactive}
                                    title={meta.label}
                                >
                                    <AppButtonIcon buttonId={buttonId} isLight={isLight} />
                                </button>
                            )
                        })}
                    </div>

                    <div className={`my-4 border-t ${isLight ? 'border-gray-100' : 'border-gray-700'}`} />

                    <p className={subLabel}>In progress views</p>
                    <p className={`text-xs mb-2 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                        Views in this section are disabled by default at startup.
                    </p>
                    <div className="grid grid-cols-4 sm:grid-cols-5 lg:grid-cols-6 gap-2">
                        {inactiveInProgressButtons.length === 0 && (
                            <div className={`col-span-full text-sm ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                No inactive in progress views.
                            </div>
                        )}
                        {inactiveInProgressButtons.map((buttonId) => {
                            const meta = APP_BUTTON_META[buttonId]
                            if (!meta) return null
                            return (
                                <button
                                    key={`inactive-inprogress-${buttonId}`}
                                    type="button"
                                    onClick={() => activateAppButton(buttonId)}
                                    className={appIconButtonInactive}
                                    title={meta.label}
                                >
                                    <AppButtonIcon buttonId={buttonId} isLight={isLight} />
                                </button>
                            )
                        })}
                    </div>

                    <div className={divider} />

                    <div className="flex gap-3">
                        <button
                            type="button"
                            onClick={resetAppButtonsToDefault}
                            className={btnSecondary}
                        >
                            Reset App Buttons to Default
                        </button>
                    </div>
                </CollapsibleSection>

                {/* ── 6. Colour schemes ────────────────────────────────────── */}
                <CollapsibleSection title="Colour schemes" icon={<PaletteIcon />} theme={theme} defaultOpen={false}>
                    <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                            <p className={subLabel}>Default genome colour</p>
                            <p className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                The colour a genome is drawn in — pills, browser panels, alignment
                                tracks — until it is given one of its own. A genome's own colour is
                                set from the swatch beside its playlist and bin controls in the
                                Genome Selector.
                            </p>
                        </div>
                        <button
                            data-tour-id="config-default-genome-color"
                            type="button"
                            onClick={() => setDefaultColorPickerOpen(true)}
                            className={`shrink-0 inline-flex items-center gap-2 rounded-full border px-3 py-2 transition-colors ${isLight ? 'border-gray-300 bg-gray-50 hover:bg-gray-100' : 'border-gray-600 bg-gray-700 hover:bg-gray-600'}`}
                        >
                            <span
                                className="h-6 w-6 rounded-full border border-white/70 shadow-sm"
                                style={{ backgroundColor: defaultGenomeColor }}
                            />
                            <span className={`text-sm font-mono ${isLight ? 'text-gray-700' : 'text-gray-200'}`}>
                                {defaultGenomeColor}
                            </span>
                        </button>
                    </div>

                    <div className={`my-4 ${divider}`} />

                    <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                            <p className={subLabel}>Custom palette</p>
                            <p className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                {customGenomeColors.length === 0
                                    ? 'Colours you mix in a genome\u2019s colour picker are kept here, ready for the next genome.'
                                    : `${customGenomeColors.length} colour${customGenomeColors.length === 1 ? '' : 's'} of your own, offered alongside the ten built-in ones.`}
                            </p>
                        </div>
                    </div>
                    {customGenomeColors.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-2">
                            {customGenomeColors.map((color) => (
                                <button
                                    key={color}
                                    type="button"
                                    onClick={() => handleRemoveCustomGenomeColor(color)}
                                    title={`${color} — click to remove from the palette`}
                                    className={`group relative h-8 w-8 rounded-full border-2 transition-transform hover:scale-105 ${isLight ? 'border-white' : 'border-gray-800'}`}
                                    style={{ backgroundColor: color }}
                                >
                                    <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100">
                                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                                            <path d="M4 4l8 8M12 4l-8 8" />
                                        </svg>
                                    </span>
                                </button>
                            ))}
                        </div>
                    )}

                    <div className={`my-4 ${divider}`} />

                    <div className="flex items-center justify-between gap-4">
                        <div className="min-w-0">
                            <p className={subLabel}>Per-genome colours</p>
                            <p className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                {assignedGenomeColorCount === 0
                                    ? 'No genome has been given a colour of its own yet.'
                                    : `${assignedGenomeColorCount} genome${assignedGenomeColorCount === 1 ? ' has' : 's have'} a colour of their own.`}
                            </p>
                        </div>
                        <div className="relative group shrink-0">
                            <button
                                type="button"
                                onClick={handleResetGenomeColors}
                                disabled={assignedGenomeColorCount === 0}
                                className={`${btnSecondary} ${assignedGenomeColorCount === 0 ? 'opacity-40 cursor-not-allowed' : ''}`}
                            >
                                Clear
                            </button>
                            <InlineTooltip
                                theme={theme}
                                text="Put every genome back on the default colour."
                            />
                        </div>
                    </div>

                    <GenomeColorPicker
                        isOpen={defaultColorPickerOpen}
                        theme={theme}
                        title="Default genome colour"
                        subtitle="Every genome without a colour of its own"
                        palette={fullGenomeColorPalette}
                        currentColor={defaultGenomeColor}
                        defaultColor={DEFAULT_GENOME_COLOR}
                        onApply={handleDefaultGenomeColorChange}
                        onClose={() => setDefaultColorPickerOpen(false)}
                    />
                </CollapsibleSection>

                {/* ── 7. General ────────────────────────────────────────────── */}
                <CollapsibleSection title="General" icon={<GeneralIcon />} theme={theme} defaultOpen={false}>
                    <div className="flex items-center justify-between">
                        <div>
                            <p className={`text-sm font-semibold ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
                                Default to Light Mode
                            </p>
                            <p className={`text-xs mt-0.5 ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                                Start the application in light mode instead of dark mode
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={() => updateField('default_light_mode', !config.default_light_mode)}
                            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${config.default_light_mode
                                ? (isLight ? 'bg-[#0099ff]' : 'bg-blue-500')
                                : (isLight ? 'bg-gray-300' : 'bg-gray-600')
                                }`}
                        >
                            <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform shadow-sm ${config.default_light_mode ? 'translate-x-6' : 'translate-x-1'}`} />
                        </button>
                    </div>

                    <div className={`my-4 ${divider}`} />

                    <div className="flex items-center justify-between">
                        <div>
                            <p className={`text-sm font-semibold ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
                                Dim Non-Selected Genes
                            </p>
                            <p className={`text-xs mt-0.5 ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                                When a focus gene is selected, render other genes in grey
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={() => updateField('dim_non_selected_genes', !(config.dim_non_selected_genes !== false))}
                            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${(config.dim_non_selected_genes !== false)
                                ? (isLight ? 'bg-[#0099ff]' : 'bg-blue-500')
                                : (isLight ? 'bg-gray-300' : 'bg-gray-600')
                                }`}
                        >
                            <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform shadow-sm ${(config.dim_non_selected_genes !== false) ? 'translate-x-6' : 'translate-x-1'}`} />
                        </button>
                    </div>

                    <div className={`my-4 ${divider}`} />

                    <div className="flex items-center justify-between">
                        <div>
                            <p className={`text-sm font-semibold ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
                                Hide Inactive SV Tracks
                            </p>
                            <p className={`text-xs mt-0.5 ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                                Collapse toggled-off gene and sequence tracks to zero height in the SV view
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={() => updateField('sv_hide_inactive_tracks', !config.sv_hide_inactive_tracks)}
                            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${config.sv_hide_inactive_tracks
                                ? (isLight ? 'bg-[#0099ff]' : 'bg-blue-500')
                                : (isLight ? 'bg-gray-300' : 'bg-gray-600')
                                }`}
                        >
                            <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform shadow-sm ${config.sv_hide_inactive_tracks ? 'translate-x-6' : 'translate-x-1'}`} />
                        </button>
                    </div>

                    <div className={`my-4 ${divider}`} />

                    <div className="flex items-center justify-between">
                        <div>
                            <p className={`text-sm font-semibold ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
                                Show FPS Counter
                            </p>
                            <p className={`text-xs mt-0.5 ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                                Display a frames-per-second counter in the top-left corner
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={() => updateField('show_fps_counter', !config.show_fps_counter)}
                            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${config.show_fps_counter
                                ? (isLight ? 'bg-[#0099ff]' : 'bg-blue-500')
                                : (isLight ? 'bg-gray-300' : 'bg-gray-600')
                                }`}
                        >
                            <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform shadow-sm ${config.show_fps_counter ? 'translate-x-6' : 'translate-x-1'}`} />
                        </button>
                    </div>

                    <div className={`my-4 ${divider}`} />

                    <div>
                        <p className={`text-sm font-semibold ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
                            Browsing Controls
                        </p>
                        <p className={`text-xs mt-0.5 ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                            How the mouse, trackpad and keyboard pan and zoom the data tracks in the
                            Genome Browser, Feature Explorer, Neighbourhood and Structural Variation views
                        </p>

                        <div
                            role="radiogroup"
                            aria-label="Browsing controls"
                            className="mt-3 flex flex-wrap gap-2"
                            onKeyDown={handleBrowsingSchemeKeyDown}
                        >
                            {BROWSING_CONTROL_SCHEMES.map((scheme) => {
                                const selected = scheme.id === browsingSchemeId
                                return (
                                    <button
                                        key={scheme.id}
                                        type="button"
                                        role="radio"
                                        aria-checked={selected}
                                        tabIndex={selected ? 0 : -1}
                                        onClick={() => updateField('browsing_control_scheme', scheme.id)}
                                        className={`text-xs px-3 py-1.5 rounded-md font-medium transition-colors border ${selected
                                            ? (isLight
                                                ? 'bg-[#0099ff] border-[#0099ff] text-white'
                                                : 'bg-blue-500 border-blue-500 text-white')
                                            : (isLight
                                                ? 'bg-white border-gray-300 text-gray-600 hover:bg-gray-100'
                                                : 'bg-[#1E2938] border-gray-600 text-gray-300 hover:bg-[#373a40]')
                                            }`}
                                    >
                                        {scheme.label}
                                    </button>
                                )
                            })}
                        </div>

                        <p className={`text-xs mt-3 leading-relaxed ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                            {browsingScheme.description}
                        </p>

                        {/* Generated from the same source the browser uses, so it
                            can never drift from what the gestures actually do. */}
                        <div
                            role="tablist"
                            aria-label="Input device"
                            className={`mt-3 inline-flex rounded-md border p-0.5 ${isLight ? 'border-gray-300 bg-gray-100' : 'border-gray-600 bg-[#161d29]'}`}
                        >
                            {BROWSING_CONTROL_DEVICES.map((device) => {
                                const selected = device.id === browsingDevice
                                return (
                                    <button
                                        key={device.id}
                                        type="button"
                                        role="tab"
                                        aria-selected={selected}
                                        onClick={() => setBrowsingDevice(device.id)}
                                        className={`text-xs px-3 py-1 rounded font-medium transition-colors ${selected
                                            ? (isLight ? 'bg-white text-gray-800 shadow-sm' : 'bg-[#373a40] text-gray-100')
                                            : (isLight ? 'text-gray-500 hover:text-gray-700' : 'text-gray-400 hover:text-gray-200')
                                            }`}
                                    >
                                        {device.label}
                                    </button>
                                )
                            })}
                        </div>

                        <dl className={`mt-2 rounded-lg border text-xs ${isLight ? 'border-gray-200 bg-gray-50' : 'border-gray-700 bg-[#161d29]'}`}>
                            {browsingCheatSheet.map((row, idx) => (
                                <div
                                    key={row.gesture}
                                    className={`flex gap-3 px-3 py-1.5 ${idx > 0 ? (isLight ? 'border-t border-gray-200' : 'border-t border-gray-700') : ''}`}
                                >
                                    <dt className={`w-56 shrink-0 font-medium ${isLight ? 'text-gray-600' : 'text-gray-300'}`}>
                                        {row.gesture}
                                    </dt>
                                    <dd className={isLight ? 'text-gray-500' : 'text-gray-400'}>{row.action}</dd>
                                </div>
                            ))}
                        </dl>

                        {browsingDevice === 'trackpad' && (
                            <p className={`text-xs mt-2 ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                                Keyboard shortcuts work the same on a trackpad — see the Mouse &amp; keyboard tab.
                            </p>
                        )}
                    </div>
                </CollapsibleSection>

            </div>
        </div>
    )
}
