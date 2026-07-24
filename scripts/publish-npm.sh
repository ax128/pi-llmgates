#!/usr/bin/env bash
# Publish @llmgates_api/pi-llmgates-provider using NPM_TOKEN from .env
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
	echo "error: missing .env (copy .env.example and set NPM_TOKEN)" >&2
	exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

if [[ -z "${NPM_TOKEN:-}" ]]; then
	echo "error: NPM_TOKEN empty in .env" >&2
	exit 1
fi

VERSION="$(node -p "require('./package.json').version")"
echo "Publishing @llmgates_api/pi-llmgates-provider@$VERSION"

npm run check
npm pack --dry-run
npm publish --access public "$@"

echo "Published. Next:"
echo "  git tag v$VERSION && git push origin v$VERSION"
echo "  npm view @llmgates_api/pi-llmgates-provider version"
