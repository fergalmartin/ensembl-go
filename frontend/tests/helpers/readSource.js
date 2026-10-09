// Source text for tests that assert on how code is written rather than on what it
// does (JSX that Node cannot import, or backend Python).
//
// These read a *group* of files -- a component folder, or the whole backend app --
// so an assertion pins that the code exists in the feature, not which file of the
// feature holds it. Moving code between files of the same group then leaves the test
// alone, while deleting or changing the code still fails it.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BACKEND_ROOT = path.resolve(FRONTEND_ROOT, '..', 'backend')
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx'])
// Backend directories that are not the running app.
const BACKEND_NON_APP = new Set(['tests', 'scripts', 'cache', 'data', 'static', '__pycache__'])

function collect(target, extensions, skipDirs = new Set()) {
  const stat = fs.statSync(target)
  if (stat.isFile()) return [target]
  const files = []
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name)
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) files.push(...collect(full, extensions, skipDirs))
    } else if (extensions.has(path.extname(entry.name))) {
      files.push(full)
    }
  }
  return files.sort()
}

// Paths are relative to frontend/ (e.g. 'src/App.jsx', 'src/components/genome-browser').
export function readSources(...relativePaths) {
  return relativePaths
    .flatMap((relative) => collect(path.join(FRONTEND_ROOT, relative), SOURCE_EXTENSIONS))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n')
}

// Every Python module of the backend app (not its tests or scripts).
export function readBackendSources() {
  return collect(BACKEND_ROOT, new Set(['.py']), BACKEND_NON_APP)
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n')
}
