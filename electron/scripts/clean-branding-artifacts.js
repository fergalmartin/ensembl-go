#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const distDir = path.resolve(__dirname, '..', 'dist');

function removeIfExists(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return;
  }
  fs.rmSync(targetPath, { force: true, recursive: true });
  console.log(`[build] Removed stale branding artifact: ${targetPath}`);
}

for (const target of [
  path.join(distDir, '.icon-icns'),
  path.join(distDir, 'mac'),
  path.join(distDir, 'mac-arm64'),
  path.join(distDir, 'builder-debug.yml'),
  path.join(distDir, 'builder-effective-config.yaml'),
]) {
  removeIfExists(target);
}

if (fs.existsSync(distDir)) {
  for (const entry of fs.readdirSync(distDir)) {
    if (/^(Alignment Viewer|Ensembl Local|Ensembl Go)-/.test(entry)) {
      removeIfExists(path.join(distDir, entry));
    }
  }
}
