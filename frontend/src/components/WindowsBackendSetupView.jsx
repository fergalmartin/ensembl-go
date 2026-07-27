import { useMemo } from 'react'

function StatusPill({ ok, optional = false }) {
  const label = optional && ok === false ? 'Optional' : ok === true ? 'Ready' : ok === false ? 'Needs action' : 'Checking'
  const classes = ok === true
    ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
    : ok === false && !optional
      ? 'bg-amber-100 text-amber-900 border border-amber-200'
      : 'bg-slate-100 text-slate-700 border border-slate-200'

  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${classes}`}>{label}</span>
}

function DiagnosticRow({ title, item, optional = false }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white/80 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-sm font-semibold text-slate-900">{title}</div>
          {item?.value && <div className="mt-1 text-xs font-mono text-slate-500">{item.value}</div>}
          {item?.windowsPath && <div className="mt-1 text-xs font-mono text-slate-500">{item.windowsPath}</div>}
          {item?.linuxPath && <div className="mt-1 text-xs font-mono text-slate-500">{item.linuxPath}</div>}
          <div className="mt-2 text-sm leading-6 text-slate-600">{item?.details || 'Not checked yet.'}</div>
          {Array.isArray(item?.missing) && item.missing.length > 0 && (
            <div className="mt-2 text-xs font-mono text-amber-700">Missing: {item.missing.join(', ')}</div>
          )}
        </div>
        <StatusPill ok={item?.ok} optional={optional} />
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

export default function WindowsBackendSetupView({ backendRuntime, onRetryCheck, onRetryLaunch }) {
  const diagnostics = backendRuntime?.diagnostics || {}
  const setupCommands = backendRuntime?.setupCommands || {}
  const status = backendRuntime?.status || 'checking'
  const busy = status === 'checking' || status === 'launching'

  const summary = useMemo(() => {
    if (backendRuntime?.ready) {
      return 'The backend is connected. You can go back to the app now.'
    }
    if (status === 'launching') {
      return 'Electron is trying to launch the backend inside WSL now.'
    }
    if (status === 'checking') {
      return 'Electron is checking whether WSL and the backend are ready.'
    }
    return 'This Windows build expects the Python backend to run inside Ubuntu or Debian WSL over localhost HTTP.'
  }, [backendRuntime?.ready, status])

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-6 overflow-y-auto rounded-3xl bg-[linear-gradient(145deg,#f8fbff_0%,#eef4ff_55%,#f8fafc_100%)] p-6 text-slate-900 shadow-[0_18px_60px_rgba(15,23,42,0.12)]">
      <div className="rounded-2xl border border-sky-200 bg-white/85 p-6 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-3xl">
            <div className="inline-flex rounded-full bg-sky-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">Windows + WSL backend</div>
            <h2 className="mt-4 text-2xl font-semibold tracking-tight text-slate-950">Backend setup needed</h2>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-600">{summary}</p>
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
        <DiagnosticRow title="Backend health" item={diagnostics.health} />
        <DiagnosticRow title="WSL" item={diagnostics.wsl} />
        <DiagnosticRow title="Default distro" item={diagnostics.distro} />
        <DiagnosticRow title="Backend source bundle" item={diagnostics.backendSource} />
        <DiagnosticRow title="Python in WSL" item={diagnostics.python} />
        <DiagnosticRow title="Python modules in WSL" item={diagnostics.modules} />
        <DiagnosticRow title="MAFFT in WSL" item={diagnostics.mafft} optional />
        <DiagnosticRow title="Backend URL override" item={diagnostics.backendUrlOverride} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <CommandCard title="1. Install Ubuntu or Debian packages" command={setupCommands.installSystemPackages} />
        <CommandCard title="2. Install Python dependencies" command={setupCommands.installPythonDeps} />
        <CommandCard title="3. Start the backend manually (optional)" command={setupCommands.startBackend} />
        <CommandCard title="Optional: enable multiple alignments" command={setupCommands.installMafft} />
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white/85 p-5 text-sm leading-7 text-slate-600 shadow-sm">
        <p>
          Use WSL-visible paths inside the app on Windows. If your data lives on the Windows filesystem, browse to it through
          <span className="mx-1 font-mono text-slate-800">/mnt/c/...</span>
          rather than a native Windows path.
        </p>
      </div>
    </div>
  )
}
