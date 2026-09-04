// Copy the vendored Mol* viewer bundle into the backend's static directory.
//
// pdbe-molstar is ~6 MB and needs 'unsafe-eval', so it is deliberately kept out
// of the Vite bundle and out of the app's renderer: the backend serves it to a
// sandboxed iframe under a separate Content-Security-Policy. That makes it a
// build artefact of the backend rather than of the frontend, even though npm is
// what fetches it.

import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import process from 'node:process'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(frontendRoot, '..')
const sourceDir = path.join(frontendRoot, 'node_modules', 'pdbe-molstar', 'build')
const targetDir = path.join(repoRoot, 'backend', 'static', 'structure', 'vendor')

const assets = [
  'pdbe-molstar-plugin.js',
  'pdbe-molstar.css',
  'pdbe-molstar-light.css',
  'pdbe-molstar-plugin.js.LICENSE.txt',
]

if (!existsSync(sourceDir)) {
  console.error(
    `pdbe-molstar build directory not found: ${sourceDir}\n` +
    'Run "npm install" in the frontend directory first.',
  )
  process.exit(1)
}

mkdirSync(targetDir, { recursive: true })

let copied = 0
for (const asset of assets) {
  const source = path.join(sourceDir, asset)
  if (!existsSync(source)) {
    console.error(`Missing pdbe-molstar asset: ${source}`)
    process.exit(1)
  }
  const target = path.join(targetDir, asset)
  copyFileSync(source, target)
  copied += statSync(target).size
}

console.log(
  `Structure viewer: copied ${assets.length} files ` +
  `(${(copied / 1024 / 1024).toFixed(1)} MB) to ${path.relative(repoRoot, targetDir)}`,
)
