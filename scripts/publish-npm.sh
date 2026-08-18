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

# Read the token without exporting it. check / build / pack must not see NPM_TOKEN:
# those steps execute dependency code. Only npm publish and npm view get it via a
# prefix assignment. Unset any pre-exported value so a caller who sourced .env
# first (the old handbook flow) cannot leak the token into those processes.
read_npm_token() {
	node --input-type=module -e '
		import { readFileSync } from "node:fs";
		let text;
		try {
			text = readFileSync(".env", "utf8");
		} catch {
			process.exit(2);
		}
		for (const line of text.split(/\r?\n/)) {
			const m = line.match(/^\s*NPM_TOKEN\s*=\s*(.*?)\s*$/);
			if (!m) continue;
			let value = m[1];
			if (
				(value.startsWith("\"") && value.endsWith("\"")) ||
				(value.startsWith("'\''") && value.endsWith("'\''"))
			) {
				value = value.slice(1, -1);
			}
			if (!value) process.exit(1);
			process.stdout.write(value);
			process.exit(0);
		}
		process.exit(1);
	'
}

NPM_TOKEN_VALUE="$(read_npm_token)" || {
	echo "error: NPM_TOKEN empty in .env" >&2
	exit 1
}
unset NPM_TOKEN

PASS_FILE=".gate/pre-publish-pass.json"
# What a release commit is allowed to touch after the gate ran: the version
# literals (docs/npm-package.md carries its own install examples) plus the
# release notes. Everything else — extensions/, deps, scripts, other docs —
# invalidates the gate, because the gate validated the built artifact.
# Keep this in sync with docs/pre-publish-gate.md §6 and npm-package.md §3.2.
BUMP_ALLOWED='^(package\.json|package-lock\.json|README\.md|README\.en\.md|CHANGELOG\.md|docs/npm-package\.md)$'
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
		CHANGED="$(git diff --name-only "$GATE_COMMIT" HEAD || true)"
		while IFS= read -r file; do
			[[ -z "$file" ]] && continue
			if [[ ! "$file" =~ $BUMP_ALLOWED ]]; then
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
	CHANGED="$(git diff --name-only "$GATE_COMMIT" HEAD || true)"
	while IFS= read -r file; do
		[[ -z "$file" ]] && continue
		if [[ ! "$file" =~ $BUMP_ALLOWED ]]; then
			echo "error: non-bump change since gate: $file — re-run full pre-publish gate" >&2
			exit 1
		fi
	done <<<"$CHANGED"
	PACK_OUTPUT="$(npm pack 2>&1)"
	PUBLISH_TGZ="$(echo "$PACK_OUTPUT" | tail -1)"
	# shellcheck source=lib/assert-tarball.sh
	source "$ROOT/scripts/lib/assert-tarball.sh"
	assert_publish_tarball "$PUBLISH_TGZ"
	PUBLISH_SHA256="$(sha256sum "$PUBLISH_TGZ" | awk '{print $1}')"
	echo "  publish tarball: $PUBLISH_TGZ"
	echo "  sha256: $PUBLISH_SHA256"
else
	npm pack --dry-run
fi

# `npm publish --ignore-scripts` skips prepack, so the build does NOT run at publish
# time — until now the freshness of dist/ rested entirely on a side effect of the
# npm pack above. Build explicitly and assert the entry points exist: a stale or
# missing dist/ publishes an extension that pi loads silently as a no-op, which is
# the exact failure mode README documents for `pi install git:`.
echo "==> building publish artifacts (publish runs with --ignore-scripts)"
npm run build

for entry in dist/index.js dist/tps.js; do
	if [[ ! -f "$entry" ]]; then
		echo "error: build did not produce $entry — refusing to publish" >&2
		exit 1
	fi
done

NPM_TOKEN="$NPM_TOKEN_VALUE" npm publish --access public --ignore-scripts "$@"

REMOTE="$(NPM_TOKEN="$NPM_TOKEN_VALUE" npm view @llmgates_api/pi-llmgates-provider version)"
echo "Published. registry version=$REMOTE"
echo
echo "Install examples (send to user):"
echo "  pi install npm:@llmgates_api/pi-llmgates-provider"
echo "  pi install npm:@llmgates_api/pi-llmgates-provider@$VERSION"
echo "  pi install -l npm:@llmgates_api/pi-llmgates-provider@$VERSION"
echo
echo "Tag (if needed): git tag v$VERSION && git push origin v$VERSION"
