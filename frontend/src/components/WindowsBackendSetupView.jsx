import { useMemo, useState } from 'react'

function StatusPill({ ok, optional = false, preparing = false }) {
  const label = preparing && ok === false ? 'Preparing' : optional && ok === false ? 'Optional' : ok === true ? 'Ready' : ok === false ? 'Needs action' : 'Checking'
  const classes = ok === true
    ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
    : ok === false && !optional && !preparing
      ? 'bg-amber-100 text-amber-900 border border-amber-200'
      : 'bg-slate-100 text-slate-700 border border-slate-200'

  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${classes}`}>{label}</span>
}

function DiagnosticRow({ title, item, optional = false, preparing = false }) {
  const [copied, setCopied] = useState(false)
  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(item.linuxPath)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  return (
    <div className="rounded-xl border border-slate-200 bg-white/80 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-sm font-semibold text-slate-900">{title}</div>
          {item?.value && <div className="mt-1 text-xs font-mono text-slate-500">{item.value}</div>}
          {item?.linuxPath && <div className="mt-1 text-xs font-mono text-slate-500">{item.linuxPath}</div>}
          {item?.linuxPath && (
            <button type="button" onClick={copyPath} className="mt-2 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-700">
              {copied ? 'Path copied' : 'Copy path'}
            </button>
          )}
          <div className="mt-2 text-sm leading-6 text-slate-600">{item?.details || 'Not checked yet.'}</div>
          {Array.isArray(item?.missing) && item.missing.length > 0 && (
            <div className="mt-2 text-xs font-mono text-amber-700">Missing: {item.missing.join(', ')}</div>
          )}
        </div>
        <StatusPill ok={item?.ok} optional={optional} preparing={preparing} />
      </div>
    </div>
  )
}

function CommandCard({ title, command }) {
  const canCopy = typeof navigator !== 'undefined' && navigator.clipboard && command

  const handleCopy = async () => {
    if (!canCopy) return
    try {
      await navigator.clipboard.writeText(command)
    } catch {
      // Ignore clipboard failures.
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-950 p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-4">
        <div className="text-sm font-semibold text-white">{title}</div>
        <button
          type="button"
          onClick={handleCopy}
          disabled={!canCopy}
          className="rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-200 transition hover:bg-slate-800 disabled:cursor-default disabled:opacity-50"
        >
          Copy
        </button>
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all text-xs leading-6 text-slate-200">{command || 'Will appear once the backend source bundle is available.'}</pre>
    </div>
  )
}

export default function WindowsBackendSetupView({ backendRuntime, onRetryCheck, onRetryLaunch, onClose }) {
  const diagnostics = backendRuntime?.diagnostics || {}
  const setupCommands = backendRuntime?.setupCommands || {}
  const status = backendRuntime?.status || 'checking'
  const busy = status === 'checking' || status === 'installing' || status === 'launching'
  const heading = backendRuntime?.ready
    ? 'Backend ready'
    : status === 'checking'
      ? 'Checking backend'
      : status === 'installing'
        ? 'Preparing backend'
        : status === 'launching'
          ? 'Starting backend'
          : 'Backend setup needed'
  const [setupMethod, setSetupMethod] = useState(null)
  const selectedMethod = setupMethod === 'uv' && !setupCommands.uvAvailable
    ? 'python'
    : setupMethod || (setupCommands.uvAvailable ? 'uv' : 'python')

  const summary = useMemo(() => {
    if (backendRuntime?.ready) {
      return 'The backend is connected. You can go back to the app now.'
    }
    if (status === 'launching') {
      return 'Electron is trying to launch the backend inside WSL now.'
    }
    if (status === 'installing') {
      return 'Ensembl Go is preparing the backend environment inside WSL. This may take several minutes on first use or after a backend update.'
    }
    if (status === 'checking') {
      return 'Electron is checking whether WSL and the backend are ready.'
    }
    return 'The UI runs in Windows. Its Python backend runs in an Ubuntu or Debian WSL 2 virtual environment over localhost HTTP.'
  }, [backendRuntime?.ready, status])

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-6 overflow-y-auto rounded-3xl bg-[linear-gradient(145deg,#f8fbff_0%,#eef4ff_55%,#f8fafc_100%)] p-6 text-slate-900 shadow-[0_18px_60px_rgba(15,23,42,0.12)]">
      <div className="rounded-2xl border border-sky-200 bg-white/85 p-6 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-3xl">
            <div className="inline-flex rounded-full bg-sky-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">Windows UI + WSL 2 backend</div>
            <h2 className="mt-4 text-2xl font-semibold tracking-tight text-slate-950">{heading}</h2>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-600">{summary}</p>
            {status === 'installing' && backendRuntime?.setupProgress && (
              <div role="status" className="mt-4 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm leading-6 text-sky-900">
                {backendRuntime.setupProgress}
              </div>
            )}
            <div className="mt-4 flex flex-wrap items-center gap-2 text-sm text-slate-600">
              <span className="font-semibold text-slate-800">Backend connection:</span>
              <span>{diagnostics.health?.ok ? 'Connected' : status === 'installing' ? 'Preparing WSL backend' : busy ? 'Checking' : 'Waiting for setup'}</span>
            </div>
            {backendRuntime?.lastError && (
              <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
                {backendRuntime.lastError}
              </div>
            )}
            <div className="mt-4 text-xs text-slate-500">
              API base: <span className="font-mono">{backendRuntime?.apiBase || 'http://127.0.0.1:8000'}</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            {backendRuntime?.ready && (
              <button type="button" onClick={onClose} className="rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-sky-500">
                Return to app
              </button>
            )}
            <button
              type="button"
              onClick={onRetryCheck}
              disabled={busy}
              className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 transition hover:bg-slate-50 disabled:cursor-default disabled:opacity-60"
            >
              Retry connection
            </button>
            <button
              type="button"
              onClick={onRetryLaunch}
              disabled={busy}
              className="rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-sky-500 disabled:cursor-default disabled:opacity-60"
            >
              Retry launch
            </button>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <DiagnosticRow title="WSL" item={diagnostics.wsl} />
        <DiagnosticRow title="WSL 2 distro" item={diagnostics.distro} />
        <DiagnosticRow title="Backend installation directory in WSL" item={diagnostics.backendSource} />
        <DiagnosticRow title="Backend virtual environment" item={diagnostics.python} preparing={status === 'installing'} />
        <DiagnosticRow title="Python dependencies" item={diagnostics.modules} preparing={status === 'installing'} />
        <DiagnosticRow title="MAFFT in WSL" item={diagnostics.mafft} optional />
        {diagnostics.backendUrlOverride?.value && <DiagnosticRow title="Backend URL override" item={diagnostics.backendUrlOverride} />}
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white/85 p-5 shadow-sm">
        <div className="text-sm font-semibold text-slate-900">Manual setup options</div>
        <p className="mt-2 text-sm leading-6 text-slate-600">Ensembl Go uses uv automatically when available. Use these commands if automatic setup needs help, or choose Python venv instead.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={() => setSetupMethod('uv')} disabled={!setupCommands.uvAvailable}
            className={`rounded-lg border px-3 py-2 text-sm font-semibold ${selectedMethod === 'uv' ? 'border-sky-600 bg-sky-50 text-sky-800' : 'border-slate-300 text-slate-700'} disabled:cursor-default disabled:opacity-50`}>
            uv {setupCommands.uvAvailable ? '(available)' : '(not detected)'}
          </button>
          <button type="button" onClick={() => setSetupMethod('python')}
            className={`rounded-lg border px-3 py-2 text-sm font-semibold ${selectedMethod === 'python' ? 'border-sky-600 bg-sky-50 text-sky-800' : 'border-slate-300 text-slate-700'}`}>
            Python venv
          </button>
        </div>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          {selectedMethod === 'uv'
            ? 'uv uses Python 3.12 if present and can download a managed copy when needed. It installs backend packages only into backend/.venv.'
            : 'This option uses Python 3 and python3-venv installed inside WSL. Backend packages still go only into backend/.venv.'}
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {selectedMethod === 'python' && <CommandCard title="Only if Python 3 or venv is missing in WSL" command={setupCommands.installSystemPackages} />}
        <CommandCard title="Create backend venv and install dependencies in WSL" command={selectedMethod === 'uv' ? setupCommands.installWithUv : setupCommands.installWithPython} />
        <CommandCard title="Start the backend manually (optional)" command={setupCommands.startBackend} />
        <CommandCard title="Optional: enable multiple alignments" command={setupCommands.installMafft} />
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white/85 p-5 text-sm leading-7 text-slate-600 shadow-sm">
        <p>
          The backend and its virtual environment run from the native WSL filesystem. Keep large genome data there too for best performance. For data on a Windows drive, use a WSL-visible path such as
          <span className="mx-1 font-mono text-slate-800">/mnt/c/...</span>
          inside the app.
        </p>
      </div>
    </div>
  )
}
