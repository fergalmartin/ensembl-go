#!/usr/bin/env node
//
// Refresh species classification artifacts before distribution builds.
//
// Use the shared Python resolver and forward arguments to the backend script,
// including `-- --force` and `-- --max-uncovered-percent 0.5`.
//
// Check catalogue coverage first; download the NCBI taxdump and regenerate
// only when coverage falls below the configured threshold.

const path = require('path');
const { PROJECT_DIR, log, resolvePythonCommand, runCommand } = require('./utils');

const scriptPath = path.join(PROJECT_DIR, 'backend', 'scripts', 'refresh_classification_artifacts.py');
const passthrough = process.argv.slice(2);
const { command, args } = resolvePythonCommand();

log('Checking species classification artifacts...');
runCommand(command, [...args, scriptPath, ...passthrough], { cwd: PROJECT_DIR });
