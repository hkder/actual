#!/bin/bash
# deploy-frontend.sh
# Builds and deploys the desktop-client to the running Docker container.
# The server reads from /app/node_modules/@actual-app/web/build/ inside the container.
#
# Usage: bash scripts/deploy-frontend.sh

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."

echo "Building desktop-client (browser mode)..."
cd "$ROOT"
corepack yarn workspace @actual-app/web build:browser

echo "Done. Volume mount is live — hard-refresh the browser (Cmd+Shift+R) to pick up changes."
