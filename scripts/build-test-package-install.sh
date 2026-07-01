#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CODE_CMD="${CODE_CMD:-code}"
SKIP_NPM_CI="${SKIP_NPM_CI:-0}"

if ! command -v node >/dev/null 2>&1; then
    echo "error: node is not installed or not on PATH" >&2
    exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
    echo "error: npm is not installed or not on PATH" >&2
    exit 1
fi

if ! command -v "$CODE_CMD" >/dev/null 2>&1; then
    echo "error: '$CODE_CMD' is not installed or not on PATH" >&2
    echo "hint: set CODE_CMD to another VS Code-compatible CLI, e.g. CODE_CMD=code-insiders $0" >&2
    exit 1
fi

EXT_NAME="$(node -p "require('./package.json').name")"
EXT_VERSION="$(node -p "require('./package.json').version")"
VSIX_FILE="${EXT_NAME}-${EXT_VERSION}.vsix"

run_step() {
    echo
    echo "==> $*"
    "$@"
}

if [[ "$SKIP_NPM_CI" != "1" ]]; then
    run_step npm ci
else
    echo
    echo "==> skipping npm ci because SKIP_NPM_CI=1"
fi

run_step npm run test-compile
run_step npm run lint
run_step npm run vscode:prepublish

rm -f "$VSIX_FILE"
run_step npx --yes @vscode/vsce package --out "$VSIX_FILE"
run_step "$CODE_CMD" --install-extension "$VSIX_FILE" --force

echo
echo "Installed $VSIX_FILE with $CODE_CMD."
