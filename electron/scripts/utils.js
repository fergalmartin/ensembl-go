const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ELECTRON_DIR = path.resolve(__dirname, '..');
const PROJECT_DIR = path.resolve(ELECTRON_DIR, '..');

function log(message) {
  console.log(`[build] ${message}`);
}

function fail(message) {
  console.error(`[build] ${message}`);
  process.exit(1);
}

function pathExists(targetPath) {
  try {
    fs.accessSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isExecutable(targetPath) {
  try {
    fs.accessSync(targetPath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function emptyDir(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
  fs.mkdirSync(targetPath, { recursive: true });
}

function getPathEntries() {
  const rawPath = process.env.PATH || '';
  return rawPath.split(path.delimiter).filter(Boolean);
}

function getWindowsExtCandidates(commandName) {
  const ext = path.extname(commandName);
  if (ext) {
    return [commandName];
  }
  const pathext = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .filter(Boolean)
    .map((value) => value.toLowerCase());
  return [commandName, ...pathext.map((suffix) => `${commandName}${suffix}`)];
}

function findOnPath(commandNames) {
  const entries = getPathEntries();
  for (const name of commandNames) {
    if (!name) {
      continue;
    }

    const hasPathSeparator = name.includes(path.sep) || (path.sep === '\\' && name.includes('/'));
    if (hasPathSeparator && pathExists(name)) {
      return path.resolve(name);
    }

    const candidates = process.platform === 'win32' ? getWindowsExtCandidates(name) : [name];
    for (const entry of entries) {
      for (const candidate of candidates) {
        const fullPath = path.join(entry, candidate);
        if (pathExists(fullPath)) {
          return fullPath;
        }
      }
    }
  }
  return null;
}

function resolvePythonCommand() {
  const override = process.env.ENSEMBL_LOCAL_PYTHON;
  const candidates = override
    ? [{ command: override, args: [] }]
    : process.platform === 'win32'
      ? [
          { command: 'py', args: ['-3'] },
          { command: 'python', args: [] },
          { command: 'python3', args: [] },
        ]
      : [
          { command: 'python3', args: [] },
          { command: 'python', args: [] },
        ];

  for (const candidate of candidates) {
    const resolved = findOnPath([candidate.command]) || candidate.command;
    const probe = spawnSync(resolved, [...candidate.args, '-c', 'import sys; print(sys.executable)'], {
      encoding: 'utf8',
    });
    if (probe.status === 0) {
      return { command: resolved, args: candidate.args };
    }
  }

  fail(
    process.platform === 'win32'
      ? 'Python 3 is required. Install it and ensure `py -3`, `python`, or `ENSEMBL_LOCAL_PYTHON` is available.'
      : 'Python 3 is required. Install it and ensure `python3`, `python`, or `ENSEMBL_LOCAL_PYTHON` is available.'
  );
}

function runCommand(command, args, options = {}) {
  const label = [command, ...args].join(' ');
  log(`Running: ${label}`);
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    cwd: ELECTRON_DIR,
    ...options,
  });
  if (result.status !== 0) {
    fail(`Command failed with exit code ${result.status}: ${label}`);
  }
}

function copyRecursive(sourcePath, targetPath, options = {}) {
  fs.cpSync(sourcePath, targetPath, { recursive: true, force: true, ...options });
}

function normalizeTargetPlatform(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) {
    return process.platform;
  }
  if (raw === 'darwin' || raw === 'mac' || raw === 'macos' || raw === 'osx') {
    return 'darwin';
  }
  if (raw === 'win' || raw === 'win32' || raw === 'windows') {
    return 'win32';
  }
  if (raw === 'linux') {
    return 'linux';
  }
  return raw;
}

function getTargetPlatformFromArgv(argv = process.argv.slice(2)) {
  for (let idx = 0; idx < argv.length; idx += 1) {
    const value = argv[idx];
    if (value === '--target' && argv[idx + 1]) {
      return normalizeTargetPlatform(argv[idx + 1]);
    }
    if (value.startsWith('--target=')) {
      return normalizeTargetPlatform(value.split('=')[1]);
    }
  }
  return process.platform;
}

module.exports = {
  ELECTRON_DIR,
  PROJECT_DIR,
  copyRecursive,
  emptyDir,
  fail,
  findOnPath,
  getTargetPlatformFromArgv,
  isExecutable,
  log,
  normalizeTargetPlatform,
  pathExists,
  resolvePythonCommand,
  runCommand,
};
