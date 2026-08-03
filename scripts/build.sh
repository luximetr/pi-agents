#!/usr/bin/env bash
# Build a standalone pi-agents installer binary with the repo path baked in.
# Requires bun (https://bun.sh). Output: dist/pi-agents
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun is required (https://bun.sh)" >&2
  exit 1
fi

mkdir -p dist
# The binary cannot derive the repo path from itself (compiled = embedded fs),
# so bake it into a generated module that bun bundles in at compile time.
printf 'export const BAKED_REPO = %s;\n' "$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$REPO")" > bin/_baked.mjs
trap 'rm -f bin/_baked.mjs' EXIT

bun build bin/install.mjs --compile --minify --outfile dist/pi-agents

echo "built dist/pi-agents (repo baked in: $REPO)"
echo "usage: ./dist/pi-agents install <project>   or: cp dist/pi-agents ~/bin/"
