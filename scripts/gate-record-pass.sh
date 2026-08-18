#!/usr/bin/env bash
# Record Pre-publish Gate PASS after §3–§4 (docs/pre-publish-gate.md).
# Requires ./scripts/pre-publish-gate.sh to have run on the current HEAD.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BUILD_FILE=".gate/pre-publish-build.json"
if [[ ! -f "$BUILD_FILE" ]]; then
	echo "error: missing $BUILD_FILE — run ./scripts/pre-publish-gate.sh first" >&2
	exit 1
fi

TESTS=""
VERIFIED_BY="${GATE_VERIFIED_BY:-local}"
while [[ $# -gt 0 ]]; do
	case "$1" in
	--tests)
		TESTS="${2:-}"
		shift 2
		;;
	--by)
		VERIFIED_BY="${2:-}"
		shift 2
		;;
	-h | --help)
		echo "Usage: $0 [--tests \"login,smoke-reload\"] [--by \"agent+user\"]"
		exit 0
		;;
	*)
		echo "error: unknown argument: $1" >&2
		exit 1
		;;
	esac
done

if [[ -z "$TESTS" && -n "${GATE_TESTS:-}" ]]; then
	TESTS="$GATE_TESTS"
fi
if [[ -z "$TESTS" ]]; then
	echo "error: pass --tests or set GATE_TESTS (comma-separated checklist items)" >&2
	exit 1
fi

HEAD="$(git rev-parse HEAD)"
BUILD_COMMIT="$(node -p "require('./${BUILD_FILE}').commit")"
if [[ "$HEAD" != "$BUILD_COMMIT" ]]; then
	echo "error: HEAD ($HEAD) != build commit ($BUILD_COMMIT); re-run ./scripts/pre-publish-gate.sh" >&2
	exit 1
fi

VERIFIED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export GATE_BUILD_FILE="$BUILD_FILE"
export GATE_TESTS_VALUE="$TESTS"
export GATE_VERIFIED_BY_VALUE="$VERIFIED_BY"
export GATE_VERIFIED_AT="$VERIFIED_AT"
node <<'EOF'
const fs = require("node:fs");
const build = JSON.parse(fs.readFileSync(process.env.GATE_BUILD_FILE, "utf8"));
const tests = (process.env.GATE_TESTS_VALUE ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const pass = {
	schema: "pre-publish-gate/v1",
	status: "PASS",
	commit: build.commit,
	version_at_gate: build.version,
	tgz: build.tgz,
	sha256: build.sha256,
	built_at: build.built_at,
	installed: true,
	tests,
	verified_by: process.env.GATE_VERIFIED_BY_VALUE,
	verified_at: process.env.GATE_VERIFIED_AT,
};
fs.writeFileSync(".gate/pre-publish-pass.json", JSON.stringify(pass, null, 2) + "\n");
EOF

echo "Gate PASS recorded → .gate/pre-publish-pass.json"
echo "  commit: $HEAD"
echo "  tests:  $TESTS"
echo "  by:     $VERIFIED_BY"
