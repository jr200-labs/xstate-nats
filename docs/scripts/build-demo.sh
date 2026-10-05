#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
# Quarto/GAT builds from a clean checkout, using this repo's pinned pnpm.
manager=$(node -p 'require("./package.json").packageManager')
npx --yes "$manager" install --frozen-lockfile
npx --yes "$manager" run demo:build
