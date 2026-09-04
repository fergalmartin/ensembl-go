const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');

let mainWindow;
let backendProcess;
let backendStartupPromise = null;
let appIsQuitting = false;

let BACKEND_PORT = 8000;
const BACKEND_HOST = '127.0.0.1';
let DEFAULT_API_BASE = process.env.ENSEMBL_LOCAL_BACKEND_URL || `http://${BACKEND_HOST}:${BACKEND_PORT}`;
const LOCAL_API_TOKEN = process.env.ENSEMBL_LOCAL_API_TOKEN || crypto.randomBytes(32).toString('hex');
const REQUIRED_WSL_MODULES = [
  'fastapi',
  'uvicorn',
  'pydantic',
  'pysam',
  'Bio',
  'requests',
  'pyBigWig',
];
const APP_NAME = 'Ensembl Go';
const PACKAGED_BACKEND_EXECUTABLE = process.platform === 'win32'
  ? 'ensembl_go_backend.exe'
  : 'ensembl_go_backend';

const isDev = !app.isPackaged;
const shouldSkipBackend = Boolean(process.env.SKIP_BACKEND && process.env.SKIP_BACKEND !== '0');

app.setName(APP_NAME);

function pathExists(targetPath) {
  try {
    fs.accessSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function tryLoopbackPort(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host: BACKEND_HOST, port, exclusive: true }, () => {
      const address = server.address();
      const selectedPort = address && typeof address === 'object' ? address.port : port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(selectedPort);
      });
    });
  });
}

async function findAvailableBackendPort(preferredPort = 8000) {
  try {
    return await tryLoopbackPort(preferredPort);
  } catch (error) {
    if (!['EADDRINUSE', 'EACCES'].includes(String(error?.code || ''))) {
      throw error;
    }
    return tryLoopbackPort(0);
  }
}

async function configureManagedBackendEndpoint() {
  if (process.env.ENSEMBL_LOCAL_BACKEND_URL || shouldSkipBackend) {
    return;
  }

  const preferredPort = BACKEND_PORT;
  const selectedPort = await findAvailableBackendPort(preferredPort);
  BACKEND_PORT = selectedPort;
  DEFAULT_API_BASE = `http://${BACKEND_HOST}:${BACKEND_PORT}`;
  backendState = createBackendState();

  if (selectedPort !== preferredPort) {
    console.log(`Backend port ${preferredPort} is in use; using available port ${selectedPort} instead.`);
  }
}

function findCommandOnPath(candidates) {
  const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const pathExts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    if ((candidate.includes(path.sep) || candidate.includes('/')) && pathExists(candidate)) {
      return candidate;
    }

    for (const dir of pathEntries) {
      const names = process.platform === 'win32' && !path.extname(candidate)
        ? [candidate, ...pathExts.map((ext) => `${candidate}${ext.toLowerCase()}`)]
        : [candidate];
      for (const name of names) {
        const fullPath = path.join(dir, name);
        if (pathExists(fullPath)) {
          return fullPath;
        }
      }
    }
  }

  return null;
}

function getPythonLaunchConfig() {
  if (process.env.ENSEMBL_LOCAL_PYTHON) {
    return { command: process.env.ENSEMBL_LOCAL_PYTHON, args: [] };
  }

  if (process.platform === 'win32') {
    const pyLauncher = findCommandOnPath(['py']);
    if (pyLauncher) {
      return { command: pyLauncher, args: ['-3'] };
    }

    const python = findCommandOnPath(['python', 'python3']);
    if (python) {
      return { command: python, args: [] };
    }

    return { command: 'python', args: [] };
  }

  return { command: findCommandOnPath(['python3', 'python']) || 'python3', args: [] };
}

function getBundledMafftEnv(mafftRoot) {
  const executableNames = process.platform === 'win32'
    ? ['mafft.bat', 'mafft.exe', 'mafft.cmd', 'mafft']
    : ['mafft'];

  for (const executableName of executableNames) {
    const executablePath = path.join(mafftRoot, 'bin', executableName);
    if (pathExists(executablePath)) {
      return {
        ENSEMBL_LOCAL_MAFFT_PATH: executablePath,
        ENSEMBL_LOCAL_MAFFT_BINARIES: path.join(mafftRoot, 'libexec', 'mafft'),
      };
    }
  }

  return {};
}

