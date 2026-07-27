#!/usr/bin/env node
//
// Keep the species classification artifacts current for a distribution build.
//
// Wraps backend/scripts/refresh_classification_artifacts.py so the build resolves Python
// the same way every other build step does. Arguments are passed through, so the build can
// use `-- --force` or `-- --max-uncovered-percent 0.5`.
//
// Cheap by default: it downloads the current species catalogue, measures how much of it
// the existing artifact covers, and only downloads the NCBI taxdump and regenerates when
// coverage has drifted. A build where nothing changed costs under a second.

const path = require('path');
const { PROJECT_DIR, log, resolvePythonCommand, runCommand } = require('./utils');

const scriptPath = path.join(PROJECT_DIR, 'backend', 'scripts', 'refresh_classification_artifacts.py');
const passthrough = process.argv.slice(2);
const { command, args } = resolvePythonCommand();

log('Checking species classification artifacts...');
runCommand(command, [...args, scriptPath, ...passthrough], { cwd: PROJECT_DIR });
