import { useEffect, useMemo, useRef, useState } from 'react'
import { API_BASE } from '../../backendRuntime.js'
import { trackAssemblyKey } from '../../utils/genomeIdentity.js'
import { DEFAULT_BATCH_NAMING, applySettingsChange, batchLabel, groupFilesByType, suggestStartIndex } from '../../utils/trackBatch.js'
import { groupsForAssembly } from '../../utils/trackGroups.js'
import { checkCustomZones, rememberCustomZones } from '../../utils/zonedScale.js'
import FileBrowserModal from '../FileBrowserModal'
import { NEW_TRACK_GROUP, TRACK_TYPES, TYPE_COLORS, basenameFromPath, customZoneProblem, defaultTypeSettings, detectTypeFromPath, normalizeBigWigDisplayMode, normalizeBigWigSettings, sameTypeSettings, settingsFromTrack, settingsToTrackFields, stemFromPath, typeHasSettings, typeLabelOf } from './trackManagerModel.js'
import { GenomeComboBox, GenomeNote } from './trackManagerParts'
import { TypeSettingsEditor } from './trackSettingsEditors'

// ── Registration Wizard ───────────────────────────────────────────────────────
//
// One file or many. Picking a single file gives the familiar form, laid out in two
// columns; ticking several in the file browser (of any mix of types) gives a list of the
// files grouped by type beside an editor for whatever is selected: a whole type group —
// its naming pattern and the settings its files share — or one file, which can take its
// own label and settings. Every file joins the one genome chosen at the top, and all of
// them are registered together.