function getNativeBackendLaunchConfig() {
  if (isDev) {
    const pythonLaunch = getPythonLaunchConfig();
    return {
      command: pythonLaunch.command,
      args: [
        ...pythonLaunch.args,
        path.join(__dirname, '../backend/main.py'),
        '--port',
        BACKEND_PORT.toString(),
        '--host',
        BACKEND_HOST,
      ],
      env: {
        ...process.env,
        ENSEMBL_LOCAL_API_TOKEN: LOCAL_API_TOKEN,
        ENSEMBL_GO_USER_DATA_DIR: app.getPath('userData'),
      },
      mode: 'native',
    };
  }

  const backendRoot = path.join(process.resourcesPath, 'backend_dist');
  const mafftRoot = path.join(backendRoot, 'mafft_bin');
  const backendPath = path.join(backendRoot, PACKAGED_BACKEND_EXECUTABLE);

  return {
    command: backendPath,
    args: ['--port', BACKEND_PORT.toString(), '--host', BACKEND_HOST],
    env: {
      ...process.env,
      ENSEMBL_LOCAL_API_TOKEN: LOCAL_API_TOKEN,
      ENSEMBL_GO_USER_DATA_DIR: app.getPath('userData'),
      ...getBundledMafftEnv(mafftRoot),
    },
    mode: 'native',
  };
}

function getWindowsBackendSourceRoot() {
  return isDev ? path.resolve(__dirname, '..') : path.join(process.resourcesPath, 'backend_source');
}

function getWindowsBackendMainPath(windowsRootPath) {
  return path.join(windowsRootPath, 'backend', 'main.py');
}

function getWslCommand() {
  return findCommandOnPath(['wsl.exe', 'wsl']) || 'wsl.exe';
}

function quoteForPosixShell(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function sanitizeCommandText(value) {
  return String(value || '')
    .replace(/\u0000/g, '')
    .replace(/^\uFEFF/, '');
}

function sanitizeSpawnArgument(value) {
  return sanitizeCommandText(value).trim();
}

function looksLikeUtf16Le(buffer) {
  if (!buffer || buffer.length < 2) {
    return false;
  }
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return true;
  }

  const sampleLength = Math.min(buffer.length - (buffer.length % 2), 256);
  if (sampleLength < 8) {
    return false;
  }

  let zeroHighBytes = 0;
  let pairCount = 0;
  for (let index = 1; index < sampleLength; index += 2) {
    pairCount += 1;
    if (buffer[index] === 0x00) {
      zeroHighBytes += 1;
    }
  }

  return pairCount > 0 && (zeroHighBytes / pairCount) >= 0.35;
}

function decodeCapturedOutput(chunks) {
  const buffer = Buffer.concat(Array.isArray(chunks) ? chunks : []);
  if (buffer.length === 0) {
    return '';
  }

  const decoded = looksLikeUtf16Le(buffer)
    ? buffer.toString('utf16le')
    : buffer.toString('utf8');
  return sanitizeCommandText(decoded);
}

function getDefaultWslPythonCommand() {
  return sanitizeSpawnArgument(process.env.ENSEMBL_LOCAL_WSL_PYTHON) || 'python3';
}

function createEmptyDiagnostics() {
  return {
    backendUrlOverride: {
      ok: Boolean(process.env.ENSEMBL_LOCAL_BACKEND_URL),
      value: process.env.ENSEMBL_LOCAL_BACKEND_URL || '',
      details: process.env.ENSEMBL_LOCAL_BACKEND_URL
        ? 'Using ENSEMBL_LOCAL_BACKEND_URL. WSL auto-launch is disabled until that backend responds.'
        : `Using the managed localhost backend at ${BACKEND_HOST}:${BACKEND_PORT}.`,
    },
    wsl: { ok: null, details: 'Not checked yet.' },
    distro: { ok: null, value: '', details: 'Not checked yet.' },
    backendSource: { ok: null, windowsPath: '', linuxPath: '', details: 'Not checked yet.' },
    python: { ok: null, command: getDefaultWslPythonCommand(), details: 'Not checked yet.' },
    modules: { ok: null, missing: [], details: 'Not checked yet.' },
    mafft: { ok: null, details: 'Not checked yet.' },
    health: { ok: null, details: 'Not checked yet.' },
  };
}

function createBackendState() {
  return {
    platform: process.platform,
    mode: process.platform === 'win32' ? 'wsl' : 'native',
    apiBase: DEFAULT_API_BASE,
    apiToken: LOCAL_API_TOKEN,
    host: BACKEND_HOST,
    port: BACKEND_PORT,
    ready: false,
    attached: false,
    launchedByElectron: false,
    status: 'checking',
    lastError: '',
    diagnostics: process.platform === 'win32' ? createEmptyDiagnostics() : null,
    setupCommands: {},
    timestamp: Date.now(),
  };
}

let backendState = createBackendState();

function publishBackendState() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send('backend:status', backendState);
}

function updateBackendState(patch) {
  const diagnostics = Object.prototype.hasOwnProperty.call(patch, 'diagnostics')
    ? patch.diagnostics
    : backendState.diagnostics;
  const setupCommands = Object.prototype.hasOwnProperty.call(patch, 'setupCommands')
    ? patch.setupCommands
    : backendState.setupCommands;

  backendState = {
    ...backendState,
    ...patch,
    diagnostics,
    setupCommands,
    timestamp: Date.now(),
  };
  publishBackendState();
}

function buildBackendUrl(pathname) {
  return new URL(pathname, DEFAULT_API_BASE).toString();
}

function isAllowedRendererUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'file:') {
      return true;
    }
    if (parsed.protocol !== 'http:') {
      return false;
    }
    return ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseHtmlSnapshotMarkup(rawMarkup) {
  const markup = String(rawMarkup || '').trim();
  const headMatch = markup.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
  const bodyMatch = markup.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return {
    headMarkup: headMatch ? headMatch[1].trim() : '',
    bodyMarkup: bodyMatch ? bodyMatch[1].trim() : markup,
  };
}

async function captureHtmlSnapshot(payload = {}) {
  const { headMarkup, bodyMarkup } = parseHtmlSnapshotMarkup(payload?.htmlMarkup);
  if (!bodyMarkup) {
    throw new Error('Missing HTML markup for screenshot capture.');
  }

  const baseWidth = Math.max(1, Math.round(Number(payload?.width) || 1));
  const baseHeight = Math.max(1, Math.round(Number(payload?.height) || 1));
  const scale = Math.max(1, Number(payload?.scale) || 1);
  const captureWidth = Math.max(1, Math.round(baseWidth * scale));
  const captureHeight = Math.max(1, Math.round(baseHeight * scale));
  const format = String(payload?.format || 'png').trim().toLowerCase() === 'jpeg' ? 'jpeg' : 'png';
  const quality = Math.max(1, Math.min(100, Math.round(Number(payload?.quality) || 92)));
  const backgroundColor = String(payload?.backgroundColor || '#ffffff').trim() || '#ffffff';
  let tempCaptureDir = null;

  // The capture page renders markup handed over by the renderer. It is already
  // sandboxed with no node access, so this CSP is the second layer: no script
  // execution and no outbound requests, which keeps a renderer-side injection
  // from using this file:// page to reach the network. Inline styles and
  // data:/blob: images stay allowed because the snapshot depends on them.
  const capturePolicy = [
    "default-src 'none'",
    "img-src data: blob:",
    "style-src 'unsafe-inline'",
    "font-src data:",
  ].join('; ');

  const htmlDocument = [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '<meta charset="UTF-8" />',
    `<meta http-equiv="Content-Security-Policy" content="${capturePolicy}" />`,
    '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    headMarkup,
    '<style>',
    `html, body { margin: 0; padding: 0; width: ${captureWidth}px; min-height: ${captureHeight}px; overflow: hidden; background: ${escapeHtml(backgroundColor)}; }`,
    `body { width: ${captureWidth}px; min-height: ${captureHeight}px; background: ${escapeHtml(backgroundColor)}; }`,
    `body > .__ensembl_capture_root { position: absolute; left: 0; top: 0; width: ${baseWidth}px; min-width: ${baseWidth}px; height: ${baseHeight}px; min-height: ${baseHeight}px; transform-origin: top left; }`,
    scale !== 1 ? `body > .__ensembl_capture_root { transform: scale(${scale}); }` : '',
    '</style>',
    '</head>',
    '<body>',
    '<div class="__ensembl_capture_root">',
    bodyMarkup,
    '</div>',
    '</body>',
    '</html>',
  ].join('');

  const captureWindow = new BrowserWindow({
    show: false,
    width: captureWidth,
    height: captureHeight,
    useContentSize: true,
    frame: false,
    resizable: false,
    backgroundColor,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  try {
    tempCaptureDir = await fs.promises.mkdtemp(path.join(app.getPath('temp'), 'ensembl-go-screenshot-'));
    const tempCapturePath = path.join(tempCaptureDir, 'capture.html');
    await fs.promises.writeFile(tempCapturePath, htmlDocument, 'utf8');
    await captureWindow.loadFile(tempCapturePath);
    await captureWindow.webContents.executeJavaScript(
      `(async () => {
        if (document.fonts?.ready) {
          await document.fonts.ready;
        }
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return true;
      })();`,
      true
    );

    const image = await captureWindow.webContents.capturePage({
      x: 0,
      y: 0,
      width: captureWidth,
      height: captureHeight,
    });
    const data = format === 'jpeg'
      ? image.toJPEG(quality)
      : image.toPNG();

    return {
      base64: data.toString('base64'),
      mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
      width: captureWidth,
      height: captureHeight,
    };
  } finally {
    if (!captureWindow.isDestroyed()) {
      captureWindow.destroy();
    }
    if (tempCaptureDir) {
      await fs.promises.rm(tempCaptureDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function runCommandCapture(command, args, options = {}) {
  const { env, cwd, timeoutMs = 15000 } = options;

  return new Promise((resolve) => {
    let settled = false;
    const stdoutChunks = [];
    const stderrChunks = [];

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve({
        ...result,
        stdout: Object.prototype.hasOwnProperty.call(result, 'stdout') ? result.stdout : decodeCapturedOutput(stdoutChunks),
        stderr: Object.prototype.hasOwnProperty.call(result, 'stderr') ? result.stderr : decodeCapturedOutput(stderrChunks),
      });
    };

    let child;
    try {
      child = spawn(command, args, {
        env: env || process.env,
        cwd,
        windowsHide: true,
      });
    } catch (error) {
      finish({ status: null, error });
      return;
    }

    const timer = timeoutMs
      ? setTimeout(() => {
          child.kill();
          finish({ status: null, error: new Error('Timed out') });
        }, timeoutMs)
      : null;

    if (child.stdout) {
      child.stdout.on('data', (data) => {
        stdoutChunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (data) => {
        stderrChunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
      });
    }

    child.on('error', (error) => {
      finish({ status: null, error });
    });

    child.on('close', (status) => {
      finish({ status, error: null });
    });
  });
}

function buildWslArgs(commandLine, distro = '') {
  const args = [];
  const sanitizedDistro = sanitizeSpawnArgument(distro);
  if (sanitizedDistro) {
    args.push('-d', sanitizedDistro);
  }
  args.push('--', 'bash', '-lc', sanitizeCommandText(commandLine));
  return args;
}

async function runWslShell(commandLine, distro = '', timeoutMs = 15000) {
  return runCommandCapture(getWslCommand(), buildWslArgs(commandLine, distro), { timeoutMs });
}

async function translateWindowsPathToWsl(windowsPath, distro = '') {
  const args = [];
  const sanitizedDistro = sanitizeSpawnArgument(distro);
  if (sanitizedDistro) {
    args.push('-d', sanitizedDistro);
  }
  args.push('--', 'wslpath', '-a', windowsPath);
  const result = await runCommandCapture(getWslCommand(), args, { timeoutMs: 15000 });
  if (result.status !== 0 || result.error) {
    const detail = (result.stderr || result.stdout || result.error?.message || 'Unknown error').trim();
    throw new Error(detail || 'Failed to translate Windows path into a WSL path.');
  }
  const translated = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  if (!translated) {
    throw new Error('WSL path translation returned an empty result.');
  }
  return translated.trim();
}

function parseWslListOutput(output) {
  const candidates = [];
  for (const rawLine of sanitizeCommandText(output).split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      continue;
    }
    if (/^Windows Subsystem for Linux/i.test(line) || /^NAME\s+STATE\s+VERSION$/i.test(line.trim()) || /^NAME$/i.test(line.trim())) {
      continue;
    }
    const isDefault = line.trimStart().startsWith('*');
    const withoutMarker = line.replace(/^\s*\*\s*/, '').trim();
    const name = withoutMarker.split(/\s{2,}/)[0]?.trim();
    if (!name) {
      continue;
    }
    if (isDefault) {
      return sanitizeSpawnArgument(name);
    }
    candidates.push(sanitizeSpawnArgument(name));
  }
  return sanitizeSpawnArgument(candidates[0] || '');
}

async function resolveWslDistro() {
  const override = sanitizeSpawnArgument(process.env.ENSEMBL_LOCAL_WSL_DISTRO);
  if (override) {
    return {
      ok: true,
      value: override,
      details: 'Using ENSEMBL_LOCAL_WSL_DISTRO override.',
    };
  }

  const verbose = await runCommandCapture(getWslCommand(), ['-l', '-v'], { timeoutMs: 15000 });
  if (verbose.status === 0) {
    const distro = parseWslListOutput(verbose.stdout);
    if (distro) {
      return {
        ok: true,
        value: distro,
        details: `Default WSL distro: ${distro}`,
      };
    }
  }

  const quiet = await runCommandCapture(getWslCommand(), ['-l', '-q'], { timeoutMs: 15000 });
  if (quiet.status === 0) {
    const distro = parseWslListOutput(quiet.stdout);
    if (distro) {
      return {
        ok: true,
        value: distro,
        details: `Detected WSL distro: ${distro}`,
      };
    }
  }

  const detail = sanitizeCommandText(verbose.stderr || verbose.stdout || quiet.stderr || quiet.stdout || 'No WSL distro is installed yet.').trim();
  return {
    ok: false,
    value: '',
    details: detail || 'No WSL distro is installed yet.',
  };
}

function createHealthDetails(health) {
  if (health.ok) {
    return 'Backend HTTP health check succeeded.';
  }
  if (health.statusCode) {
    return `Backend responded with HTTP ${health.statusCode}.`;
  }
  return health.error || 'Backend did not respond on the expected localhost endpoint.';
}

async function checkBackendHealth(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const request = http.get(buildBackendUrl('/api/health'), { timeout: timeoutMs }, (response) => {
      response.resume();
      resolve({
        ok: response.statusCode === 200,
        statusCode: response.statusCode || null,
        error: '',
      });
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('Timed out waiting for backend health check.'));
    });

    request.on('error', (error) => {
      resolve({
        ok: false,
        statusCode: null,
        error: error.message,
      });
    });

    request.end();
  });
}

async function waitForBackendReady(maxAttempts = 60, intervalMs = 500) {
  let lastHealth = { ok: false, statusCode: null, error: 'Backend did not start.' };
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    lastHealth = await checkBackendHealth();
    if (lastHealth.ok) {
      return lastHealth;
    }
    await sleep(intervalMs);
  }
  return lastHealth;
}

async function resolveWslPythonCommand(linuxRootPath, distro = '') {
  const override = sanitizeSpawnArgument(process.env.ENSEMBL_LOCAL_WSL_PYTHON);
  if (override) {
    return override;
  }

  if (linuxRootPath) {
    const venvPython = path.posix.join(linuxRootPath, '.venv', 'bin', 'python');
    const venvCheck = await runWslShell(`[ -x ${quoteForPosixShell(venvPython)} ]`, distro, 15000);
    if (venvCheck.status === 0) {
      return venvPython;
    }
  }

  return 'python3';
}

function createWindowsSetupCommands(linuxRootPath, pythonCommand) {
  if (!linuxRootPath) {
    return {};
  }

  const backendMain = path.posix.join(linuxRootPath, 'backend', 'main.py');
  const requirementsPath = path.posix.join(linuxRootPath, 'backend', 'requirements.txt');
  const venvDir = path.posix.join(linuxRootPath, '.venv');
  const venvPython = path.posix.join(venvDir, 'bin', 'python');
  const installPythonDeps = sanitizeSpawnArgument(process.env.ENSEMBL_LOCAL_WSL_PYTHON)
    ? `${quoteForPosixShell(pythonCommand)} -m pip install -r ${quoteForPosixShell(requirementsPath)}`
    : `python3 -m venv ${quoteForPosixShell(venvDir)} && ${quoteForPosixShell(venvPython)} -m pip install --upgrade pip && ${quoteForPosixShell(venvPython)} -m pip install -r ${quoteForPosixShell(requirementsPath)}`;

  return {
    installSystemPackages: 'sudo apt update && sudo apt install -y python3 python3-pip python3-venv',
    installMafft: 'sudo apt install -y mafft',
    installPythonDeps,
    startBackend: `ENSEMBL_LOCAL_API_TOKEN=${quoteForPosixShell(LOCAL_API_TOKEN)} ${quoteForPosixShell(pythonCommand)} ${quoteForPosixShell(backendMain)} --host ${BACKEND_HOST} --port ${BACKEND_PORT}`,
  };
}

async function collectWindowsDiagnostics(health = { ok: false, statusCode: null, error: '' }) {
  const diagnostics = createEmptyDiagnostics();
  diagnostics.health = { ok: health.ok, details: createHealthDetails(health) };

  if (process.env.ENSEMBL_LOCAL_BACKEND_URL) {
    return {
      diagnostics,
      setupCommands: {},
      canLaunch: false,
      distro: '',
      backendLinuxRoot: '',
      pythonCommand: diagnostics.python.command,
      launchCommandLine: '',
      blockingReason: `Backend URL override is set to ${process.env.ENSEMBL_LOCAL_BACKEND_URL}, but that endpoint is not healthy yet.`,
    };
  }

  const wslCommand = getWslCommand();
  const wslProbe = await runCommandCapture(wslCommand, ['-l', '-q'], { timeoutMs: 15000 });
  if (wslProbe.error && /ENOENT/i.test(String(wslProbe.error.code || wslProbe.error.message || ''))) {
    diagnostics.wsl = {
      ok: false,
      details: 'wsl.exe was not found. Install Windows Subsystem for Linux and an Ubuntu or Debian distro first.',
    };
    return {
      diagnostics,
      setupCommands: {},
      canLaunch: false,
      distro: '',
      backendLinuxRoot: '',
      pythonCommand: diagnostics.python.command,
      launchCommandLine: '',
      blockingReason: diagnostics.wsl.details,
    };
  }

  diagnostics.wsl = {
    ok: wslProbe.status === 0,
    details: wslProbe.status === 0
      ? 'WSL is installed and reachable from Electron.'
      : (wslProbe.stderr || wslProbe.stdout || 'WSL is installed but could not be queried.').trim(),
  };

  const distroInfo = await resolveWslDistro();
  diagnostics.distro = distroInfo;

  const backendWindowsRoot = getWindowsBackendSourceRoot();
  const backendMainPath = getWindowsBackendMainPath(backendWindowsRoot);
  if (!pathExists(backendMainPath)) {
    diagnostics.backendSource = {
      ok: false,
      windowsPath: backendWindowsRoot,
      linuxPath: '',
      details: `Backend source bundle is missing at ${backendMainPath}. Rebuild the Windows package to include backend_source.`,
    };
    return {
      diagnostics,
      setupCommands: {},
      canLaunch: false,
      distro: distroInfo.value,
      backendLinuxRoot: '',
      pythonCommand: diagnostics.python.command,
      launchCommandLine: '',
      blockingReason: diagnostics.backendSource.details,
    };
  }

  let backendLinuxRoot = '';
  if (diagnostics.wsl.ok && distroInfo.ok) {
    try {
      backendLinuxRoot = await translateWindowsPathToWsl(backendWindowsRoot, distroInfo.value);
      diagnostics.backendSource = {
        ok: true,
        windowsPath: backendWindowsRoot,
        linuxPath: backendLinuxRoot,
        details: 'Backend source bundle is available and reachable from WSL.',
      };
    } catch (error) {
      diagnostics.backendSource = {
        ok: false,
        windowsPath: backendWindowsRoot,
        linuxPath: '',
        details: error.message,
      };
    }
  } else {
    diagnostics.backendSource = {
      ok: false,
      windowsPath: backendWindowsRoot,
      linuxPath: '',
      details: 'Backend source bundle cannot be translated until WSL and a default distro are available.',
    };
  }

  const pythonCommand = await resolveWslPythonCommand(backendLinuxRoot, distroInfo.value);
  diagnostics.python.command = pythonCommand;
  const setupCommands = createWindowsSetupCommands(backendLinuxRoot, pythonCommand);

  if (diagnostics.wsl.ok && distroInfo.ok) {
    const pythonCheck = pythonCommand.includes('/')
      ? await runWslShell(`[ -x ${quoteForPosixShell(pythonCommand)} ]`, distroInfo.value, 15000)
      : await runWslShell(`command -v ${quoteForPosixShell(pythonCommand)} >/dev/null 2>&1`, distroInfo.value, 15000);
    diagnostics.python = {
      ok: pythonCheck.status === 0,
      command: pythonCommand,
      details: pythonCheck.status === 0
        ? `${pythonCommand} is available inside WSL.`
        : `${pythonCommand} was not found in WSL. Install Python 3 in your distro before retrying.`,
    };
  }

  if (diagnostics.python.ok && backendLinuxRoot) {
    const moduleProbeCode = [
      'import importlib.util, json, sys',
      'missing = [name for name in sys.argv[1:] if importlib.util.find_spec(name) is None]',
      'print(json.dumps({"missing": missing}))',
    ].join('; ');
    const moduleCheck = await runWslShell(
      `${quoteForPosixShell(pythonCommand)} -c ${quoteForPosixShell(moduleProbeCode)} ${REQUIRED_WSL_MODULES.map((name) => quoteForPosixShell(name)).join(' ')}`,
      distroInfo.value,
      20000,
    );

    if (moduleCheck.status === 0) {
      try {
        const parsed = JSON.parse(moduleCheck.stdout.trim() || '{"missing":[]}');
        const missing = Array.isArray(parsed.missing) ? parsed.missing : [];
        diagnostics.modules = {
          ok: missing.length === 0,
          missing,
          details: missing.length === 0
            ? 'Required Python modules are installed inside WSL.'
            : `Missing Python modules in WSL: ${missing.join(', ')}`,
        };
      } catch (error) {
        diagnostics.modules = {
          ok: false,
          missing: REQUIRED_WSL_MODULES,
          details: `Could not parse the WSL Python dependency probe: ${error.message}`,
        };
      }
    } else {
      diagnostics.modules = {
        ok: false,
        missing: REQUIRED_WSL_MODULES,
        details: (moduleCheck.stderr || moduleCheck.stdout || 'Python dependency probe failed inside WSL.').trim(),
      };
    }
  }

  if (diagnostics.wsl.ok && distroInfo.ok) {
    const mafftCheck = await runWslShell('command -v mafft >/dev/null 2>&1', distroInfo.value, 15000);
    diagnostics.mafft = {
      ok: mafftCheck.status === 0,
      details: mafftCheck.status === 0
        ? 'MAFFT is installed; multiple genic-region alignments are available.'
        : 'Optional. Install MAFFT to run multiple genic-region alignments with annotation overlays.',
    };
  }

  const launchCommandLine = backendLinuxRoot
    ? [
        'ENSEMBL_LOCAL_API_TOKEN=' + quoteForPosixShell(LOCAL_API_TOKEN),
        'exec',
        quoteForPosixShell(pythonCommand),
        quoteForPosixShell(path.posix.join(backendLinuxRoot, 'backend', 'main.py')),
        '--host',
        BACKEND_HOST,
        '--port',
        String(BACKEND_PORT),
      ].join(' ')
    : '';

  const canLaunch = Boolean(
    diagnostics.wsl.ok
      && diagnostics.distro.ok
      && diagnostics.backendSource.ok
      && diagnostics.python.ok
      && diagnostics.modules.ok
      && launchCommandLine
  );

  const blockingReason = canLaunch
    ? ''
    : diagnostics.wsl.details
      || diagnostics.distro.details
      || diagnostics.backendSource.details
      || diagnostics.python.details
      || diagnostics.modules.details
      || diagnostics.health.details;

  return {
    diagnostics,
    setupCommands,
    canLaunch,
    distro: distroInfo.value,
    backendLinuxRoot,
    pythonCommand,
    launchCommandLine,
    blockingReason,
  };
}

function attachManagedProcess(child, label) {
  backendProcess = child;

  if (child.stdout) {
    child.stdout.on('data', (data) => {
      console.log(`${label} stdout: ${data}`);
    });
  }

  if (child.stderr) {
    child.stderr.on('data', (data) => {
      console.error(`${label} stderr: ${data}`);
    });
  }

  child.on('error', (error) => {
    console.error(`${label} error: ${error.message}`);
    updateBackendState({
      ready: false,
      attached: false,
      launchedByElectron: false,
      status: process.platform === 'win32' ? 'setup_required' : 'error',
      lastError: error.message,
    });
  });

  child.on('close', (code) => {
    console.log(`${label} exited with code ${code}`);
    if (backendProcess === child) {
      backendProcess = null;
    }
    if (!appIsQuitting) {
      updateBackendState({
        ready: false,
        attached: false,
        launchedByElectron: false,
        status: process.platform === 'win32' ? 'setup_required' : 'error',
        lastError: `${label} exited with code ${code}`,
      });
    }
  });
}

function startNativeBackendProcess() {
  const { command, args, env } = getNativeBackendLaunchConfig();
  console.log(`Starting backend: ${command} ${args.join(' ')}`);
  const child = spawn(command, args, { env, windowsHide: true });
  attachManagedProcess(child, 'Backend');
}

function startWindowsBackendProcess(distro, launchCommandLine) {
  const args = buildWslArgs(launchCommandLine, distro);
  console.log(`Starting WSL backend: ${getWslCommand()} ${args.join(' ')}`);
  const child = spawn(getWslCommand(), args, { env: process.env, windowsHide: true });
  attachManagedProcess(child, 'WSL backend');
}

function stopBackend() {
  if (backendProcess && backendState.launchedByElectron) {
    console.log('Stopping managed backend process...');
    backendProcess.kill();
  }
  backendProcess = null;
}

async function ensureNativeBackend({ allowLaunch = true } = {}) {
  updateBackendState({
    mode: 'native',
    status: 'checking',
    lastError: '',
    attached: false,
    launchedByElectron: false,
  });

  const health = await checkBackendHealth();
  if (health.ok) {
    updateBackendState({
      ready: true,
      attached: true,
      launchedByElectron: false,
      status: 'ready',
      lastError: '',
    });
    return true;
  }

  if (!allowLaunch || process.env.ENSEMBL_LOCAL_BACKEND_URL) {
    updateBackendState({
      ready: false,
      status: 'error',
      lastError: createHealthDetails(health),
    });
    return false;
  }

  stopBackend();
  updateBackendState({
    ready: false,
    status: 'launching',
    lastError: '',
  });
  startNativeBackendProcess();
  const ready = await waitForBackendReady();
  updateBackendState({
    ready: ready.ok,
    attached: ready.ok,
    launchedByElectron: ready.ok,
    status: ready.ok ? 'ready' : 'error',
    lastError: ready.ok ? '' : createHealthDetails(ready),
  });
  return ready.ok;
}

async function ensureWindowsBackend({ allowLaunch = true } = {}) {
  updateBackendState({
    mode: 'wsl',
    status: 'checking',
    ready: false,
    attached: false,
    launchedByElectron: false,
    lastError: '',
    diagnostics: createEmptyDiagnostics(),
    setupCommands: {},
  });

  const health = await checkBackendHealth();
  if (health.ok) {
    updateBackendState({
      ready: true,
      attached: true,
      launchedByElectron: false,
      status: 'ready',
      lastError: '',
      diagnostics: {
        ...createEmptyDiagnostics(),
        health: { ok: true, details: createHealthDetails(health) },
      },
      setupCommands: {},
    });
    return true;
  }

  const diagnosticsResult = await collectWindowsDiagnostics(health);
  updateBackendState({
    diagnostics: diagnosticsResult.diagnostics,
    setupCommands: diagnosticsResult.setupCommands,
    lastError: diagnosticsResult.blockingReason || createHealthDetails(health),
  });

  if (!allowLaunch || !diagnosticsResult.canLaunch) {
    updateBackendState({
      ready: false,
      status: 'setup_required',
      attached: false,
      launchedByElectron: false,
      lastError: diagnosticsResult.blockingReason || createHealthDetails(health),
    });
    return false;
  }

  stopBackend();
  updateBackendState({
    ready: false,
    status: 'launching',
    attached: false,
    launchedByElectron: true,
    lastError: '',
  });

  startWindowsBackendProcess(diagnosticsResult.distro, diagnosticsResult.launchCommandLine);
  const ready = await waitForBackendReady();

  if (ready.ok) {
    updateBackendState({
      ready: true,
      attached: true,
      launchedByElectron: true,
      status: 'ready',
      lastError: '',
      diagnostics: {
        ...diagnosticsResult.diagnostics,
        health: { ok: true, details: createHealthDetails(ready) },
      },
      setupCommands: diagnosticsResult.setupCommands,
    });
    return true;
  }

  const retryDiagnostics = await collectWindowsDiagnostics(ready);
  updateBackendState({
    ready: false,
    attached: false,
    launchedByElectron: false,
    status: 'setup_required',
    lastError: retryDiagnostics.blockingReason || createHealthDetails(ready),
    diagnostics: retryDiagnostics.diagnostics,
    setupCommands: retryDiagnostics.setupCommands,
  });
  return false;
}

async function ensureBackend(options = {}) {
  if (backendStartupPromise) {
    return backendStartupPromise;
  }

  backendStartupPromise = (async () => {
    if (process.platform === 'win32') {
      return ensureWindowsBackend(options);
    }
    return ensureNativeBackend(options);
  })();

  try {
    return await backendStartupPromise;
  } finally {
    backendStartupPromise = null;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    title: APP_NAME,
    backgroundColor: '#1a1d2e',
    show: false,
    minWidth: 1024,
    minHeight: 768,
  });

  if (isDev && process.env.ELECTRON_START_URL) {
    if (!isAllowedRendererUrl(process.env.ELECTRON_START_URL)) {
      throw new Error('ELECTRON_START_URL must be a loopback http URL in development.');
    }
    mainWindow.loadURL(process.env.ELECTRON_START_URL);
  } else if (isDev) {
    mainWindow.loadFile(path.join(__dirname, '../frontend/dist/index.html'));
  } else {
    const indexPath = path.join(__dirname, 'frontend/dist/index.html');
    console.log('Target HTML:', indexPath);
    mainWindow.loadFile(indexPath);
  }

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isAllowedRendererUrl(targetUrl)) {
      event.preventDefault();
    }
  });

  // The structure viewer runs in a sandboxed iframe on the loopback backend.
  // Sub-frame navigation is held to the same rule as the top frame so that
  // third-party code inside it cannot steer its own frame off-origin.
  mainWindow.webContents.on('will-frame-navigate', (event) => {
    if (!isAllowedRendererUrl(event.url)) {
      event.preventDefault();
    }
  });

  mainWindow.webContents.on('did-finish-load', () => {
    publishBackendState();
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  await configureManagedBackendEndpoint();

  ipcMain.handle('dialog:openFile', async (_event, defaultPath) => {
    const options = {
      properties: ['openFile'],
      filters: [
        { name: 'All Files', extensions: ['*'] },
        { name: 'FASTA', extensions: ['fa', 'fasta', 'fna', 'fa.gz'] },
        { name: 'GFF3', extensions: ['gff3', 'gff', 'gff3.gz'] },
        { name: 'TSV/CSV', extensions: ['tsv', 'csv', 'txt'] },
      ],
    };
    if (defaultPath) options.defaultPath = defaultPath;
    const result = await dialog.showOpenDialog(mainWindow, options);
    if (result.canceled) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('dialog:openDirectory', async (_event, defaultPath) => {
    const options = {
      properties: ['openDirectory'],
    };
    if (defaultPath) options.defaultPath = defaultPath;
    const result = await dialog.showOpenDialog(mainWindow, options);
    if (result.canceled) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('dialog:saveFile', async (_event, defaultPath) => {
    const options = {
      title: 'Save Configuration',
      defaultPath,
      filters: [
        { name: 'Configuration', extensions: ['cfg', 'json'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    };
    const result = await dialog.showSaveDialog(mainWindow, options);
    if (result.canceled) return null;
    return result.filePath;
  });

  ipcMain.handle('app:getDesktopPath', async () => app.getPath('desktop'));

  ipcMain.handle('screenshot:captureHtmlSnapshot', async (_event, payload) => captureHtmlSnapshot(payload));

  ipcMain.on('backend:getRuntimeSync', (event) => {
    event.returnValue = backendState;
  });

  ipcMain.handle('backend:getRuntimeStatus', async () => backendState);
  ipcMain.handle('backend:retry-check', async () => {
    await ensureBackend({ allowLaunch: false });
    return backendState;
  });
  ipcMain.handle('backend:retry-launch', async () => {
    await ensureBackend({ allowLaunch: true });
    return backendState;
  });

  const electronConfigPath = path.join(app.getPath('userData'), 'config.json');

  ipcMain.on('config:loadSync', (event) => {
    try {
      if (fs.existsSync(electronConfigPath)) {
        event.returnValue = JSON.parse(fs.readFileSync(electronConfigPath, 'utf8'));
      } else {
        event.returnValue = null;
      }
    } catch {
      event.returnValue = null;
    }
  });

  ipcMain.handle('config:save', (_event, config) => {
    try {
      const tmp = electronConfigPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
      fs.renameSync(tmp, electronConfigPath);
      return { ok: true };
    } catch (e) {
      console.error('Failed to save Electron config:', e);
      return { ok: false };
    }
  });

  const ready = await ensureBackend({ allowLaunch: !shouldSkipBackend });
  createWindow();

  if (!ready && process.platform !== 'win32') {
    dialog.showMessageBox({
      type: 'warning',
      title: 'Backend Not Ready',
      message: 'The backend API did not become ready in time. Some features may not work until it is started.',
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  appIsQuitting = true;
  stopBackend();
});
