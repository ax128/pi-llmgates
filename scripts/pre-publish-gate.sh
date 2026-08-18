#!/usr/bin/env bash
# Automated steps of docs/pre-publish-gate.md (§2).
# Does NOT install the .tgz or run functional tests — those remain manual / agent-assisted (§3–§4).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Pre-publish gate — build step (§2)"
echo "    Full checklist: docs/pre-publish-gate.md"
echo

echo "==> npm run check"
npm run check

echo
echo "==> npm pack"
PACK_OUTPUT="$(npm pack 2>&1)"
TGZ="$(echo "$PACK_OUTPUT" | tail -1)"
if [[ ! -f "$TGZ" ]]; then
	echo "error: npm pack did not produce $TGZ" >&2
	exit 1
fi

COMMIT="$(git rev-parse HEAD)"
VERSION="$(node -p "require('./package.json').version")"

echo "==> verify tarball contents"
# shellcheck source=lib/assert-tarball.sh
source "$ROOT/scripts/lib/assert-tarball.sh"
assert_publish_tarball "$TGZ"

SHA256="$(sha256sum "$TGZ" | awk '{print $1}')"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
mkdir -p .gate

export GATE_COMMIT="$COMMIT"
export GATE_VERSION="$VERSION"
export GATE_TGZ="$TGZ"
export GATE_SHA256="$SHA256"
export GATE_BUILT_AT="$BUILT_AT"
node <<'EOF'
const fs = require("node:fs");
const payload = {
	schema: "pre-publish-gate/v1",
	phase: "build",
	commit: process.env.GATE_COMMIT,
	version: process.env.GATE_VERSION,
	tgz: process.env.GATE_TGZ,
	sha256: process.env.GATE_SHA256,
	built_at: process.env.GATE_BUILT_AT,
};
fs.writeFileSync(".gate/pre-publish-build.json", JSON.stringify(payload, null, 2) + "\n");
EOF

echo
echo "Build step: PASS"
echo "  commit:  $COMMIT"
echo "  version: $VERSION"
echo "  tarball: $TGZ"
echo "  sha256:  $SHA256"
echo "  record:  .gate/pre-publish-build.json"
echo
echo "Next (required before npm publish):"
echo "  1. Unpack and install the DIRECTORY — never 'pi install ./*.tgz', which pi"
echo "     records as a local source and then refuses to start ('Unknown file"
echo "     extension \".tgz\"'); recover with 'pi uninstall ./${TGZ}'."
echo "       pi uninstall npm:@llmgates_api/pi-llmgates-provider   # avoid loading two copies"
echo "       rm -rf /tmp/llg-pkg && mkdir -p /tmp/llg-pkg"
echo "       tar -xzf \"./${TGZ}\" -C /tmp/llg-pkg --strip-components=1"
echo "       (cd /tmp/llg-pkg && npm install --omit=dev --ignore-scripts --no-audit --no-fund)"
echo "       pi install /tmp/llg-pkg"
echo "  2. Start pi, then /reload — commands must appear unsuffixed (llmgates, not llmgates:1)"
echo "  3. Run functional checklist in docs/pre-publish-gate.md §4"
echo "  4. ./scripts/gate-record-pass.sh --tests \"login,smoke-reload,...\""
echo "  5. Then follow docs/npm-package.md to publish"
