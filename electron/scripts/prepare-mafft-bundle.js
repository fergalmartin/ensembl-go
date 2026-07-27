#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  ELECTRON_DIR,
  copyRecursive,
  emptyDir,
  fail,
  findOnPath,
  getTargetPlatformFromArgv,
  isExecutable,
  log,
  pathExists,
} = require('./utils');

const TARGET_DIR = path.join(ELECTRON_DIR, 'build', 'mafft_bin');
const README_PATH = path.join(TARGET_DIR, 'README.txt');

function writePlaceholderBundle(reason) {
  emptyDir(TARGET_DIR);
  fs.writeFileSync(
    README_PATH,
    [
      'MAFFT is not bundled in this build.',
      reason,
      'Set MAFFT_BUNDLE_ROOT to a platform-appropriate installation root to include it.',
      'Multiple genic-region alignments will require a system MAFFT installation at runtime.',
      '',
    ].join('\n'),
    'utf8'
  );
}

function getExecutableCandidates(targetPlatform) {
  return targetPlatform === 'win32'
    ? ['mafft.bat', 'mafft.exe', 'mafft.cmd', 'mafft']
    : ['mafft'];
}

function getBinariesDirCandidates(rootDir, executablePath) {
  const execDir = executablePath ? path.dirname(executablePath) : rootDir;
  return [
    path.join(rootDir, 'libexec', 'mafft'),
    path.join(rootDir, 'lib', 'mafft'),
    path.join(execDir, '..', 'libexec', 'mafft'),
    path.join(execDir, '..', 'lib', 'mafft'),
  ];
}

function resolveBundleLayout(rootHint, targetPlatform) {
  const candidateExecutables = getExecutableCandidates(targetPlatform);
  let resolvedExecutable = null;
  let rootDir = null;

  if (rootHint) {
    const absoluteHint = path.resolve(rootHint);
    const hintStats = pathExists(absoluteHint) ? fs.statSync(absoluteHint) : null;
    if (hintStats && hintStats.isFile()) {
      resolvedExecutable = absoluteHint;
      rootDir = path.resolve(path.dirname(absoluteHint), '..');
    } else if (hintStats && hintStats.isDirectory()) {
      rootDir = absoluteHint;
      for (const executableName of candidateExecutables) {
        const candidatePath = path.join(rootDir, 'bin', executableName);
        if (pathExists(candidatePath)) {
          resolvedExecutable = candidatePath;
          break;
        }
      }
    }
  }

  if (!resolvedExecutable) {
    const onPath = findOnPath(candidateExecutables);
    if (onPath) {
      resolvedExecutable = onPath;
      rootDir = path.resolve(path.dirname(onPath), '..');
    }
  }

  if (!resolvedExecutable || !rootDir) {
    return null;
  }

  try {
    resolvedExecutable = fs.realpathSync(resolvedExecutable);
    rootDir = path.resolve(path.dirname(resolvedExecutable), '..');
  } catch {
    // Keep the original path if realpath resolution fails.
  }

  if (!isExecutable(resolvedExecutable) && targetPlatform !== 'win32') {
    return null;
  }

  const binariesDir = getBinariesDirCandidates(rootDir, resolvedExecutable).find((candidate) => pathExists(candidate));
  if (!binariesDir) {
    return null;
  }

  return {
    rootDir,
    executablePath: resolvedExecutable,
    binariesDir,
    executableName: path.basename(resolvedExecutable),
  };
}

const targetPlatform = getTargetPlatformFromArgv();

if (targetPlatform === 'win32') {
  writePlaceholderBundle('Windows builds use the system MAFFT installed inside WSL instead of bundling a native copy.');
  log('Skipped MAFFT bundling for Windows target; runtime expects MAFFT inside WSL.');
  process.exit(0);
}

if (process.env.SKIP_MAFFT_BUNDLE === '1') {
  writePlaceholderBundle('SKIP_MAFFT_BUNDLE=1 was set for this build.');
  log('SKIP_MAFFT_BUNDLE=1 set; MAFFT will not be bundled.');
  process.exit(0);
}

const layout = resolveBundleLayout(process.env.MAFFT_BUNDLE_ROOT || '', targetPlatform);
if (!layout) {
  fail(
    'Could not locate a MAFFT installation to bundle. Set MAFFT_BUNDLE_ROOT to an installation root ' +
      'containing bin/mafft(.exe|.bat) and libexec/mafft (or lib/mafft), or set SKIP_MAFFT_BUNDLE=1 to package without it.'
  );
}

emptyDir(TARGET_DIR);
fs.mkdirSync(path.join(TARGET_DIR, 'bin'), { recursive: true });
fs.mkdirSync(path.join(TARGET_DIR, 'libexec'), { recursive: true });

fs.copyFileSync(layout.executablePath, path.join(TARGET_DIR, 'bin', layout.executableName));
copyRecursive(layout.binariesDir, path.join(TARGET_DIR, 'libexec', 'mafft'));

for (const licenseName of ['LICENSE', 'COPYING']) {
  const licensePath = path.join(layout.rootDir, licenseName);
  if (pathExists(licensePath)) {
    fs.copyFileSync(licensePath, path.join(TARGET_DIR, 'LICENSE'));
    break;
  }
}

log(`Bundled MAFFT from: ${layout.rootDir}`);
log(`Executable: ${layout.executableName}`);
log(`Output: ${TARGET_DIR}`);
