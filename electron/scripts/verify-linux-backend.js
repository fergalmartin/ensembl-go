#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ELECTRON_DIR, fail, log, pathExists } = require('./utils');

// e_machine values from the ELF spec, keyed by the Node arch they correspond to.
const ELF_MACHINE_BY_ARCH = {
  x64: 0x3e,
  ia32: 0x03,
  arm64: 0xb7,
  arm: 0x28,
  ppc64: 0x15,
  riscv64: 0xf3,
  s390x: 0x16,
};

function readElfMachine(binaryPath) {
  const header = Buffer.alloc(20);
  const handle = fs.openSync(binaryPath, 'r');
  try {
    const bytesRead = fs.readSync(handle, header, 0, header.length, 0);
    if (bytesRead < header.length) {
      return null;
    }
  } finally {
    fs.closeSync(handle);
  }

  if (header.subarray(0, 4).toString('latin1') !== '\x7fELF') {
    return null;
  }
  return header.readUInt16LE(18);
}

function describeGlibc() {
  const probe = spawnSync('getconf', ['GNU_LIBC_VERSION'], { encoding: 'utf8' });
  if (probe.status === 0 && probe.stdout.trim()) {
    return probe.stdout.trim();
  }
  return '';
}

if (process.platform !== 'linux') {
  fail(`Linux packaging must run on Linux; this is ${process.platform}.`);
}

const backendPath = path.join(ELECTRON_DIR, 'dist_backend', 'ensembl_go_backend');

if (!pathExists(backendPath)) {
  fail(
    `Backend executable is missing: ${backendPath}\n` +
      'Run `npm run prebuild:linux` first, which builds it with PyInstaller.'
  );
}

const machine = readElfMachine(backendPath);
if (machine === null) {
  fail(
    `${backendPath} is not an ELF executable. It is most likely a stale binary built on another ` +
      'platform. Remove dist_backend/ and re-run `npm run prebuild:linux`.'
  );
}

const expectedMachine = ELF_MACHINE_BY_ARCH[process.arch];
if (expectedMachine !== undefined && machine !== expectedMachine) {
  fail(
    `${backendPath} is ELF but built for a different architecture ` +
      `(e_machine 0x${machine.toString(16)}, expected 0x${expectedMachine.toString(16)} for ${process.arch}). ` +
      'Remove dist_backend/ and re-run `npm run prebuild:linux` on this machine.'
  );
}

try {
  fs.accessSync(backendPath, fs.constants.X_OK);
} catch {
  fail(`${backendPath} is not executable. Restore its execute bit before packaging.`);
}

log(`Backend executable verified for linux-${process.arch}: ${backendPath}`);

const glibcVersion = describeGlibc();
if (glibcVersion) {
  log(
    `Built against ${glibcVersion}. The package will not run on distributions older than this; ` +
      'build on the oldest release you intend to support.'
  );
}

const mafftExecutable = path.join(ELECTRON_DIR, 'build', 'mafft_bin', 'bin', 'mafft');
if (pathExists(mafftExecutable)) {
  log('MAFFT is bundled; multiple genic-region alignments will work without a system install.');
} else {
  log('MAFFT is not bundled; multiple genic-region alignments will need MAFFT installed at runtime.');
}
