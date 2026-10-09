import { useCallback, useEffect, useMemo, useState } from 'react'
import { API_BASE } from '../../backendRuntime.js'
import { speciesGenomeKey } from '../../utils/svCatalog.js'
import FileBrowserModal from '../FileBrowserModal'
import { AvailableSvAlignmentsPanel } from './AvailableSvAlignmentsPanel'
import { StructuralVariationConfigPanel } from './StructuralVariationConfigPanel'
import { SV_FILE_BROWSER_EXTENSIONS } from './svConstants.js'
import { buildSvGenomePayload, dedupeSvSpeciesList, getSpeciesDisplayName } from './svFormat.js'

export function StructuralVariationRegistrationForm({
  className = '',
  theme,
  catalog,
  activeSpecies,
  inactiveSpecies,
  anchorSpecies,
  secondSpecies,
  thirdSpecies,
  regionExplicitlySelected,
  outputDir,
  onRegistered,
  onAvailableAlignmentAction,
  onOpenGenomeSelector,
}) {
  const isLight = theme === 'light'
  const [activeTool, setActiveTool] = useState('')
  const [browserField, setBrowserField] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const isRegistrationOpen = activeTool === 'register'
  const isAvailableOpen = activeTool === 'available'
  const isConfigOpen = activeTool === 'config'
  const knownSpecies = useMemo(() => {
    const catalogLocalSpecies = []
    for (const genome of catalog?.genomes || []) {
      if (genome?.local_species) catalogLocalSpecies.push(genome.local_species)
    }
    return dedupeSvSpeciesList([...activeSpecies, ...inactiveSpecies, ...catalogLocalSpecies])
  }, [activeSpecies, inactiveSpecies, catalog])
  const [form, setForm] = useState({
    label: '',
    description: '',
    chain_path: '',
    reference_bigwig_path: '',
    reference_bigbed_path: '',
    target_bigwig_path: '',
    target_bigbed_path: '',
    // Empty means "work it out from the file name"; getting this wrong is the
    // usual cause of an alignment that saves but draws nothing.
    indexed_side: '',
    reference_key: '',
    target_key: '',
    save_to: 'registry',
    config_path: '',
  })
  const speciesByKey = useMemo(() => new Map(knownSpecies.map((species) => [speciesGenomeKey(species), species])), [knownSpecies])

  // Start from whatever the view is already showing. The genomes were passed in
  // all along but the form ignored them, so every registration meant re-picking
  // the pair that was on screen.
  useEffect(() => {
    if (!isRegistrationOpen) return
    setForm((prev) => {
      if (prev.reference_key || prev.target_key) return prev
      const anchorKey = anchorSpecies ? speciesGenomeKey(anchorSpecies) : ''
      const secondKey = secondSpecies ? speciesGenomeKey(secondSpecies) : ''
      if (!anchorKey && !secondKey) return prev
      return { ...prev, reference_key: anchorKey, target_key: secondKey }
    })
  }, [isRegistrationOpen, anchorSpecies, secondSpecies])
  const fieldClass = 'flex min-w-0 flex-col gap-1'
  const fieldLabelClass = isLight
    ? 'h-4 text-xs font-semibold leading-4 text-gray-600'
    : 'h-4 text-xs font-semibold leading-4 text-gray-400'
  const buttonClass = `inline-flex h-8 items-center justify-center rounded border px-2.5 text-xs leading-none transition-colors ${
    isLight ? 'border-gray-300 bg-gray-50 text-gray-700 hover:bg-gray-100' : 'border-gray-600 bg-slate-800 text-gray-100 hover:bg-slate-700'
  }`
  const chooserButtonBaseClass = 'inline-flex h-8 items-center justify-center rounded border px-3 text-xs leading-none transition-colors whitespace-nowrap'
  const chooserButtonClass = (active) => `${chooserButtonBaseClass} ${active
    ? (isLight
      ? 'border-gray-300 bg-gray-50 text-gray-700 hover:bg-gray-100'
      : 'border-gray-600 bg-slate-800 text-gray-100 hover:bg-slate-700')
    : (isLight
      ? 'border-sky-600 bg-sky-600 text-white hover:bg-sky-700'
      : 'border-sky-600 bg-sky-600 text-white hover:bg-sky-500')
  }`
  const inputClass = `h-8 w-full rounded border px-2 text-sm leading-tight ${
    isLight ? 'border-gray-300 bg-white text-gray-900' : 'border-gray-600 bg-slate-900 text-gray-100'
  }`
  const labelTextClass = isLight ? 'text-gray-600' : 'text-gray-400'
  const hintClass = `mt-0.5 block text-[11px] ${isLight ? 'text-gray-500' : 'text-gray-500'}`

  const updateField = useCallback((field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }))
  }, [])

  const handleSubmit = useCallback(async (event) => {
    event.preventDefault()
    if (form.reference_key && form.reference_key === form.target_key) {
      setMessage('The reference and target must be different genomes.')
      return
    }
    if (form.save_to !== 'registry' && !form.config_path.trim()) {
      setMessage('Choose a configuration file to save into.')
      return
    }
    setSubmitting(true)
    setMessage('')
    try {
      const referenceSpecies = speciesByKey.get(form.reference_key) || null
      const targetSpecies = speciesByKey.get(form.target_key) || null
      const payload = {
        output_dir: outputDir || '',
        label: form.label,
        description: form.description,
        chain_path: form.chain_path,
        reference_bigwig_path: form.reference_bigwig_path,
        reference_bigbed_path: form.reference_bigbed_path,
        target_bigwig_path: form.target_bigwig_path,
        target_bigbed_path: form.target_bigbed_path,
        indexed_side: form.indexed_side,
        reference_genome: buildSvGenomePayload(referenceSpecies),
        target_genome: buildSvGenomePayload(targetSpecies),
        target: form.save_to === 'registry'
          ? { kind: 'registry' }
          : { kind: 'config', path: form.config_path.trim(), mode: 'merge' },
      }
      const res = await fetch(`${API_BASE}/api/sv/alignments/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.detail || `Registration failed (${res.status})`)

      // A config the user saved into is only useful once the view reads from it.
      if (form.save_to !== 'registry' && data?.config_path) {
        await fetch(`${API_BASE}/api/sv/config/attach`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: data.config_path }),
        }).catch(() => null)
      }
      setMessage(form.save_to === 'registry'
        ? 'Alignment registered.'
        : `Alignment saved to ${data?.config_path || form.config_path}.`)
      setActiveTool('')
      onRegistered?.()
    } catch (error) {
      setMessage(error?.message || 'Failed to register alignment.')
    } finally {
      setSubmitting(false)
    }
  }, [form, outputDir, speciesByKey, onRegistered])

  return (
    <>
      <div className={`${fieldClass} ${className}`}>
        <span className={fieldLabelClass}>Alignments</span>
        <div className="flex h-8 flex-nowrap items-center gap-2">
          <button type="button" className={chooserButtonClass(isRegistrationOpen)} onClick={() => setActiveTool((prev) => (prev === 'register' ? '' : 'register'))}>
            {isRegistrationOpen ? 'Close registration' : 'Register alignment'}
          </button>
          <button type="button" className={chooserButtonClass(isAvailableOpen)} onClick={() => setActiveTool((prev) => (prev === 'available' ? '' : 'available'))}>
            {isAvailableOpen ? 'Close alignments' : 'Available alignments'}
          </button>
          <button type="button" className={chooserButtonClass(isConfigOpen)} onClick={() => setActiveTool((prev) => (prev === 'config' ? '' : 'config'))}>
            {isConfigOpen ? 'Close summary' : 'Configuration'}
          </button>
        </div>
      </div>
      {message && !isConfigOpen && (
        <div className={`md:col-span-full text-xs ${message.includes('failed') || message.includes('Failed') ? (isLight ? 'text-red-600' : 'text-red-300') : (isLight ? 'text-gray-600' : 'text-gray-300')}`}>
          {message}
        </div>
      )}

      {isAvailableOpen && (
        <AvailableSvAlignmentsPanel
          theme={theme}
          catalog={catalog}
          activeSpecies={activeSpecies}
          inactiveSpecies={inactiveSpecies}
          anchorSpecies={anchorSpecies}
          secondSpecies={secondSpecies}
          thirdSpecies={thirdSpecies}
          regionExplicitlySelected={regionExplicitlySelected}
          onAction={onAvailableAlignmentAction}
        />
      )}

      {isConfigOpen && (
        <StructuralVariationConfigPanel
          theme={theme}
          catalog={catalog}
          outputDir={outputDir}
          activeSpecies={activeSpecies}
          inactiveSpecies={inactiveSpecies}
          onChanged={onRegistered}
          onLoaded={({ action, alignmentCount, missingFiles }) => setMessage(`${action} ${alignmentCount} alignment${alignmentCount === 1 ? '' : 's'}. ${missingFiles.length ? 'Some referenced files are missing; check the summary.' : 'Select genomes and an anchor region from the dropdowns above to start browsing.'}`)}
          onClose={() => setActiveTool('')}
        />
      )}

      {isRegistrationOpen && (
        <form className="mt-1 grid gap-2 md:col-span-full md:grid-cols-2" onSubmit={handleSubmit}>
          <label className="text-xs">
            <span className={labelTextClass}>Label</span>
            <input
              className={inputClass}
              value={form.label}
              placeholder="GRCh38 to HG00438.pat"
              onChange={(event) => updateField('label', event.target.value)}
              required
            />
            <span className={hintClass}>Identifies this alignment. Must be unique.</span>
          </label>
          <label className="text-xs">
            <span className={labelTextClass}>Description (optional)</span>
            <input
              className={inputClass}
              value={form.description}
              placeholder="Cactus chain, HPRC year 1"
              onChange={(event) => updateField('description', event.target.value)}
            />
          </label>
          <label className="text-xs">
            <span className={labelTextClass}>Reference genome</span>
            <select className={inputClass} value={form.reference_key} onChange={(event) => updateField('reference_key', event.target.value)} required>
              <option value="">Select genome</option>
              {knownSpecies.map((species) => (
                <option key={`ref-${speciesGenomeKey(species)}`} value={speciesGenomeKey(species)}>
                  {getSpeciesDisplayName(species)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs">
            <span className={labelTextClass}>Target genome</span>
            <select className={inputClass} value={form.target_key} onChange={(event) => updateField('target_key', event.target.value)} required>
              <option value="">Select genome</option>
              {knownSpecies.map((species) => (
                <option key={`tgt-${speciesGenomeKey(species)}`} value={speciesGenomeKey(species)}>
                  {getSpeciesDisplayName(species)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs md:col-span-2">
            <span className={labelTextClass}>BigChain file</span>
            <div className="flex gap-2">
              <input className={inputClass} value={form.chain_path} onChange={(event) => updateField('chain_path', event.target.value)} required />
              <button type="button" className={buttonClass} onClick={() => setBrowserField('chain_path')}>
                Browse
              </button>
            </div>
            <span className={hintClass}>
              Indexed BigBed chain file, conventionally *.bigChain.bb. Sequence names come from
              the assemblies, so no mapping files are needed.
            </span>
          </label>
          <label className="text-xs">
            <span className={labelTextClass}>Indexed side</span>
            <select className={inputClass} value={form.indexed_side} onChange={(event) => updateField('indexed_side', event.target.value)}>
              <option value="">Detect from file name</option>
              <option value="target">Target</option>
              <option value="reference">Reference</option>
            </select>
            <span className={hintClass}>Which genome the chain file is indexed on.</span>
          </label>
          <div className="text-xs">
            <span className={labelTextClass}>Save to</span>
            <select className={inputClass} value={form.save_to} onChange={(event) => updateField('save_to', event.target.value)}>
              <option value="registry">This installation</option>
              <option value="config">A configuration file</option>
            </select>
            {form.save_to === 'config' && (
              <div className="mt-1 flex gap-2">
                <input
                  className={inputClass}
                  value={form.config_path}
                  placeholder="alignments.json"
                  onChange={(event) => updateField('config_path', event.target.value)}
                />
                <button type="button" className={buttonClass} onClick={() => setBrowserField('config_path')}>
                  Browse
                </button>
              </div>
            )}
          </div>
          {[
            ['reference_bigwig_path', 'Reference BigWig (optional)'],
            ['reference_bigbed_path', 'Reference BigBed (optional)'],
            ['target_bigwig_path', 'Target BigWig (optional)'],
            ['target_bigbed_path', 'Target BigBed (optional)'],
          ].map(([field, label]) => (
            <label key={field} className="text-xs">
              <span className={labelTextClass}>{label}</span>
              <div className="flex gap-2">
                <input className={inputClass} value={form[field]} onChange={(event) => updateField(field, event.target.value)} />
                <button type="button" className={buttonClass} onClick={() => setBrowserField(field)}>
                  Browse
                </button>
              </div>
            </label>
          ))}
          <div className="md:col-span-2 flex flex-wrap items-center gap-2">
            <button type="submit" className={buttonClass} disabled={submitting}>
              {submitting ? 'Saving...' : 'Save alignment'}
            </button>
          </div>
        </form>
      )}

      <FileBrowserModal
        isOpen={Boolean(browserField)}
        onClose={() => setBrowserField('')}
        onSelect={(path) => {
          updateField(browserField, path)
          setBrowserField('')
        }}
        initialPath={outputDir || ''}
        mode="file"
        theme={theme}
        extensions={SV_FILE_BROWSER_EXTENSIONS[browserField] || []}
      />
    </>
  )
}
