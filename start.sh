#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "start.sh has been renamed to run_ensembl_go.sh."
exec "$SCRIPT_DIR/run_ensembl_go.sh" "$@"
