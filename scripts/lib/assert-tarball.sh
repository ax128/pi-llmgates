#!/usr/bin/env bash
# Assert a packed npm tarball contains the files this package publishes.
# Used by pre-publish-gate.sh and by publish-npm.sh after a bump re-pack.
#
# Usage:
#   ./scripts/lib/assert-tarball.sh <file.tgz>
#   source ./scripts/lib/assert-tarball.sh && assert_publish_tarball <file.tgz>
set -euo pipefail

assert_publish_tarball() {
	local tgz="${1:-}"
	if [[ -z "$tgz" || ! -f "$tgz" ]]; then
		echo "error: tarball not found: ${tgz:-<(missing argument)}" >&2
		return 1
	fi

	local required_paths=(
		package/package.json
		package/dist/index.js
		package/dist/tps.js
		package/README.md
		package/README.en.md
		package/CHANGELOG.md
		package/LICENSE
	)
	local tar_list
	tar_list="$(mktemp)"
	if ! tar -tzf "$tgz" >"$tar_list"; then
		rm -f "$tar_list"
		echo "error: not a readable gzip tarball: $tgz" >&2
		return 1
	fi
	local path
	for path in "${required_paths[@]}"; do
		if ! grep -qx "$path" "$tar_list"; then
			echo "error: $tgz missing required path: $path" >&2
			rm -f "$tar_list"
			return 1
		fi
	done
	rm -f "$tar_list"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	assert_publish_tarball "${1:-}"
fi
