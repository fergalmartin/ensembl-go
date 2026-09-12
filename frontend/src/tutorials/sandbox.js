// Whether a tutorial is currently running, as a module-level flag.
//
// This exists because the sandbox has to hold everywhere, not just in the paths anyone
// thought to guard. Configuration is written from more than a dozen places across App,
// the configuration view and the genome selector; a tutorial leaking into even one of
// them would change the user's real setup. So rather than guarding each call site and
// hoping the list stays complete, the write is refused once, at the fetch layer.
//
// Set by TutorialProvider; read by backendRuntime's fetch shim.

let sandboxActive = false

export function setTutorialSandboxActive(active) {
  sandboxActive = Boolean(active)
}

export function isTutorialSandboxActive() {
  return sandboxActive
}

/** Requests a running tutorial must never be allowed to make.
 *
 *  Reads are fine — a tutorial shows the real configuration view. It is writing that
 *  would outlive the tutorial, so writing is what is refused. */
export function isBlockedDuringTutorial(url, method) {
  if (!sandboxActive) return false
  const verb = String(method || 'GET').toUpperCase()
  if (verb === 'GET' || verb === 'HEAD') return false
  try {
    const path = new URL(url, 'http://127.0.0.1').pathname
    return path === '/api/config' || path.startsWith('/api/config/')
  } catch {
    return false
  }
}

// The scratch directory a tutorial runs in, as `backend/demo_genome.py` names it. Kept
// here rather than imported because the check below is the only thing the frontend needs
// it for, and this module is already the one that knows what belongs to the sandbox.
const TUTORIAL_WORKSPACE_DIR = '.ensembl_go_tutorial'

// Fields a tutorial's configuration override adds that have no meaning outside it. See
// `tutorialSettings` in utils/tutorialBrowserScene.js, which is where they come from.
const SANDBOX_ONLY_FIELDS = ['tutorial_selected_genomes', 'tutorial_color_palette']

/** Strip a tutorial's scratch configuration out of a stored one.
 *
 *  The sandbox is meant never to be persisted, and is now held shut for as long as its
 *  override is in force. This is the second line: a configuration saved before that was
 *  true — in the Electron store, in the backend's config, in an output directory's
 *  sidecar — still carries the tutorial's own fields, and read back they behave as if a
 *  tutorial were running. The demo genomes appear as pills in the next tutorial, and the
 *  output directory points inside a scratch directory that is swept on every launch.
 *
 *  The output directory is recovered rather than blanked: a tutorial's workspace is
 *  always `<the real output directory>/.ensembl_go_tutorial`, so the real one is the
 *  parent. */
export function withoutTutorialSandboxFields(config) {
  if (!config || typeof config !== 'object') return config
  const cleaned = { ...config }
  let changed = false
  for (const field of SANDBOX_ONLY_FIELDS) {
    if (field in cleaned) {
      delete cleaned[field]
      changed = true
    }
  }
  for (const field of ['output_dir', 'working_dir']) {
    const value = String(cleaned[field] || '')
    const marker = value.replace(/\/+$/, '').split('/').lastIndexOf(TUTORIAL_WORKSPACE_DIR)
    if (marker < 0) continue
    cleaned[field] = value.replace(/\/+$/, '').split('/').slice(0, marker).join('/')
    changed = true
  }
  return changed ? cleaned : config
}
