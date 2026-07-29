#!/usr/bin/env bash
# Publish @llmgates_api/pi-llmgates-provider using NPM_TOKEN from .env
# Typical agent flow:
#   1) ./scripts/pre-publish-gate.sh + gate-record-pass.sh
#   2) node ./scripts/npm-publish-auth-link.mjs   # send URL to user
#   3) ./scripts/publish-npm.sh --otp=<code>      # after user replies
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

PASS_FILE=".gate/pre-publish-pass.json"
HEAD="$(git rev-parse HEAD)"
GATE_COMMIT=""
if [[ "${GATE_SKIP:-}" == "1" ]]; then
	echo "warning: GATE_SKIP=1 — bypassing pre-publish gate (maintainer emergency only; agents must not use)" >&2
else
	if [[ ! -f "$PASS_FILE" ]]; then
		echo "error: missing $PASS_FILE — complete docs/pre-publish-gate.md §2–§4, then run ./scripts/gate-record-pass.sh" >&2
		exit 1
	fi

	GATE_COMMIT="$(node -p "require('./${PASS_FILE}').commit")"
	GATE_STATUS="$(node -p "require('./${PASS_FILE}').status")"
	if [[ "$GATE_STATUS" != "PASS" ]]; then
		echo "error: $PASS_FILE status is not PASS" >&2
		exit 1
	fi

	if [[ "$HEAD" == "$GATE_COMMIT" ]]; then
		: # gate commit is current HEAD
	elif [[ -n "$(git diff --name-only "$GATE_COMMIT" HEAD || true)" ]]; then
		ALLOWED='^(package\.json|package-lock\.json|README\.md)$'
		CHANGED="$(git diff --name-only "$GATE_COMMIT" HEAD || true)"
		while IFS= read -r file; do
			[[ -z "$file" ]] && continue
			if [[ ! "$file" =~ $ALLOWED ]]; then
				echo "error: gate commit ($GATE_COMMIT) != HEAD ($HEAD)" >&2
				echo "error: non-bump change since gate: $file — re-run full pre-publish gate" >&2
				exit 1
			fi
		done <<<"$CHANGED"
		echo "==> gate at $GATE_COMMIT, HEAD at $HEAD (bump-only changes since gate)"
	else
		echo "error: gate commit ($GATE_COMMIT) != HEAD ($HEAD)" >&2
		exit 1
	fi
fi

# Load gate commit from pass file when skipping validation (bump re-pack still needs it)
if [[ -z "$GATE_COMMIT" && -f "$PASS_FILE" ]]; then
	GATE_COMMIT="$(node -p "require('./${PASS_FILE}').commit")"
fi

VERSION="$(node -p "require('./package.json').version")"
echo "Publishing @llmgates_api/pi-llmgates-provider@$VERSION"

GATE_VERSION=""
if [[ -f "$PASS_FILE" ]]; then
	GATE_VERSION="$(node -p "require('./${PASS_FILE}').version_at_gate")"
fi

# Skip full check when only finishing an OTP publish after a prior check
if [[ "${SKIP_CHECK:-}" != "1" ]]; then
	npm run check
fi

if [[ -n "$GATE_VERSION" && "$GATE_VERSION" != "$VERSION" ]]; then
	echo "==> version bumped since gate ($GATE_VERSION → $VERSION); re-packing publish tarball"
	ALLOWED='^(package\.json|package-lock\.json|README\.md)$'
	CHANGED="$(git diff --name-only "$GATE_COMMIT" HEAD || true)"
	while IFS= read -r file; do
		[[ -z "$file" ]] && continue
		if [[ ! "$file" =~ $ALLOWED ]]; then
			echo "error: non-bump change since gate: $file — re-run full pre-publish gate" >&2
			exit 1
		fi
	done <<<"$CHANGED"
	PACK_OUTPUT="$(npm pack 2>&1)"
	PUBLISH_TGZ="$(echo "$PACK_OUTPUT" | tail -1)"
	PUBLISH_SHA256="$(sha256sum "$PUBLISH_TGZ" | awk '{print $1}')"
	echo "  publish tarball: $PUBLISH_TGZ"
	echo "  sha256: $PUBLISH_SHA256"
else
	npm pack --dry-run
fi

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
