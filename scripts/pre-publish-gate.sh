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
REQUIRED_PATHS=(
	package/package.json
	package/dist/index.js
	package/dist/tps.js
	package/README.md
	package/LICENSE
)
TAR_LIST="$(mktemp)"
tar -tzf "$TGZ" >"$TAR_LIST"
for path in "${REQUIRED_PATHS[@]}"; do
	if ! grep -qx "$path" "$TAR_LIST"; then
		echo "error: $TGZ missing required path: $path" >&2
		rm -f "$TAR_LIST"
		exit 1
	fi
done
rm -f "$TAR_LIST"

SHA256="$(sha256sum "$TGZ" | awk '{print $1}')"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
mkdir -p .gate

node <<EOF
const fs = require("node:fs");
const payload = {
	schema: "pre-publish-gate/v1",
	phase: "build",
	commit: "$COMMIT",
	version: "$VERSION",
	tgz: "$TGZ",
	sha256: "$SHA256",
	built_at: "$BUILT_AT",
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
echo "  1. pi install \"./${TGZ}\""
echo "     # or project-local: pi install -l \"./${TGZ}\""
echo "  2. pi → /reload"
echo "  3. Run functional checklist in docs/pre-publish-gate.md §4"
echo "  4. ./scripts/gate-record-pass.sh --tests \"login,smoke-reload,...\""
echo "  5. Then follow docs/npm-package.md to publish"
