import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import process from 'node:process'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = path.join(frontendRoot, 'rust', 'sv_renderer', 'Cargo.toml')

function rustupTool(name) {
  const result = spawnSync('rustup', ['which', name], { encoding: 'utf8' })
  return result.status === 0 ? String(result.stdout || '').trim() : ''
}

const cargo = rustupTool('cargo') || 'cargo'
const rustc = rustupTool('rustc')
const rustdoc = rustupTool('rustdoc')
const environment = { ...process.env }
if (rustc) environment.RUSTC = rustc
if (rustdoc) environment.RUSTDOC = rustdoc
if (rustc) environment.PATH = `${path.dirname(rustc)}${path.delimiter}${environment.PATH || ''}`

const result = spawnSync(cargo, ['test', '--manifest-path', manifestPath], {
  cwd: frontendRoot,
  env: environment,
  stdio: 'inherit',
})
process.exit(result.status ?? 1)
