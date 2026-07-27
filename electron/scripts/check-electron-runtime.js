#!/usr/bin/env node
//
// Report whether the bundled Electron runtime is still within Electron's support window.
//
// `npm audit --omit=dev` cannot answer this. Electron is a devDependency, so the
// production audit ignores it, yet electron-builder bundles the Electron binary into
// the shipped application. An unsupported runtime therefore looks clean to the audit
// while shipping unpatched Chromium to users.
//
//   node ./scripts/check-electron-runtime.js            # warn only (exit 0)
//   node ./scripts/check-electron-runtime.js --strict    # fail the build (exit 1)

const fs = require('fs');
const https = require('https');
const path = require('path');
const { ELECTRON_DIR, log, pathExists } = require('./utils');

// Electron supports the latest three majors. Bump this when that window moves; the
// registry lookup below refines it automatically whenever the network is reachable.
const KNOWN_SUPPORTED_FLOOR = 41;
const REGISTRY_URL = 'https://registry.npmjs.org/electron/latest';
const REGISTRY_TIMEOUT_MS = 5000;

const strict = process.argv.slice(2).includes('--strict');

function readInstalledElectronVersion() {
  // What will actually be bundled is whatever is installed, so prefer that over the lockfile.
  const installedManifest = path.join(ELECTRON_DIR, 'node_modules', 'electron', 'package.json');
  if (pathExists(installedManifest)) {
    try {
      return { version: JSON.parse(fs.readFileSync(installedManifest, 'utf8')).version, source: 'node_modules' };
    } catch {
      // fall through to the lockfile
    }
  }

  const lockPath = path.join(ELECTRON_DIR, 'package-lock.json');
  if (pathExists(lockPath)) {
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      const entry = (lock.packages || {})['node_modules/electron'];
      if (entry && entry.version) {
        return { version: entry.version, source: 'package-lock.json' };
      }
    } catch {
      // fall through
    }
  }

  return null;
}

function fetchLatestElectronMajor() {
  return new Promise((resolve) => {
    const request = https.get(REGISTRY_URL, { timeout: REGISTRY_TIMEOUT_MS }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        resolve(null);
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        try {
          const major = Number.parseInt(String(JSON.parse(body).version).split('.')[0], 10);
          resolve(Number.isFinite(major) ? major : null);
        } catch {
          resolve(null);
        }
      });
    });
    request.on('timeout', () => {
      request.destroy();
      resolve(null);
    });
    request.on('error', () => resolve(null));
  });
}

function report(message) {
  if (strict) {
    console.error(`[release] ${message}`);
  } else {
    console.warn(`[release] ${message}`);
  }
}

async function main() {
  const installed = readInstalledElectronVersion();
  if (!installed) {
    report('Could not determine the installed Electron version. Run `npm ci` in electron/ first.');
    process.exit(strict ? 1 : 0);
  }

  const installedMajor = Number.parseInt(installed.version.split('.')[0], 10);
  if (!Number.isFinite(installedMajor)) {
    report(`Could not parse the Electron version "${installed.version}".`);
    process.exit(strict ? 1 : 0);
  }

  const latestMajor = await fetchLatestElectronMajor();
  const floor = latestMajor ? Math.max(latestMajor - 2, KNOWN_SUPPORTED_FLOOR) : KNOWN_SUPPORTED_FLOOR;
  const windowSource = latestMajor
    ? `Electron ${latestMajor} is current, so ${floor} and newer are supported`
    : `registry unreachable; using the recorded support floor of ${floor}`;

  if (installedMajor >= floor) {
    log(`Bundled Electron ${installed.version} is within the support window (${windowSource}).`);
    return;
  }

  report('');
  report(`Bundled Electron ${installed.version} is NO LONGER SUPPORTED (${windowSource}).`);
  report('');
  report('This ships to users: electron-builder bundles the Electron binary into the app,');
  report('so the runtime carries unpatched Chromium and Electron fixes even though');
  report('`npm audit --omit=dev` reports no production vulnerabilities.');
  report('');
  report('Review the advisories and upgrade plan before shipping:');
  report('  npm --prefix electron audit');
  report('  https://www.electronjs.org/docs/latest/tutorial/electron-timelines');
  report('');
  if (strict) {
    report('Failing because --strict was requested.');
    process.exit(1);
  }
  report('Continuing: this is a warning, not a build failure. Use --strict to enforce it.');
}

main().catch((error) => {
  report(`Electron runtime check failed to run: ${error && error.message}`);
  process.exit(strict ? 1 : 0);
});
