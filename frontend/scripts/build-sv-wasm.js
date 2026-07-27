import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import process from 'node:process'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const crateRoot = path.join(frontendRoot, 'rust', 'sv_renderer')
const manifestPath = path.join(crateRoot, 'Cargo.toml')
const mode = process.argv.includes('--dev') ? '--dev' : '--release'

if (!existsSync(manifestPath)) {
  console.error(`SV renderer Cargo manifest not found: ${manifestPath}`)
  process.exit(1)
}

const probe = spawnSync('rustup', ['which', 'rustc'], { encoding: 'utf8' })
const rustc = probe.status === 0 ? String(probe.stdout || '').trim() : ''
const rustdocProbe = spawnSync('rustup', ['which', 'rustdoc'], { encoding: 'utf8' })
const rustdoc = rustdocProbe.status === 0 ? String(rustdocProbe.stdout || '').trim() : ''
const environment = { ...process.env }
if (rustc) {
  environment.RUSTC = rustc
  environment.PATH = `${path.dirname(rustc)}${path.delimiter}${environment.PATH || ''}`
}
if (rustdoc) environment.RUSTDOC = rustdoc

const result = spawnSync('wasm-pack', [
  'build',
  crateRoot,
  '--target', 'web',
  mode,
  '--out-dir', 'pkg',
  '--out-name', 'ensembl_sv_renderer',
], {
  cwd: frontendRoot,
  env: environment,
  stdio: 'inherit',
})

if (result.error?.code === 'ENOENT') {
  console.error('wasm-pack is required to build the Rust structural-variation renderer.')
  console.error('Install it from https://rustwasm.github.io/wasm-pack/installer/ and retry.')
  process.exit(1)
}
process.exit(result.status ?? 1)
