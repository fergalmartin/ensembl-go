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

function resolveSpeciesJsonPath() {
  const override = process.env.ENSEMBL_LOCAL_SPECIES_JSON;
  if (override && pathExists(override)) {
    return path.resolve(override);
  }

  const candidates = [
    path.join(PROJECT_DIR, 'cluster_test_data', 'species.new_ftp_structure.json'),
    path.join(PROJECT_DIR, 'cluster_test_data', 'species.json'),
    path.join(PROJECT_DIR, '..', 'cluster_test_data', 'species.new_ftp_structure.json'),
    path.join(PROJECT_DIR, '..', 'cluster_test_data', 'species.json'),
    path.join(PROJECT_DIR, '..', 'antigravity_pangenome_mapping', 'cluster_test_data', 'species.new_ftp_structure.json'),
    path.join(PROJECT_DIR, '..', 'antigravity_pangenome_mapping', 'cluster_test_data', 'species.json'),
  ];

  for (const candidate of candidates) {
    if (pathExists(candidate)) {
      return path.resolve(candidate);
    }
  }
  return '';
}

function ensureBundledSpeciesJsonPath() {
  const resolved = resolveSpeciesJsonPath();
  if (resolved) {
    return resolved;
  }

  const generatedDir = path.join(ELECTRON_DIR, 'build_backend', 'generated');
  const placeholderPath = path.join(generatedDir, 'species.new_ftp_structure.json');
  const placeholderPayload = {
    last_updated: '',
    species: {},
  };

  fs.mkdirSync(generatedDir, { recursive: true });
  fs.writeFileSync(placeholderPath, `${JSON.stringify(placeholderPayload, null, 2)}\n`, 'utf8');
  log(`No species catalogue found; using generated empty catalogue: ${placeholderPath}`);
  return placeholderPath;
}

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

function stageWindowsBackendSource(speciesJsonPath) {
  const bundleRoot = path.join(ELECTRON_DIR, 'build_backend', 'windows', 'backend_source');
  const backendSourceDir = path.join(PROJECT_DIR, 'backend');
  const targetBackendDir = path.join(bundleRoot, 'backend');
  const targetSpeciesDir = path.join(bundleRoot, 'cluster_test_data');

  emptyDir(bundleRoot);
  copyRecursive(backendSourceDir, targetBackendDir, { filter: shouldCopyBackendPath });
  fs.mkdirSync(targetSpeciesDir, { recursive: true });
  fs.copyFileSync(speciesJsonPath, path.join(targetSpeciesDir, path.basename(speciesJsonPath)));

  log(`Staged WSL backend source bundle: ${bundleRoot}`);
}

function buildNativeBackend(speciesJsonPath) {
  const { command, args } = resolvePythonCommand();
  const pyInstallerDataSeparator = process.platform === 'win32' ? ';' : ':';
  const backendDataPath = path.join(PROJECT_DIR, 'backend', 'data');
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
    '--add-data',
    `${speciesJsonPath}${pyInstallerDataSeparator}cluster_test_data`,
    backendEntry,
  ];

  if (pathExists(backendDataPath)) {
    pyInstallerArgs.splice(
      pyInstallerArgs.length - 3,
      0,
      '--add-data',
      `${backendDataPath}${pyInstallerDataSeparator}data`
    );
  } else {
    log('No backend/data directory found; building without bundled sample genomes.');
  }

  log(`Using species catalogue: ${speciesJsonPath}`);
  runCommand(command, pyInstallerArgs, { cwd: ELECTRON_DIR });
}

const targetPlatform = getTargetPlatformFromArgv();
const speciesJsonPath = ensureBundledSpeciesJsonPath();

if (targetPlatform === 'win32') {
  stageWindowsBackendSource(speciesJsonPath);
} else {
  buildNativeBackend(speciesJsonPath);
}
