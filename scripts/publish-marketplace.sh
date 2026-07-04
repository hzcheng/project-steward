#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SKIP_NPM_CI="${SKIP_NPM_CI:-0}"
SKIP_LINT="${SKIP_LINT:-0}"
DRY_RUN="${DRY_RUN:-0}"
VERSION="${VERSION:-}"
BUMP="${BUMP:-}"
VSCE="${VSCE:-npx --yes @vscode/vsce}"

if ! command -v node >/dev/null 2>&1; then
    echo "error: node is not installed or not on PATH" >&2
    exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
    echo "error: npm is not installed or not on PATH" >&2
    exit 1
fi

if [[ -n "$VERSION" && -n "$BUMP" ]]; then
    echo "error: set only one of VERSION or BUMP" >&2
    exit 1
fi

run_step() {
    echo
    echo "==> $*"
    "$@"
}

run_vsce() {
    # shellcheck disable=SC2086
    $VSCE "$@"
}

if [[ -n "$VERSION" ]]; then
    run_step npm version "$VERSION" --no-git-tag-version
elif [[ -n "$BUMP" ]]; then
    run_step npm version "$BUMP" --no-git-tag-version
fi

EXT_NAME="$(node -p "require('./package.json').name")"
EXT_VERSION="$(node -p "require('./package.json').version")"
PUBLISHER="$(node -p "require('./package.json').publisher")"
VSIX_FILE="${EXT_NAME}-${EXT_VERSION}.vsix"

echo
echo "Publishing ${PUBLISHER}.${EXT_NAME} ${EXT_VERSION}"

if [[ "$SKIP_NPM_CI" != "1" ]]; then
    run_step npm ci
else
    echo
    echo "==> skipping npm ci because SKIP_NPM_CI=1"
fi

run_step npm run test-compile

if [[ "$SKIP_LINT" != "1" ]]; then
    run_step npm run lint
else
    echo
    echo "==> skipping npm run lint because SKIP_LINT=1"
fi

rm -f "$VSIX_FILE"
run_vsce package --allow-star-activation --out "$VSIX_FILE"

if [[ "$DRY_RUN" == "1" ]]; then
    echo
    echo "Dry run complete. Built $VSIX_FILE but did not publish."
    exit 0
fi

PUBLISH_ARGS=(publish --packagePath "$VSIX_FILE" --allow-star-activation)
if [[ -n "${VSCE_PAT:-}" ]]; then
    PUBLISH_ARGS+=(--pat "$VSCE_PAT")
fi

run_vsce "${PUBLISH_ARGS[@]}"

echo
echo "Published ${PUBLISHER}.${EXT_NAME} ${EXT_VERSION} from $VSIX_FILE."
