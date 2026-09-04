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
