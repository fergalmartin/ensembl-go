#!/usr/bin/env node

const path = require('path');
const { spawnSync } = require('child_process');
const {
  PROJECT_DIR,
  fail,
  getTargetPlatformFromArgv,
  log,
  pathExists,
  resolvePythonCommand,
} = require('./utils');

const REQUIRED_MODULES = [
  'fastapi',
  'uvicorn',
  'pydantic',
  'pysam',
  'Bio',
  'requests',
  'pyBigWig',
  'regex',
  'PyInstaller',
];

const targetPlatform = getTargetPlatformFromArgv();
const requirementsPath = path.join(PROJECT_DIR, 'backend', 'requirements-build.txt');

// The classification artifacts decide how downloadable species are grouped, so a build
// without them produces an application that mis-groups a large share of the catalogue.
const classificationArtifacts = [
  path.join(PROJECT_DIR, 'backend', 'data', 'taxonomy_classification.json'),
  path.join(PROJECT_DIR, 'backend', 'data', 'project_classification.json'),
];
for (const artifactPath of classificationArtifacts) {
  if (!pathExists(artifactPath)) {
    fail(
      `Missing classification artifact: ${artifactPath}\n` +
        'Regenerate it with the generators in backend/scripts/ before packaging. See the ' +
        '"Species grouping artifacts" section of electron/RELEASE.md.'
    );
  }
}

if (targetPlatform === 'win32') {
  if (!pathExists(path.join(PROJECT_DIR, 'backend', 'requirements.txt'))) {
    fail('backend/requirements.txt is missing. Windows WSL packaging needs it for runtime setup instructions.');
  }
  log('Windows target selected; native backend build prerequisites are skipped because the backend runs inside WSL.');
  process.exit(0);
}

// PyInstaller emits a host-native executable, so a native-backend target cannot be
// cross-built. Catch that here rather than after a long build that silently packages
// a foreign binary.
if (targetPlatform !== process.platform) {
  fail(
    `Cannot build the ${targetPlatform} backend on ${process.platform}. PyInstaller produces a ` +
      'host-native executable, so native-backend targets must be built on the platform they ship to. ' +
      `Run this on ${targetPlatform}, or build the ${process.platform} target instead.`
  );
}

const { command, args } = resolvePythonCommand();

const probeScript = `
import importlib.util
import sys

missing = [name for name in sys.argv[1:] if importlib.util.find_spec(name) is None]
if missing:
    print(",".join(missing))
    sys.exit(1)
`;

const result = spawnSync(command, [...args, '-c', probeScript, ...REQUIRED_MODULES], {
  encoding: 'utf8',
});

if (result.status !== 0) {
  const missing = (result.stdout || result.stderr || '')
    .trim()
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const hint = missing.length ? ` Missing: ${missing.join(', ')}.` : '';
  fail(
    `Backend Python prerequisites are missing.${hint} Install them with:\n` +
      `  ${command} ${args.join(' ')} -m pip install -r ${requirementsPath}`
  );
}

log(`Backend Python prerequisites detected via ${command}.`);
