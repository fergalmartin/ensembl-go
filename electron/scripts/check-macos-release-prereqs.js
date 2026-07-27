#!/usr/bin/env node

const { execSync } = require('child_process');

function fail(message) {
  console.error(`\n[release] ${message}\n`);
  process.exit(1);
}

if (process.platform !== 'darwin') {
  fail('macOS release artifacts must be built on macOS.');
}

function getCodeSigningIdentities() {
  try {
    return execSync('security find-identity -v -p codesigning', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    return '';
  }
}

function hasDeveloperIdApplicationIdentity(identityOutput) {
  return (
    /Developer ID Application:/.test(identityOutput) &&
    !/\b0 valid identities found\b/.test(identityOutput)
  );
}

function hasApiKeyNotarizationCredentials() {
  const hasKeyMaterial =
    Boolean(process.env.APPLE_API_KEY) || Boolean(process.env.APPLE_API_KEY_PATH);
  return (
    hasKeyMaterial &&
    Boolean(process.env.APPLE_API_KEY_ID) &&
    Boolean(process.env.APPLE_API_ISSUER)
  );
}

function hasAppleIdNotarizationCredentials() {
  return (
    Boolean(process.env.APPLE_ID) &&
    Boolean(process.env.APPLE_APP_SPECIFIC_PASSWORD) &&
    Boolean(process.env.APPLE_TEAM_ID)
  );
}

// electron-builder also accepts a stored notarytool keychain profile.
function hasKeychainProfileNotarizationCredentials() {
  return Boolean(process.env.APPLE_KEYCHAIN) && Boolean(process.env.APPLE_KEYCHAIN_PROFILE);
}

const identities = getCodeSigningIdentities();
if (!hasDeveloperIdApplicationIdentity(identities)) {
  fail(
    'No "Developer ID Application" certificate was found in your keychain.\n' +
      'Install the certificate first, then verify with:\n' +
      '  security find-identity -v -p codesigning\n\n' +
      'For local, unsigned testing builds use:\n' +
      '  npm run dist:mac:unsigned'
  );
}

if (
  !hasApiKeyNotarizationCredentials() &&
  !hasAppleIdNotarizationCredentials() &&
  !hasKeychainProfileNotarizationCredentials()
) {
  fail(
    'Notarization credentials are missing.\n' +
      'Set one of these sets. API key (recommended):\n' +
      '  APPLE_API_KEY or APPLE_API_KEY_PATH\n' +
      '  APPLE_API_KEY_ID\n' +
      '  APPLE_API_ISSUER\n\n' +
      'Apple ID:\n' +
      '  APPLE_ID\n' +
      '  APPLE_APP_SPECIFIC_PASSWORD\n' +
      '  APPLE_TEAM_ID\n\n' +
      'Stored notarytool keychain profile:\n' +
      '  APPLE_KEYCHAIN\n' +
      '  APPLE_KEYCHAIN_PROFILE'
  );
}

console.log('[release] macOS signing + notarization prerequisites detected.');
