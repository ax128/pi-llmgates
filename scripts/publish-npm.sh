#!/usr/bin/env bash
# Publish @llmgates_api/pi-llmgates-provider using NPM_TOKEN from .env
# Typical agent flow:
#   1) node ./scripts/npm-publish-auth-link.mjs   # send URL to user
#   2) ./scripts/publish-npm.sh --otp=<code>      # after user replies
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

# Skip full check when only finishing an OTP publish after a prior check
if [[ "${SKIP_CHECK:-}" != "1" ]]; then
	npm run check
fi
npm pack --dry-run
npm publish --access public --ignore-scripts "$@"

REMOTE="$(npm view @llmgates_api/pi-llmgates-provider version)"
echo "Published. registry version=$REMOTE"
echo
echo "Install examples (send to user):"
echo "  pi install npm:@llmgates_api/pi-llmgates-provider"
echo "  pi install npm:@llmgates_api/pi-llmgates-provider@$VERSION"
echo "  pi install -l npm:@llmgates_api/pi-llmgates-provider@$VERSION"
echo "  pi install git:github.com/ax128/pi-llmgates@v$VERSION"
echo
echo "Tag (if needed): git tag v$VERSION && git push origin v$VERSION"