export function RegistrationWizard({
    isLight,
    genomeOptions,
    onClose,
    onRegistered,
    initialBrowsePath,
    seed = null,
    existingLabels = [],
    // 'edit': the same dialog over tracks already registered (one or many), saving
    // changes to them rather than registering files.
    mode = 'register',
    editTracks = null,
    onUpdated = null,
    // Registering can put the new tracks straight into a track group of their genome.
    trackGroups = [],
    onGroupSaved = null,
}) {
    const isEdit = mode === 'edit'
    const [step, setStep] = useState(isEdit ? 2 : 1)
    // { id, path, detectedType, type, label, labelEdited, custom } — `custom` is the file's
    // own settings, or null to share its type group's.
    const [files, setFiles] = useState([])
    // type -> { settings, naming }
    const [groups, setGroups] = useState({})
    const [genomeKey, setGenomeKey] = useState('')
    // Editing tracks from different genomes: the field starts empty, and stays out of the
    // save unless a genome is chosen, so each keeps its own.
    const [genomeMixed, setGenomeMixed] = useState(false)
    const [genomeTouched, setGenomeTouched] = useState(false)
    // Registering with no genome: the tracks that would be left without one, to confirm.
    const [noGenomePrompt, setNoGenomePrompt] = useState(false)
    // '' for no group, NEW_TRACK_GROUP for a new one named `newGroupName`, else a group id.
    const [groupChoice, setGroupChoice] = useState('')
    const [newGroupName, setNewGroupName] = useState('')
    const genomeFieldRef = useRef(null)
    const [selection, setSelection] = useState(null) // { kind: 'group', key: type } | { kind: 'file', key: id }
    const [fileBrowserOpen, setFileBrowserOpen] = useState(false)
    const [registering, setRegistering] = useState(false)
    const [progress, setProgress] = useState(null)
    const [error, setError] = useState('')
    const [failures, setFailures] = useState({})
    const nextIdRef = useRef(1)
    // The folder the file browser last showed, and where it opens next: Back, or adding
    // more files, returns there rather than to the start of the tree. A ref, not state —
    // the browser reports every folder it passes through, and re-rendering on each would
    // re-point it and drop the files ticked so far.
    const lastDirectoryRef = useRef('')
    const [browserStart, setBrowserStart] = useState('')
    // The list as it stands, for adding to it from the file browser's callback.
    const filesRef = useRef(files)
    filesRef.current = files

    const withGroup = (prev, type, patch = null) => {
        if (!type) return prev
        const current = prev[type] || { settings: defaultTypeSettings(type), naming: { ...DEFAULT_BATCH_NAMING } }
        return { ...prev, [type]: patch ? { ...current, ...patch } : current }
    }

    const makeFile = (path, extra = {}) => {
        const detectedType = detectTypeFromPath(path)
        return {
            id: `f${nextIdRef.current++}`,
            path,
            detectedType,
            type: detectedType || '',
            label: '',
            labelEdited: false,
            custom: null,
            ...extra,
        }
    }

    /* A tutorial's picture of this form. Set rather than merged, so walking back into a
     * step that shows a file chosen and no data type yet shows exactly that, even if the
     * reader had gone on to choose one. `seededAt` is a timestamp rather than a flag, so
     * re-entering the same step is a fresh request — "empty" has to be re-established on
     * the way back even though nothing about the step changed. A tutorial is always about
     * one file, so it seeds a list of one. */
    useEffect(() => {
        if (!seed) return
        const nextFiles = seed.filePath ? [makeFile(seed.filePath, { label: seed.label || '', labelEdited: true })] : []
        let nextGroups = {}
        const type = nextFiles[0]?.type
        if (type) {
            const settings = defaultTypeSettings(type)
            if (type === 'bigwig') {
                settings.bigWigDataType = seed.dataType || ''
                settings.bigWigSettings = normalizeBigWigSettings(seed.dataType ? { data_type: seed.dataType } : null)
            }
            if (seed.displayMode) settings.displayMode = seed.displayMode
            nextGroups = { [type]: { settings, naming: { ...DEFAULT_BATCH_NAMING } } }
        }
        setFiles(nextFiles)
        setGroups(nextGroups)
        setSelection(type ? { kind: 'group', key: type } : null)
        setStep(seed.step === 2 ? 2 : 1)
        setGenomeKey(seed.genomeKey || '')
        lastDirectoryRef.current = ''
        setBrowserStart('')
        setFileBrowserOpen(Boolean(seed.browserOpen))
        setError('')
        setFailures({})
        setProgress(null)
    }, [seed?.seededAt])  // eslint-disable-line react-hooks/exhaustive-deps

    // Editing: the tracks as they are. Each type group starts from its first track's
    // settings, and any track that differs keeps its own, so opening the dialog changes
    // nothing by itself. Names are kept unless the user asks to rename from a pattern.
    useEffect(() => {
        if (!isEdit || !Array.isArray(editTracks)) return
        const nextGroups = {}
        const nextFiles = editTracks.map((track) => {
            const type = track.type || ''
            const settings = settingsFromTrack(track)
            if (type && !nextGroups[type]) nextGroups[type] = { settings, naming: { ...DEFAULT_BATCH_NAMING, renaming: false } }
            return {
                id: `t:${track.id}`,
                trackId: track.id,
                path: track.path,
                detectedType: type,
                type,
                label: track.label || '',
                originalLabel: track.label || '',
                labelEdited: true,
                custom: type && sameTypeSettings(settings, nextGroups[type].settings) ? null : settings,
            }
        })
        // Compared by assembly, as the Track Manager groups them: the same genome can be
        // registered with and without a dataset suffix, and that is not a mix of genomes.
        // Left untouched, each track keeps its exact key (genome_key is not sent).
        const genomeKeys = editTracks.map((t) => String(t.genome_key || ''))
        const assemblies = new Set(genomeKeys.map((key) => (key ? trackAssemblyKey(key) : '')))
        setGenomeKey(assemblies.size === 1 ? genomeKeys[0] : '')
        setGenomeMixed(assemblies.size > 1)
        setGenomeTouched(false)
        setFiles(nextFiles)
        setGroups(nextGroups)
        const firstType = nextFiles[0]?.type
        setSelection(firstType ? { kind: 'group', key: firstType } : null)
        setStep(2)
    }, [isEdit, editTracks])

    const addPaths = (paths) => {
        const known = new Set(filesRef.current.map((f) => f.path))
        const fresh = []
        for (const path of paths) {
            if (!path || known.has(path)) continue
            known.add(path)
            fresh.push(makeFile(path))
        }
        if (!fresh.length) {
            setStep(filesRef.current.length ? 2 : 1)
            return
        }
        setFiles((prev) => [...prev, ...fresh.filter((f) => !prev.some((p) => p.path === f.path))])
        setGroups((prev) => fresh.reduce((acc, f) => withGroup(acc, f.type), prev))
        setSelection((prev) => prev || (fresh[0]?.type ? { kind: 'group', key: fresh[0].type } : fresh[0] ? { kind: 'file', key: fresh[0].id } : null))
        setError('')
        setStep(2)
    }

    const updateFile = (id, patch) => setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)))
    const removeFile = (id) => {
        setFiles((prev) => prev.filter((f) => f.id !== id))
        setFailures((prev) => { const next = { ...prev }; delete next[id]; return next })
        setSelection((prev) => (prev?.kind === 'file' && prev.key === id ? null : prev))
    }
    const setFileType = (id, type) => {
        updateFile(id, { type, custom: null })
        setGroups((prev) => withGroup(prev, type))
    }

    const grouped = useMemo(() => groupFilesByType(files, TRACK_TYPES.map((t) => t.id)), [files])
    const isSingle = files.length === 1
    const onlyFile = isSingle ? files[0] : null

    const namingFor = (type) => {
        const naming = { ...DEFAULT_BATCH_NAMING, ...(groups[type]?.naming || {}) }
        return naming.startIndexEdited ? naming : { ...naming, startIndex: suggestStartIndex(existingLabels, naming.prefix) }
    }
    const labelFor = (file) => {
        if (file.labelEdited) return file.label
        const group = grouped.find((g) => g.type === file.type)
        const index = group ? group.files.findIndex((f) => f.id === file.id) : 0
        return batchLabel(namingFor(file.type), stemFromPath(file.path), Math.max(0, index))
    }
    const settingsFor = (file) => file.custom || groups[file.type]?.settings || defaultTypeSettings(file.type)

    // What stops registration, as sentences, once each.
    const genomeTrackGroups = useMemo(
        () => (genomeKey ? groupsForAssembly(trackGroups, genomeKey) : []),
        [trackGroups, genomeKey]
    )
    const chosenGroup = isEdit || !genomeKey
        ? ''
        : groupChoice === NEW_TRACK_GROUP || genomeTrackGroups.some((g) => g.id === groupChoice) ? groupChoice : ''

    const problems = useMemo(() => {
        const out = []
        const add = (text) => { if (!out.includes(text)) out.push(text) }
        if (chosenGroup === NEW_TRACK_GROUP && !newGroupName.trim()) add('Give the new track group a name.')
        for (const file of files) {
            const name = basenameFromPath(file.path)
            if (!file.type) { add(`${name}: choose a track type.`); continue }
            if (!String(labelFor(file) || '').trim()) add(`${name}: give it a label.`)
            const settings = settingsFor(file)
            if (file.type === 'bigwig') {
                if (!settings.bigWigDataType) {
                    add(file.custom ? `${name}: choose a BigWig data type.` : isSingle ? 'Choose a BigWig data type.' : 'BigWig files: choose a data type.')
                }
                const zones = customZoneProblem(
                    settings.bigWigSettings,
                    normalizeBigWigDisplayMode(settings.displayMode, settings.bigWigDataType || settings.bigWigSettings?.data_type),
                )
                if (zones) add(file.custom || isSingle ? zones : `BigWig files: ${zones}`)
            }
        }
        return out
        // labelFor/settingsFor read these; listing them keeps the sentences current.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [files, groups, grouped, existingLabels, isSingle, chosenGroup, newGroupName])

    const buildRequest = (file, sharedZones = null) => {
        const { fields, spliceWarning } = settingsToTrackFields(file.type, settingsFor(file))
        return {
            spliceWarning,
            body: {
                path: file.path,
                label: labelFor(file),
                type: file.type,
                ...fields,
                // Editing leaves each track's genome alone unless one was chosen here.
                genome_key: isEdit && !genomeTouched ? undefined : (genomeKey || ''),
                // Scaled across the files registered together: their shared edges.
                bigwig_settings: fields.bigwig_settings && sharedZones
                    ? { ...fields.bigwig_settings, zone_scale: 'files', shared_zones: sharedZones }
                    : fields.bigwig_settings,
            },
        }
    }

    const handleRegister = async ({ withoutGenome = false } = {}) => {
        if (problems.length || !files.length) return
        // Easy to forget, and a track with no genome is never drawn until it gets one: say
        // so, and let the user go back or go ahead.
        if (!isEdit && !genomeKey && !withoutGenome) {
            setNoGenomePrompt(true)
            return
        }
        const order = grouped.flatMap((g) => g.files)
        // Labels fixed now, so a file that fails keeps the name it was about to get even
        // though the files registered around it leave the list.
        const labels = new Map(order.map((f) => [f.id, labelFor(f)]))
        setError('')
        setFailures({})
        setRegistering(true)

        // BigWigs sharing "scaled to the peaks" on a zoned heatmap are scaled across all of
        // them: their peaks are measured together, once, and every one stores the same
        // edges, so the tracks can be compared directly.
        let sharedZones = null
        const sharingIds = new Set()
        const bigWigSettings = groups.bigwig?.settings
        const sharing = (grouped.find((g) => g.type === 'bigwig')?.files || []).filter((f) => !f.custom)
        const sharedMode = bigWigSettings
            ? normalizeBigWigDisplayMode(bigWigSettings.displayMode, bigWigSettings.bigWigDataType || bigWigSettings.bigWigSettings?.data_type)
            : ''
        if (sharing.length > 1 && sharedMode === 'zoned_heatmap' && bigWigSettings?.bigWigSettings?.zone_scale === 'file') {
            setProgress({ measuring: sharing.length })
            try {
                const res = await fetch(`${API_BASE}/api/browse/bigwig/zone_scale`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ paths: sharing.map((f) => f.path) }),
                })
                const data = await res.json().catch(() => ({}))
                const thresholds = Array.isArray(data?.thresholds) ? data.thresholds.map(Number) : []
                if (!res.ok || thresholds.length !== 4) throw new Error(data?.detail || 'no peaks were found')
                sharedZones = thresholds
                for (const f of sharing) sharingIds.add(f.id)
            } catch (e) {
                setRegistering(false)
                setProgress(null)
                setError(`Could not measure the peaks across the ${sharing.length} BigWig files: ${e.message}. Nothing was ${isEdit ? 'saved' : 'registered'}.`)
                return
            }
        }

        setProgress({ done: 0, total: order.length })
        const failed = {}
        const succeeded = new Set()
        const registeredIds = []
        for (const [index, file] of order.entries()) {
            try {
                const { body } = buildRequest(file, sharingIds.has(file.id) ? sharedZones : null)
                const res = await fetch(isEdit ? `${API_BASE}/api/tracks/${encodeURIComponent(file.trackId)}` : `${API_BASE}/api/tracks`, {
                    method: isEdit ? 'PUT' : 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                })
                const data = await res.json().catch(() => ({}))
                if (!res.ok) throw new Error(data?.detail || `HTTP ${res.status}`)
                if (isEdit) onUpdated?.(data)
                else onRegistered(data)
                succeeded.add(file.id)
                if (data?.id) registeredIds.push(String(data.id))
                const zones = body.bigwig_settings
                if (zones?.zone_scale === 'custom') rememberCustomZones(checkCustomZones(zones.custom_zones).zones)
            } catch (e) {
                failed[file.id] = e.message || (isEdit ? 'Saving failed' : 'Registration failed')
            }
            setProgress({ done: index + 1, total: order.length })
        }
        let groupError = ''
        if (chosenGroup && registeredIds.length) {
            try {
                const existing = genomeTrackGroups.find((g) => g.id === chosenGroup)
                const res = existing
                    ? await fetch(`${API_BASE}/api/track-groups/${encodeURIComponent(existing.id)}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ members: [...existing.members, ...registeredIds.map((id) => ({ track_id: id, settings: null }))] }),
                    })
                    : await fetch(`${API_BASE}/api/track-groups`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            label: newGroupName.trim(),
                            genome_key: genomeKey,
                            layout: 'separate',
                            members: registeredIds.map((id) => ({ track_id: id, settings: null })),
                        }),
                    })
                const data = await res.json().catch(() => ({}))
                if (!res.ok) throw new Error(data?.detail || `HTTP ${res.status}`)
                onGroupSaved?.(data)
            } catch (e) {
                groupError = `The tracks were registered, but adding them to the group failed: ${e.message}. Add them from the Track Manager's selection bar.`
            }
        }
        setRegistering(false)
        if (!Object.keys(failed).length) {
            // Registered: nothing left here to fix, so say it where it will be seen.
            if (groupError) window.alert(groupError)
            onClose()
            return
        }
        setFiles((prev) => prev
            .filter((f) => !succeeded.has(f.id))
            .map((f) => ({ ...f, label: labels.get(f.id) ?? f.label, labelEdited: true })))
        setFailures(failed)
        setSelection(null)
        setProgress(null)
        setError(succeeded.size
            ? `${succeeded.size} of ${order.length} ${isEdit ? 'saved' : 'registered'}. The rest are still here, each with what went wrong.`
            : Object.values(failed)[0])
    }

    const inputCls = `w-full px-3 py-2 rounded-lg text-sm border focus:outline-none focus:ring-2 ${isLight
        ? 'bg-white border-gray-300 text-gray-900 focus:ring-blue-500/40 focus:border-blue-500'
        : 'bg-gray-700 border-gray-600 text-gray-100 focus:ring-blue-500/40 focus:border-blue-500'}`
    const labelCls = `block text-xs font-medium mb-1.5 ${isLight ? 'text-gray-700' : 'text-gray-300'}`
    const mutedCls = isLight ? 'text-gray-500' : 'text-gray-400'
    const panelCls = `rounded-xl border p-4 ${isLight ? 'border-gray-200 bg-gray-50/60' : 'border-gray-700 bg-gray-800/30'}`

    const openBrowser = () => {
        setBrowserStart(lastDirectoryRef.current)
        setFileBrowserOpen(true)
    }

    const genomeBlock = (
        <div data-tour-id="track-wizard-genome" ref={genomeFieldRef}>
            <label className={labelCls}>
                Genome association <span className={`font-normal ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                    ({isSingle ? 'needed to show the track' : `for every ${isEdit ? 'track' : 'file'}`})
                </span>
            </label>
            <GenomeComboBox
                value={genomeKey}
                onChange={(value) => { setGenomeKey(value); setGenomeTouched(true) }}
                genomeOptions={genomeOptions}
                isLight={isLight}
            />
            {isEdit && genomeMixed && !genomeTouched && (
                <p className={`text-xs mt-1 ${isLight ? 'text-amber-600' : 'text-amber-400'}`}>
                    These tracks belong to different genomes. Leave this empty to keep each one&apos;s, or choose a genome to move them all.
                </p>
            )}
            <GenomeNote genomeKey={genomeKey} genomeOptions={genomeOptions} isLight={isLight} />
            {!genomeKey && !(isEdit && genomeMixed && !genomeTouched) && (
                <p className={`text-xs mt-1 ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                    Tracks are shown in the Genome Browser only when the matching genome is active.
                </p>
            )}
            {!isEdit && genomeKey && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                    <label htmlFor="track-wizard-group" className={`text-xs font-medium ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
                        Add to track group
                    </label>
                    <select
                        id="track-wizard-group"
                        data-tour-id="track-wizard-group"
                        value={chosenGroup}
                        onChange={(e) => setGroupChoice(e.target.value)}
                        className={`${inputCls} !w-auto min-w-[12rem] !py-1.5`}
                    >
                        <option value="">None</option>
                        {genomeTrackGroups.map((g) => (
                            <option key={g.id} value={g.id}>{g.label} ({g.members.length} track{g.members.length === 1 ? '' : 's'})</option>
                        ))}
                        <option value={NEW_TRACK_GROUP}>New group…</option>
                    </select>
                    {chosenGroup === NEW_TRACK_GROUP && (
                        <input
                            type="text"
                            data-tour-id="track-wizard-group-name"
                            value={newGroupName}
                            maxLength={120}
                            placeholder="Group name"
                            onChange={(e) => setNewGroupName(e.target.value)}
                            className={`${inputCls} !w-auto flex-1 min-w-[10rem] !py-1.5`}
                        />
                    )}
                    {chosenGroup && (
                        <span className={`basis-full text-xs ${mutedCls}`}>
                            {chosenGroup === NEW_TRACK_GROUP
                                ? 'A new group of these tracks, in this order. Its name, order and layout can be changed from its card.'
                                : 'Added at the end of the group, using their own settings.'}
                        </span>
                    )}
                </div>
            )}
        </div>
    )

    // The single-file form's is the tutorial's anchor; a file within a group has none.
    const typeSelect = (file) => (
        <select
            data-tour-id={isSingle ? 'track-wizard-type' : undefined}
            value={file.type || ''}
            onChange={(e) => setFileType(file.id, e.target.value)}
            // A registered track's type is fixed; re-register the file to read it another way.
            disabled={isEdit}
            title={isEdit ? 'A registered track keeps its type' : undefined}
            className={`${inputCls} disabled:opacity-60`}
        >
            {!file.type && <option value="">Select type…</option>}
            {TRACK_TYPES.map((t) => (
                <option key={t.id} value={t.id}>{t.label} — {t.ext}</option>
            ))}
        </select>
    )

    // ── One file: the familiar form, in two columns ──────────────────────────
    const singleForm = onlyFile && (
        <div className="grid gap-6 md:grid-cols-2">
            <div className="space-y-4">
                <div>
                    <span className={labelCls}>{isEdit ? 'File' : 'Selected file'}</span>
                    <div data-tour-id="track-wizard-file" className={`px-3 py-2 rounded-lg text-xs font-mono break-all ${isLight ? 'bg-gray-50 text-gray-600 border border-gray-200' : 'bg-gray-800 text-gray-300 border border-gray-700'}`}>
                        {onlyFile.path}
                    </div>
                    {failures[onlyFile.id] && (
                        <p className={`text-xs mt-1.5 ${isLight ? 'text-red-600' : 'text-red-400'}`}>Not registered: {failures[onlyFile.id]}</p>
                    )}
                </div>
                <div>
                    <span className={labelCls}>Track type</span>
                    {isEdit ? null : onlyFile.detectedType ? (
                        <p className={`text-xs mb-2 ${isLight ? 'text-green-600' : 'text-green-400'}`}>
                            ✓ Auto-detected as <strong>{typeLabelOf(onlyFile.detectedType)}</strong>
                        </p>
                    ) : (
                        <p className={`text-xs mb-2 ${isLight ? 'text-amber-600' : 'text-amber-400'}`}>
                            ⚠ Could not auto-detect type — please select below
                        </p>
                    )}
                    {typeSelect(onlyFile)}
                </div>
                <div>
                    <label className={labelCls}>Label</label>
                    <input
                        data-tour-id="track-wizard-label"
                        type="text"
                        value={labelFor(onlyFile)}
                        onChange={(e) => updateFile(onlyFile.id, { label: e.target.value, labelEdited: true })}
                        className={inputCls}
                        placeholder="Track label…"
                    />
                </div>
                {genomeBlock}
            </div>
            <div>
                {onlyFile.type && (
                    <TypeSettingsEditor
                        type={onlyFile.type}
                        value={settingsFor(onlyFile)}
                        allowAutomatic={!isEdit}
                        onChange={(next) => {
                            // A lone track edits its settings directly, whether or not they
                            // matched the group they would otherwise share.
                            if (onlyFile.custom) updateFile(onlyFile.id, { custom: next })
                            else setGroups((prev) => withGroup(prev, onlyFile.type, { settings: next }))
                        }}
                        isLight={isLight}
                        labelCls={labelCls}
                        inputCls={inputCls}
                        trackLabel={labelFor(onlyFile)}
                    />
                )}
                {onlyFile.type && !typeHasSettings(onlyFile.type) && (
                    <p className={`text-sm ${mutedCls}`}>{typeLabelOf(onlyFile.type)} tracks have no further settings.</p>
                )}
            </div>
        </div>
    )

    // ── Several files: groups on the left, the selected group or file on the right ──
    const selectedGroup = selection?.kind === 'group' ? grouped.find((g) => g.type === selection.key) : null
    const selectedFile = selection?.kind === 'file' ? files.find((f) => f.id === selection.key) : null

    const groupEditor = selectedGroup && (() => {
        const type = selectedGroup.type
        const naming = namingFor(type)
        const setNaming = (patch) => setGroups((prev) => withGroup(prev, type, { naming: { ...namingFor(type), ...patch } }))
        const ownSettings = selectedGroup.files.filter((f) => f.custom).length
        const handNamed = selectedGroup.files.filter((f) => f.labelEdited).length
        return (
            <div className="space-y-5">
                <div>
                    <h3 className={`text-sm font-semibold ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>
                        {type ? `All ${typeLabelOf(type)} files` : 'Files that need a type'} · {selectedGroup.files.length}
                    </h3>
                    <p className={`text-xs mt-0.5 ${mutedCls}`}>
                        {type ? `Names and settings here apply to every ${typeLabelOf(type)} ${isEdit ? 'track' : 'file'}. Select one on the left to change just that one.` : 'Select each file on the left to choose its type.'}
                    </p>
                </div>
                {type && (
                    <div className={panelCls} data-tour-id="track-wizard-naming">
                        <div className={`text-xs font-semibold uppercase tracking-wide mb-3 ${mutedCls}`}>Names</div>
                        {isEdit && (
                            <label className={`flex items-center gap-2 text-sm mb-3 ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
                                <input
                                    type="checkbox"
                                    checked={Boolean(naming.renaming)}
                                    onChange={(e) => {
                                        const renaming = e.target.checked
                                        setNaming({ renaming })
                                        // On: the pattern names them. Off: back to the names they had.
                                        const ids = new Set(selectedGroup.files.map((f) => f.id))
                                        setFiles((prev) => prev.map((f) => (ids.has(f.id)
                                            ? (renaming ? { ...f, labelEdited: false } : { ...f, label: f.originalLabel ?? f.label, labelEdited: true })
                                            : f)))
                                    }}
                                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                />
                                Rename these {selectedGroup.files.length} tracks from a pattern
                            </label>
                        )}
                        <fieldset disabled={isEdit && !naming.renaming} className="disabled:opacity-50">
                        <div className="grid gap-3 sm:grid-cols-3 items-end">
                            <div>
                                <label className={labelCls}>Prefix</label>
                                <input
                                    type="text"
                                    value={naming.prefix}
                                    placeholder="e.g. lung"
                                    onChange={(e) => setNaming({ prefix: e.target.value })}
                                    className={inputCls}
                                />
                            </div>
                            <label className={`flex items-center gap-2 text-sm pb-2 ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
                                <input
                                    type="checkbox"
                                    checked={naming.useFileName}
                                    onChange={(e) => setNaming({ useFileName: e.target.checked })}
                                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                />
                                Include the file name
                            </label>
                            <div className="flex items-end gap-2">
                                <label className={`flex items-center gap-2 text-sm pb-2 whitespace-nowrap ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
                                    <input
                                        type="checkbox"
                                        checked={naming.numbered}
                                        onChange={(e) => setNaming({ numbered: e.target.checked })}
                                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                    />
                                    Number from
                                </label>
                                <input
                                    type="number"
                                    min="0"
                                    value={naming.startIndex}
                                    disabled={!naming.numbered}
                                    onChange={(e) => setNaming({ startIndex: Math.max(0, Math.trunc(Number(e.target.value) || 0)), startIndexEdited: true })}
                                    className={`${inputCls} w-24 disabled:opacity-40`}
                                    aria-label="First number"
                                />
                            </div>
                        </div>
                        {naming.numbered && !naming.startIndexEdited && naming.startIndex > 1 && !isEdit && (
                            <p className={`text-xs mt-2 ${mutedCls}`}>
                                Carries on from the {naming.prefix.trim()} tracks already registered.
                            </p>
                        )}
                        <div className={`mt-3 text-xs ${mutedCls}`}>
                            <span className="font-medium">Preview: </span>
                            {selectedGroup.files.slice(0, 5).map((f) => labelFor(f)).join(', ')}
                            {selectedGroup.files.length > 5 ? `, … (${selectedGroup.files.length} in all)` : ''}
                        </div>
                        {handNamed > 0 && !isEdit && (
                            <p className={`text-xs mt-1 ${mutedCls}`}>
                                {handNamed === 1 ? 'One file has' : `${handNamed} files have`} a name typed by hand, which is kept.
                            </p>
                        )}
                        </fieldset>
                    </div>
                )}
                {type && (
                    <div className={panelCls}>
                        <div className={`text-xs font-semibold uppercase tracking-wide mb-3 ${mutedCls}`}>
                            Settings for {ownSettings && !isEdit ? `${selectedGroup.files.length - ownSettings} of ${selectedGroup.files.length}` : `all ${selectedGroup.files.length}`}
                        </div>
                        {isEdit && ownSettings > 0 && (
                            <p className={`text-xs mb-3 ${isLight ? 'text-amber-600' : 'text-amber-400'}`}>
                                These tracks differ in some settings; this shows the first one&apos;s. A change here is made on every track, and whatever you leave alone stays as each track has it.
                            </p>
                        )}
                        <TypeSettingsEditor
                            type={type}
                            value={groups[type]?.settings || defaultTypeSettings(type)}
                            onChange={(next) => {
                                const before = groups[type]?.settings || defaultTypeSettings(type)
                                setGroups((prev) => withGroup(prev, type, { settings: next }))
                                // Editing: the change reaches tracks with their own settings too,
                                // field by field, and a track left matching the group rejoins it.
                                if (isEdit) {
                                    setFiles((prev) => prev.map((f) => {
                                        if (f.type !== type || !f.custom) return f
                                        const changed = applySettingsChange(before, next, f.custom)
                                        return { ...f, custom: sameTypeSettings(changed, next) ? null : changed }
                                    }))
                                }
                            }}
                            isLight={isLight}
                            labelCls={labelCls}
                            inputCls={inputCls}
                            sharedFileCount={selectedGroup.files.length - ownSettings}
                            allowAutomatic={!isEdit}
                        />
                        {ownSettings > 0 && (
                            <div className={`flex flex-wrap items-center gap-2 text-xs mt-3 ${mutedCls}`}>
                                <span>
                                    {isEdit
                                        ? `${ownSettings === 1 ? 'One track differs' : `${ownSettings} tracks differ`} from the first in other settings.`
                                        : `${ownSettings === 1 ? 'One file keeps its' : `${ownSettings} files keep their`} custom settings and ${ownSettings === 1 ? 'is' : 'are'} not changed here.`}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => {
                                        const ids = new Set(selectedGroup.files.map((f) => f.id))
                                        setFiles((prev) => prev.map((f) => (ids.has(f.id) ? { ...f, custom: null } : f)))
                                    }}
                                    className="text-blue-500 hover:underline"
                                >
                                    {isEdit ? 'Make them all match this' : `Use these settings for all ${selectedGroup.files.length}`}
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </div>
        )
    })()

    const fileEditor = selectedFile && (() => {
        const file = selectedFile
        return (
            <div className="space-y-5">
                <div>
                    <h3 className={`text-sm font-semibold break-all ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>{labelFor(file) || basenameFromPath(file.path)}</h3>
                    <p className={`text-xs mt-0.5 font-mono break-all ${mutedCls}`}>{file.path}</p>
                    {failures[file.id] && (
                        <p className={`text-xs mt-2 ${isLight ? 'text-red-600' : 'text-red-400'}`}>Not registered: {failures[file.id]}</p>
                    )}
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                        <label className={labelCls}>Track type</label>
                        {typeSelect(file)}
                    </div>
                    <div>
                        <label className={labelCls}>Label</label>
                        <input
                            type="text"
                            value={labelFor(file)}
                            onChange={(e) => updateFile(file.id, { label: e.target.value, labelEdited: true })}
                            className={inputCls}
                        />
                        {file.labelEdited && file.type && (
                            <button type="button" onClick={() => updateFile(file.id, { labelEdited: false, label: '' })} className="text-xs text-blue-500 hover:underline mt-1">
                                Use the group&apos;s naming
                            </button>
                        )}
                    </div>
                </div>
                {file.type && (
                    <div className={panelCls}>
                        <label className={`flex items-center gap-2 text-sm mb-3 ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
                            <input
                                type="checkbox"
                                checked={!file.custom}
                                onChange={(e) => updateFile(file.id, {
                                    custom: e.target.checked ? null : { ...(groups[file.type]?.settings || defaultTypeSettings(file.type)) },
                                })}
                                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                            />
                            Use the settings shared by all {typeLabelOf(file.type)} files
                        </label>
                        {file.custom ? (
                            <TypeSettingsEditor
                                type={file.type}
                                value={file.custom}
                                allowAutomatic={!isEdit}
                                onChange={(next) => updateFile(file.id, { custom: next })}
                                isLight={isLight}
                                labelCls={labelCls}
                                inputCls={inputCls}
                                trackLabel={labelFor(file)}
                            />
                        ) : (
                            <p className={`text-xs ${mutedCls}`}>Untick to give this file custom settings.</p>
                        )}
                    </div>
                )}
            </div>
        )
    })()

    const sidebar = (
        <div className={`flex flex-col min-h-0 border-r ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
            <div className="flex-1 overflow-y-auto p-3 space-y-3">
                {grouped.map((group) => {
                    const groupSelected = selection?.kind === 'group' && selection.key === group.type
                    return (
                        <div key={group.type || 'untyped'}>
                            <button
                                type="button"
                                onClick={() => setSelection({ kind: 'group', key: group.type })}
                                className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-left text-xs font-semibold ${groupSelected
                                    ? (isLight ? 'bg-blue-50 text-blue-700' : 'bg-blue-900/30 text-blue-300')
                                    : (isLight ? 'text-gray-700 hover:bg-gray-100' : 'text-gray-200 hover:bg-gray-800')}`}
                            >
                                <span className="flex items-center gap-2">
                                    <span className="inline-block w-2 h-2 rounded-sm" style={{ backgroundColor: TYPE_COLORS[group.type] || '#94a3b8' }} />
                                    {group.type ? typeLabelOf(group.type) : 'Needs a type'}
                                </span>
                                <span className={mutedCls}>{group.files.length}</span>
                            </button>
                            <div className="mt-1 space-y-0.5">
                                {group.files.map((file) => {
                                    const fileSelected = selection?.kind === 'file' && selection.key === file.id
                                    return (
                                        <div
                                            key={file.id}
                                            className={`group/file flex items-start gap-1 rounded-lg ${fileSelected ? (isLight ? 'bg-blue-50' : 'bg-blue-900/30') : (isLight ? 'hover:bg-gray-100' : 'hover:bg-gray-800')}`}
                                        >
                                            <button
                                                type="button"
                                                onClick={() => setSelection({ kind: 'file', key: file.id })}
                                                className="flex-1 min-w-0 text-left pl-6 pr-1 py-1.5"
                                            >
                                                <div className={`text-xs truncate ${isLight ? 'text-gray-800' : 'text-gray-200'}`}>{labelFor(file) || '—'}</div>
                                                <div className={`text-[11px] truncate font-mono ${mutedCls}`}>{basenameFromPath(file.path)}</div>
                                                {(file.custom || failures[file.id]) && (
                                                    <div className="flex gap-1 mt-0.5">
                                                        {file.custom && <span className={`text-[10px] px-1 rounded ${isLight ? 'bg-gray-200 text-gray-600' : 'bg-gray-700 text-gray-300'}`}>custom settings</span>}
                                                        {failures[file.id] && <span className="text-[10px] px-1 rounded bg-red-500/15 text-red-500">failed</span>}
                                                    </div>
                                                )}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => removeFile(file.id)}
                                                title={isEdit ? 'Leave out of this edit' : 'Remove from this list'}
                                                aria-label={`Remove ${basenameFromPath(file.path)}`}
                                                className={`shrink-0 p-1.5 text-xs opacity-0 group-hover/file:opacity-100 focus:opacity-100 ${mutedCls}`}
                                            >✕</button>
                                        </div>
                                    )
                                })}
                            </div>
                        </div>
                    )
                })}
            </div>
            {!isEdit && (
                <div className={`p-3 border-t ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                    <button type="button" onClick={openBrowser} className="w-full py-2 rounded-lg text-xs font-medium border border-dashed border-blue-400/60 text-blue-500 hover:bg-blue-500/5">
                        + Add more files
                    </button>
                </div>
            )}
        </div>
    )

    const summary = grouped
        .map((g) => `${g.files.length} ${g.type ? typeLabelOf(g.type) : 'unrecognised'}`)
        .join(', ')

    const dialogWidth = step === 1 ? 'max-w-xl' : isSingle ? 'max-w-4xl' : 'max-w-6xl'

    return (
        <>
            <FileBrowserModal
                isOpen={fileBrowserOpen}
                onClose={() => { setFileBrowserOpen(false) }}
                onSelect={(path) => addPaths([path])}
                onSelectMany={addPaths}
                onDirectoryChange={(path) => { lastDirectoryRef.current = path }}
                multiple
                initialPath={browserStart || seed?.browserDirectory || initialBrowsePath || '.'}
                mode="file"
                theme={isLight ? 'light' : 'dark'}
                extensions={['.bw', '.bigwig', '.bb', '.bigbed', '.vcf', '.vcf.gz', '.bed', '.bed.gz', '.gff', '.gff3', '.gtf', '.gff.gz', '.gff3.gz', '.gtf.gz', '.bam', '.SJ.out.tab']}
            />

            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
                <div
                    data-tour-id="track-wizard"
                    // Bounded, with the body scrolling. Several files get a fixed height, so the
                    // file list and the editor each scroll on their own.
                    className={`w-full ${dialogWidth} rounded-2xl shadow-2xl border flex flex-col ${step === 2 && !isSingle ? 'h-[min(88vh,820px)]' : 'max-h-[88vh]'} ${isLight ? 'bg-white border-gray-200' : 'bg-gray-900 border-gray-700'}`}
                    onClick={(e) => e.stopPropagation()}
                >
                    {/* Header */}
                    <div className={`px-6 py-4 border-b flex items-center justify-between flex-none ${isLight ? 'border-gray-100' : 'border-gray-700'}`}>
                        <div>
                            <h2 className={`text-base font-semibold ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>
                                {isEdit
                                    ? (isSingle ? 'Edit Track' : `Edit ${files.length} tracks`)
                                    : (step === 2 && !isSingle ? `Register ${files.length} tracks` : 'Register Track')}
                            </h2>
                            <p className={`text-xs mt-0.5 ${mutedCls}`}>
                                {isEdit
                                    ? (isSingle ? basenameFromPath(onlyFile?.path || '') : summary)
                                    : step === 1 ? 'Step 1 of 2' : isSingle ? 'Step 2 of 2' : `Step 2 of 2 · ${summary}`}
                            </p>
                        </div>
                        <button onClick={onClose} className={`p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 ${mutedCls}`}>✕</button>
                    </div>

                    {step === 1 && (
                        <div className="px-6 py-5 space-y-4 flex-1 overflow-y-auto min-h-0 text-center">
                            <p className={`text-sm ${isLight ? 'text-gray-600' : 'text-gray-400'}`}>
                                Select the file you want to add as a track — or tick several, of any types, to add them together.
                            </p>
                            <button
                                data-tour-id="track-wizard-browse"
                                onClick={openBrowser}
                                className="w-full py-8 rounded-xl border-2 border-dashed border-blue-400/50 hover:border-blue-500 hover:bg-blue-500/5 transition-colors text-blue-500 dark:text-blue-400 text-sm font-medium"
                            >
                                <svg className="w-8 h-8 mx-auto mb-2 opacity-70" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                                </svg>
                                Browse for files…
                            </button>
                            <p className={`text-xs ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                                Supported: .bw, .bigwig, .bb, .vcf.gz, .bed, .bed.gz, .gff, .gff3, .gtf (.gz), .bam, .SJ.out.tab
                            </p>
                        </div>
                    )}

                    {step === 2 && isSingle && (
                        <div className="px-6 py-5 flex-1 overflow-y-auto min-h-0">{singleForm}</div>
                    )}

                    {step === 2 && !isSingle && (
                        <>
                            <div className={`px-6 py-4 border-b flex-none ${isLight ? 'border-gray-100' : 'border-gray-700'}`}>{genomeBlock}</div>
                            <div className="flex-1 min-h-0 grid grid-cols-[18rem_1fr]">
                                {sidebar}
                                <div className="min-h-0 overflow-y-auto px-6 py-5">
                                    {groupEditor || fileEditor || (
                                        <p className={`text-sm ${mutedCls}`}>Select a file type or a file on the left to see its names and settings.</p>
                                    )}
                                </div>
                            </div>
                        </>
                    )}

                    {/* Status: what stops registering, how far it has got, what went wrong. */}
                    {step === 2 && (error || problems.length > 0 || progress) && (
                        <div className={`px-6 py-2.5 border-t text-xs flex-none space-y-1 ${isLight ? 'border-gray-100' : 'border-gray-700'}`}>
                            {progress && (
                                <div className={mutedCls}>
                                    {progress.measuring
                                        ? `Measuring the peaks across ${progress.measuring} BigWig files…`
                                        : `${isEdit ? 'Saving' : 'Registering'} ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`}
                                </div>
                            )}
                            {error && (
                                <div className={isLight ? 'text-red-700' : 'text-red-300'}>{error}</div>
                            )}
                            {!progress && problems.length > 0 && (
                                <div className={isLight ? 'text-amber-700' : 'text-amber-300'}>
                                    {problems[0]}{problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Footer */}
                    {step === 2 && (
                        <div className={`px-6 py-4 border-t flex items-center justify-between gap-3 flex-none ${isLight ? 'border-gray-100 bg-gray-50' : 'border-gray-700 bg-gray-900/50'}`}>
                            <div className="flex items-center gap-2">
                                {!isEdit && (
                                <>
                                <button
                                    data-tour-id="track-wizard-back"
                                    // Start again from the file browser, in the folder the files came
                                    // from — not from the top of the tree.
                                    onClick={() => { setStep(1); setFiles([]); setSelection(null); setFailures({}); setError(''); openBrowser() }}
                                    className={`px-4 py-2 rounded-lg text-sm ${isLight ? 'text-gray-600 hover:bg-gray-100' : 'text-gray-400 hover:bg-gray-800'}`}
                                >
                                    ← Back
                                </button>
                                {isSingle && (
                                    <button
                                        type="button"
                                        onClick={openBrowser}
                                        className={`px-3 py-2 rounded-lg text-sm ${isLight ? 'text-blue-600 hover:bg-blue-50' : 'text-blue-400 hover:bg-blue-900/20'}`}
                                    >
                                        + Add more files
                                    </button>
                                )}
                                </>
                                )}
                            </div>
                            <div className="flex items-center gap-2">
                            {/* Editing has nowhere to go back to, so Cancel sits by Save. */}
                            {isEdit && (
                                <button
                                    type="button"
                                    onClick={onClose}
                                    disabled={registering}
                                    className={`px-4 py-2 rounded-lg text-sm font-medium border disabled:opacity-40 ${isLight ? 'border-gray-300 text-gray-700 hover:bg-gray-100' : 'border-gray-600 text-gray-300 hover:bg-gray-800'}`}
                                >
                                    Cancel
                                </button>
                            )}
                            <button
                                data-tour-id="track-wizard-register"
                                onClick={() => handleRegister()}
                                disabled={!files.length || registering || problems.length > 0}
                                className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                {registering
                                    ? (isEdit ? 'Saving…' : 'Registering…')
                                    : isEdit
                                        ? (isSingle ? 'Save changes' : `Save ${files.length} tracks`)
                                        : (isSingle ? 'Register Track' : `Register ${files.length} tracks`)}
                            </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {noGenomePrompt && (() => {
                const names = grouped.flatMap((g) => g.files).map((f) => labelFor(f) || basenameFromPath(f.path))
                const shown = names.slice(0, 8)
                return (
                    <div data-wheel-isolated="true" className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4">
                        <div
                            data-tour-id="track-wizard-no-genome"
                            role="alertdialog"
                            aria-modal="true"
                            aria-labelledby="track-wizard-no-genome-title"
                            className={`w-full max-w-md rounded-xl border shadow-2xl ${isLight ? 'bg-white border-gray-200' : 'bg-gray-800 border-gray-700'}`}
                        >
                            <div className="px-5 py-4 space-y-3">
                                <h3 id="track-wizard-no-genome-title" className={`text-base font-semibold ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>
                                    ⚠ No genome associated
                                </h3>
                                <p className={`text-sm ${isLight ? 'text-gray-600' : 'text-gray-300'}`}>
                                    {names.length === 1 ? 'This track has' : `These ${names.length} tracks have`} no genome, so {names.length === 1 ? 'it' : 'they'} will not appear in the Genome Browser until one is set. You can set it later by editing {names.length === 1 ? 'the track' : 'them'}.
                                </p>
                                <ul className={`text-xs rounded-lg border px-3 py-2 space-y-0.5 max-h-40 overflow-y-auto ${isLight ? 'border-gray-200 bg-gray-50 text-gray-700' : 'border-gray-700 bg-gray-900/40 text-gray-300'}`}>
                                    {shown.map((name, i) => <li key={`${name}-${i}`} className="truncate">{name}</li>)}
                                    {names.length > shown.length && <li className={mutedCls}>and {names.length - shown.length} more</li>}
                                </ul>
                            </div>
                            <div className={`px-5 py-3 border-t flex justify-end gap-2 ${isLight ? 'border-gray-100' : 'border-gray-700'}`}>
                                <button
                                    type="button"
                                    data-tour-id="track-wizard-no-genome-back"
                                    onClick={() => {
                                        setNoGenomePrompt(false)
                                        // Straight to the field that needs filling.
                                        genomeFieldRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
                                        genomeFieldRef.current?.querySelector('input')?.focus()
                                    }}
                                    className={`px-4 py-2 rounded-lg text-sm font-medium ${isLight ? 'text-gray-700 hover:bg-gray-100' : 'text-gray-200 hover:bg-gray-700'}`}
                                >
                                    Go back and choose a genome
                                </button>
                                <button
                                    type="button"
                                    data-tour-id="track-wizard-no-genome-continue"
                                    onClick={() => { setNoGenomePrompt(false); handleRegister({ withoutGenome: true }) }}
                                    className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-amber-600 hover:bg-amber-700"
                                >
                                    Register without a genome
                                </button>
                            </div>
                        </div>
                    </div>
                )
            })()}
        </>
    )
}
