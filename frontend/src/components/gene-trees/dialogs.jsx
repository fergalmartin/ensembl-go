import { useCallback, useEffect, useMemo, useState } from 'react'
import FileBrowserModal from '../FileBrowserModal'
import { api, query } from './data.js'

const TREE_EXTENSIONS = ['.nwk', '.newick', '.nh', '.nhx', '.tree', '.tre', '.treefile', '.txt', '.emf', '.json', '.gz']
const METHOD_SUGGESTIONS = ['Ensembl Compara', 'OrthoFinder', 'IQ-TREE', 'RAxML', 'FastTree', 'PhyML', 'TreeFam']

export function Modal({ title, onClose, children, wide = false, footer = null }) {
  useEffect(() => {
    const key = event => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  return (
    <div className="gt-modal-shade" onPointerDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <div className={`gt-modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <button type="button" className="gt-close" onClick={onClose} aria-label="Close">×</button>
        <h3>{title}</h3>
        <div className="gt-modal-body">{children}</div>
        {footer ? <div className="gt-modal-footer">{footer}</div> : null}
      </div>
    </div>
  )
}

const baseName = path => String(path || '').split(/[\\/]/).filter(Boolean).pop() || ''
const defaultTitle = path => baseName(path).replace(/\.(gz)$/i, '').replace(/\.(nwk|newick|nhx?|tree|tre|treefile|txt|emf|json)$/i, '').replace(/_tree$/, '')
const splitTags = text => String(text || '').split(',').map(tag => tag.trim()).filter(Boolean)

function MetadataFields({ value, onChange, pathHint }) {
  return (
    <>
      <label>Title
        <input value={value.name} placeholder={pathHint || 'e.g. BRCA2 vertebrate gene tree'} onChange={e => onChange({ ...value, name: e.target.value })} />
      </label>
      <label>Source or method
        <input list="gt-method-suggestions" value={value.method} placeholder="e.g. Ensembl Compara 115 protein trees, OrthoFinder 2.5"
          onChange={e => onChange({ ...value, method: e.target.value })} />
        <datalist id="gt-method-suggestions">{METHOD_SUGGESTIONS.map(m => <option key={m} value={m} />)}</datalist>
      </label>
      <label>Description
        <textarea rows={2} value={value.description} placeholder="What these trees are, and anything to remember about them"
          onChange={e => onChange({ ...value, description: e.target.value })} />
      </label>
      <label>Tags <small>comma separated</small>
        <input value={value.tags} placeholder="vertebrates, DNA repair" onChange={e => onChange({ ...value, tags: e.target.value })} />
      </label>
    </>
  )
}

export function LoadTreeDialog({ theme, config, onClose, onStarted }) {
  const [mode, setMode] = useState('file')
  const [path, setPath] = useState('')
  const [pathKind, setPathKind] = useState('file')
  const [content, setContent] = useState('')
  const [meta, setMeta] = useState({ name: '', method: '', description: '', tags: '' })
  const [browsing, setBrowsing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      const payload = { name: meta.name.trim() || (mode === 'file' ? defaultTitle(path) : ''), method: meta.method.trim(),
        description: meta.description.trim(), tags: splitTags(meta.tags) }
      if (mode === 'file') payload.path = path.trim()
      else payload.content = content
      const started = await api('/datasets', payload)
      onStarted({ id: started.job, status: 'queued', name: payload.name || defaultTitle(payload.path || '') || 'Pasted tree', phase: 'queued' })
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }
  const ready = mode === 'file' ? path.trim() : content.trim()

  return (
    <Modal title="Load gene trees" onClose={onClose} wide footer={<>
      {error ? <span className="gt-error">{error}</span> : <span className="gt-muted">Newick, NHX, Ensembl gene tree JSON, EMF (plain or .gz), or a folder of tree files</span>}
      <button type="button" onClick={onClose}>Cancel</button>
      <button type="button" className="primary" disabled={!ready || busy} onClick={submit}>{busy ? 'Starting…' : 'Index and load'}</button>
    </>}>
      <div className="gt-segmented" role="tablist">
        <button type="button" className={mode === 'file' ? 'selected' : ''} onClick={() => setMode('file')}>File or folder</button>
        <button type="button" className={mode === 'paste' ? 'selected' : ''} onClick={() => setMode('paste')}>Paste a tree</button>
      </div>
      {mode === 'file' ? (
        <label>Location
          <span className="gt-row">
            <input value={path} placeholder="/path/to/tree.nwk or an OrthoFinder Gene_Trees folder" onChange={e => { setPath(e.target.value); setPathKind('file') }} />
            <button type="button" onClick={() => setBrowsing(true)}>Browse…</button>
          </span>
          {path && pathKind === 'directory' ? <small>Every tree file in this folder becomes one tree in the collection.</small> : null}
        </label>
      ) : (
        <label>Tree
          <textarea rows={6} className="gt-mono" value={content} placeholder="((Human_ENSP00000369497:0.01,Mouse_ENSMUSP00000144150:0.05):0.1,Zebrafish_ENSDARP00000099999:0.3);"
            onChange={e => setContent(e.target.value)} />
        </label>
      )}
      <p className="gt-muted gt-small">Trees are <strong>indexed</strong> rather than loaded whole: every leaf's gene, protein and symbol goes into a search index and each tree is kept compressed until you open it. A whole Compara release (about 50,000 trees) takes a few minutes; progress shows at the top of the view and you can keep working meanwhile.</p>
      <MetadataFields value={meta} onChange={setMeta} pathHint={mode === 'file' ? defaultTitle(path) : ''} />
      {browsing ? (
        <FileBrowserModal isOpen onClose={() => setBrowsing(false)} theme={theme} mode="file-or-directory"
          initialPath={config?.output_dir || '.'} extensions={TREE_EXTENSIONS}
          onSelect={(selected, info) => { setPath(selected); setPathKind(info?.kind || 'file'); setBrowsing(false) }} />
      ) : null}
    </Modal>
  )
}

export function CollectionDetailsDialog({ collection, onClose, onSaved }) {
  const [meta, setMeta] = useState({ name: collection.name || '', method: collection.method || '',
    description: collection.description || '', tags: (collection.tags || []).join(', ') })
  const [error, setError] = useState('')
  const save = async () => {
    try {
      const saved = await api(`/datasets/${collection.id}`, { name: meta.name, method: meta.method, description: meta.description,
        tags: splitTags(meta.tags) }, undefined, 'PATCH')
      onSaved(saved)
    } catch (err) { setError(err.message) }
  }
  return (
    <Modal title="Collection details" onClose={onClose} footer={<>
      {error ? <span className="gt-error">{error}</span> : <span className="gt-muted">{collection.tree_count} trees · {collection.format}</span>}
      <button type="button" onClick={onClose}>Cancel</button>
      <button type="button" className="primary" disabled={!meta.name.trim()} onClick={save}>Save</button>
    </>}>
      <MetadataFields value={meta} onChange={setMeta} />
      {collection.source ? <p className="gt-muted gt-break">From {collection.source}</p> : null}
    </Modal>
  )
}

export function LibraryDialog({ collections, current, onClose, onOpenTree, onEdit, onLinks, onDelete, onLoad }) {
  const [selected, setSelected] = useState(current?.collectionId || collections[0]?.id || '')
  const [filter, setFilter] = useState('')
  const [trees, setTrees] = useState({ total: 0, trees: [] })
  const collection = collections.find(c => c.id === selected)

  useEffect(() => {
    if (!selected) return undefined
    const controller = new AbortController()
    const timer = setTimeout(() => {
      api(`/datasets/${selected}/trees${query({ query: filter.trim(), limit: 300 })}`, undefined, controller.signal)
        .then(setTrees).catch(() => {})
    }, 180)
    return () => { clearTimeout(timer); controller.abort() }
  }, [selected, filter])

  return (
    <Modal title="Tree library" onClose={onClose} wide footer={<>
      <span className="gt-muted">{collections.length} collection{collections.length === 1 ? '' : 's'}</span>
      <button type="button" onClick={onLoad}>Load trees…</button>
      <button type="button" onClick={onClose}>Close</button>
    </>}>
      {collections.length ? (
        <div className="gt-library">
          <ul className="gt-library-collections">
            {collections.map(c => (
              <li key={c.id}>
                <button type="button" className={c.id === selected ? 'selected' : ''} onClick={() => { setSelected(c.id); setFilter('') }}>
                  <strong>{c.name}</strong>
                  <span>{c.status === 'indexing' ? `Indexing… ${c.tree_count.toLocaleString()} trees so far` : [c.method, `${c.tree_count.toLocaleString()} tree${c.tree_count === 1 ? '' : 's'}`, c.leaf_count ? `${c.leaf_count.toLocaleString()} genes` : ''].filter(Boolean).join(' · ')}</span>
                  {c.tags?.length ? <span className="gt-tags">{c.tags.map(tag => <em key={tag}>{tag}</em>)}</span> : null}
                </button>
              </li>
            ))}
          </ul>
          <div className="gt-library-trees">
            {collection ? (
              <>
                {collection.description ? <p className="gt-muted">{collection.description}</p> : null}
                <div className="gt-row">
                  <input value={filter} placeholder={`Find a tree by name, ID, gene or symbol (${trees.total.toLocaleString()})`} onChange={e => setFilter(e.target.value)} />
                </div>
                <ul className="gt-tree-list">
                  {trees.trees.map(tree => (
                    <li key={tree.tree_id}>
                      <button type="button" className={current?.collectionId === selected && current?.treeId === tree.tree_id ? 'selected' : ''}
                        disabled={collection.status === 'indexing'} onClick={() => onOpenTree(selected, tree.tree_id)}>
                        <strong>{tree.name}</strong>
                        <span>{tree.leaf_count.toLocaleString()} genes · {tree.species_count} species{tree.stats?.duplication ? ` · ${tree.stats.duplication}${tree.stats.approximate ? '≈' : ''} duplications` : ''}</span>
                      </button>
                    </li>
                  ))}
                  {trees.total > trees.trees.length ? <li className="gt-muted">Showing {trees.trees.length} of {trees.total.toLocaleString()}; narrow the search to see others.</li> : null}
                </ul>
                <div className="gt-row">
                  <button type="button" onClick={() => onEdit(collection)}>Edit details</button>
                  <button type="button" onClick={() => onLinks(collection)}>Link genomes…</button>
                  <button type="button" className="danger" onClick={() => onDelete(collection)}>Remove</button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      ) : <p className="gt-muted">No trees loaded yet.</p>}
    </Modal>
  )
}

export function LinkGenomesDialog({ collection, onClose, onSaved }) {
  const [pattern, setPattern] = useState(collection.label_pattern || '')
  const [preview, setPreview] = useState(null)
  const [speciesMap, setSpeciesMap] = useState(collection.species_map || {})
  const [table, setTable] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const refresh = useCallback(async signal => {
    try {
      const result = await api(`/datasets/${collection.id}/labels${query({ pattern })}`, undefined, signal)
      setPreview(result)
      setError('')
    } catch (err) { if (err.name !== 'AbortError') setError(err.message) }
  }, [collection.id, pattern])
  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => refresh(controller.signal), 250)
    return () => { clearTimeout(timer); controller.abort() }
  }, [refresh])

  const species = useMemo(() => {
    // Species as the current pattern would read them, merged with those already stored.
    const tokens = new Map((preview?.species || []).map(s => [s.species, s.leaves]))
    for (const sample of preview?.samples || []) if (sample.species && !tokens.has(sample.species)) tokens.set(sample.species, null)
    return [...tokens.entries()].filter(([token]) => token)
  }, [preview])

  const save = async () => {
    setSaving(true)
    try {
      await api(`/datasets/${collection.id}/mapping`, { label_pattern: pattern, species_map: speciesMap }, undefined, 'PUT')
      if (table.trim()) await api(`/datasets/${collection.id}/links`, { content: table })
      onSaved()
    } catch (err) { setError(err.message); setSaving(false) }
  }

  return (
    <Modal title={`Link genomes · ${collection.name}`} onClose={onClose} wide footer={<>
      {error ? <span className="gt-error">{error}</span> : <span className="gt-muted">Leaves are matched to local genomes by species, then confirmed by gene, transcript or protein ID.</span>}
      <button type="button" onClick={onClose}>Cancel</button>
      <button type="button" className="primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save links'}</button>
    </>}>
      <label>How to read leaf labels <small>a regular expression with (?&lt;species&gt;…) and (?&lt;id&gt;…) groups; leave empty to detect automatically</small>
        <input className="gt-mono" value={pattern} placeholder="(?P<species>[A-Za-z]+_[a-z]+)_(?P<id>.+)" onChange={e => setPattern(e.target.value.replace(/\(\?<(species|id)>/g, '(?P<$1>'))} />
      </label>
      <div className="gt-preview">
        <table>
          <thead><tr><th>Leaf label</th><th>Species</th><th>Identifier</th></tr></thead>
          <tbody>
            {(preview?.samples || []).slice(0, 8).map(sample => (
              <tr key={sample.label}><td className="gt-mono">{sample.label}</td><td>{sample.species || <span className="gt-muted">—</span>}</td>
                <td className="gt-mono">{sample.id || '—'}{sample.kind ? <small> {sample.kind}</small> : null}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <h4>Species</h4>
      <div className="gt-species-map">
        {species.map(([token, leaves]) => (
          <label key={token} className="gt-species-row">
            <span>{token}{leaves ? <small> {leaves} leaves</small> : null}</span>
            <select value={speciesMap[token] ?? '__auto'} onChange={e => {
              const next = { ...speciesMap }
              if (e.target.value === '__auto') delete next[token]
              else next[token] = e.target.value
              setSpeciesMap(next)
            }}>
              <option value="__auto">Match automatically</option>
              <option value="">Not a local genome</option>
              {(preview?.genomes || []).map(g => <option key={g.assembly} value={g.assembly}>{g.genome_name || g.scientific_name} · {g.assembly}</option>)}
            </select>
          </label>
        ))}
        {!species.length ? <p className="gt-muted">No species could be read from the labels. Adjust the pattern above.</p> : null}
      </div>
      <label>Link individual leaves <small>TSV or CSV: label, assembly, gene ID (optional)</small>
        <textarea rows={3} className="gt-mono" value={table} placeholder={'label\tassembly\tgene_id\nHsap_BRCA2\tGCA_000001405.29\tENSG00000139618'} onChange={e => setTable(e.target.value)} />
      </label>
    </Modal>
  )
}
