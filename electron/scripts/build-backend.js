#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  ELECTRON_DIR,
  PROJECT_DIR,
  copyRecursive,
  emptyDir,
  fail,
  getTargetPlatformFromArgv,
  log,
  pathExists,
  resolvePythonCommand,
  runCommand,
} = require('./utils');

function shouldCopyBackendPath(sourcePath) {
  const base = path.basename(sourcePath);
  if (base === '__pycache__' || base === '.pytest_cache' || base === 'cache') {
    return false;
  }
  if (/\.(pyc|pyo)$/i.test(base)) {
    return false;
  }
  return true;
}

function stageWindowsBackendSource() {
  const bundleRoot = path.join(ELECTRON_DIR, 'build_backend', 'windows', 'backend_source');
  const backendSourceDir = path.join(PROJECT_DIR, 'backend');
  const targetBackendDir = path.join(bundleRoot, 'backend');

  emptyDir(bundleRoot);
  copyRecursive(backendSourceDir, targetBackendDir, { filter: shouldCopyBackendPath });

  log(`Staged WSL backend source bundle: ${bundleRoot}`);
}

function buildNativeBackend() {
  const { command, args } = resolvePythonCommand();
  const pyInstallerDataSeparator = process.platform === 'win32' ? ';' : ':';
  const backendDataPath = path.join(PROJECT_DIR, 'backend', 'data');
  const backendStaticPath = path.join(PROJECT_DIR, 'backend', 'static');
  const backendEntry = path.join(PROJECT_DIR, 'backend', 'main.py');
  const specOutputDir = path.join(ELECTRON_DIR, 'build_backend', 'spec');

  fs.mkdirSync(specOutputDir, { recursive: true });
  for (const stalePath of [
    path.join(ELECTRON_DIR, 'dist_backend', 'alignment_server'),
    path.join(ELECTRON_DIR, 'dist_backend', 'alignment_server.exe'),
    path.join(ELECTRON_DIR, 'build_backend', 'alignment_server'),
    path.join(specOutputDir, 'alignment_server.spec'),
  ]) {
    fs.rmSync(stalePath, { force: true, recursive: true });
  }

  const pyInstallerArgs = [
    ...args,
    '-m',
    'PyInstaller',
    '--onefile',
    '--name',
    'ensembl_go_backend',
    '--distpath',
    'dist_backend',
    '--workpath',
    'build_backend',
    '--specpath',
    specOutputDir,
    '--hidden-import',
    'pyBigWig',
    backendEntry,
  ];

  // backend/data carries the taxonomy and project classification artifacts, which decide
  // how downloadable species are grouped. No species catalogue is bundled: it is fetched
  // from Ensembl on first run.
  if (pathExists(backendDataPath)) {
    pyInstallerArgs.splice(
      pyInstallerArgs.length - 1,
      0,
      '--add-data',
      `${backendDataPath}${pyInstallerDataSeparator}data`
    );
  } else {
    fail(
      `backend/data is missing: ${backendDataPath}\n` +
        'It holds the taxonomy and project classification artifacts. Without them the ' +
        'download view falls back to name heuristics and mis-groups many species.'
    );
  }

  // backend/static holds the sandboxed 3D structure viewer: the hand-written page
  // plus the vendored Mol* bundle that frontend/scripts/copy-structure-viewer.js
  // copies out of node_modules. Without it the Structure panel reports that its
  // assets are not installed.
  if (pathExists(path.join(backendStaticPath, 'structure', 'vendor', 'pdbe-molstar-plugin.js'))) {
    pyInstallerArgs.splice(
      pyInstallerArgs.length - 1,
      0,
      '--add-data',
      `${backendStaticPath}${pyInstallerDataSeparator}static`
    );
  } else {
    fail(
      `The 3D structure viewer bundle is missing under ${backendStaticPath}.\n` +
        'Run "npm run prepare:structure-viewer" in the frontend directory first; ' +
        'the packaged Structure panel cannot load without it.'
    );
  }

  runCommand(command, pyInstallerArgs, { cwd: ELECTRON_DIR });
}

const targetPlatform = getTargetPlatformFromArgv();

if (targetPlatform === 'win32') {
  stageWindowsBackendSource();
} else {
  buildNativeBackend();
}
