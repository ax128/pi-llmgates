#!/usr/bin/env node
/**
 * Probe npm publish auth challenge and print the browser login URL.
 *
 * This is NOT a publish. The PUT body uses the already-published version with
 * an empty attachment and deliberately mismatched integrity, so a successful
 * 200/201 is treated as a failure (exit 1) rather than "already published".
 *
 * Usage (from repo root; script reads NPM_TOKEN from the environment or .env):
 *   node ./scripts/npm-publish-auth-link.mjs
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function npmTarballBasename(packageName, version) {
	return `${packageName.replace("@", "").replace("/", "-")}-${version}.tgz`;
}

/**
 * Build a probe payload pinned to an already-published version.
 * `versions` key, inner `version`, and `dist-tags.latest` must all be
 * `probeVersion` — never the to-be-published `manifest.version`.
 */
export function buildProbeBody(manifest, probeVersion) {
	const probeFile = npmTarballBasename(manifest.name, probeVersion);
	return {
		_id: manifest.name,
		name: manifest.name,
		description: manifest.description,
		"dist-tags": { latest: probeVersion },
		versions: {
			[probeVersion]: {
				...manifest,
				version: probeVersion,
				_id: `${manifest.name}@${probeVersion}`,
				dist: {
					tarball: `https://registry.npmjs.org/${manifest.name}/-/${probeFile}`,
					shasum: "0".repeat(40),
					integrity: `sha512-${"A".repeat(86)}==`,
				},
			},
		},
		_attachments: {
			[probeFile]: {
				content_type: "application/octet-stream",
				data: "",
				length: 0,
			},
		},
	};
}

export function isUnexpectedPublishSuccess(status) {
	return status === 200 || status === 201;
}

function loadDotEnv() {
	if (process.env.NPM_TOKEN) return;
	try {
		const text = readFileSync(".env", "utf8");
		for (const line of text.split(/\r?\n/)) {
			const m = line.match(/^\s*NPM_TOKEN\s*=\s*(.+?)\s*$/);
			if (m) {
				process.env.NPM_TOKEN = m[1].replace(/^["']|["']$/g, "");
				break;
			}
		}
	} catch {
		// ignore
	}
}

function publishedVersion(packageName) {
	try {
		return execFileSync("npm", ["view", packageName, "version"], {
			encoding: "utf8",
		}).trim();
	} catch {
		return "";
	}
}

async function main() {
	process.chdir(root);
	loadDotEnv();
	const token = process.env.NPM_TOKEN;
	if (!token) {
		console.error("error: missing NPM_TOKEN (.env or env)");
		process.exit(1);
	}

	const manifest = JSON.parse(readFileSync("package.json", "utf8"));
	const probeVersion = publishedVersion(manifest.name);
	if (!probeVersion) {
		console.error(
			"error: 无法从 registry 取到已发布版本（首次发布？网络/凭证问题？）",
		);
		console.error(
			"error: 拒绝用待发版本号做探测——那会有占用版本号的风险。",
		);
		console.error("error: 首次发布请直接走 ./scripts/publish-npm.sh。");
		process.exit(1);
	}

	const body = buildProbeBody(manifest, probeVersion);
	const putUrl = `https://registry.npmjs.org/${manifest.name.replace("/", "%2f")}`;

	const res = await fetch(putUrl, {
		method: "PUT",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			"npm-auth-type": "web",
			accept: "application/json",
			"user-agent": "pi-llmgates-auth-link/1.0",
		},
		body: JSON.stringify(body),
	});

	const notice = res.headers.get("npm-notice") || "";
	const match = notice.match(/https:\/\/www\.npmjs\.com\/[^\s]+/);
	const text = await res.text();

	if (isUnexpectedPublishSuccess(res.status)) {
		console.error("error: 探测请求被 registry 接受了——这不应该发生。");
		console.error(
			"error: 立即核对 npm 上是否出现了非预期版本，并检查 token 类型。",
		);
		console.error(`error: status=${res.status}`);
		console.error("body:", text.slice(0, 200));
		process.exit(1);
	}

	if (match) {
		console.log(match[0]);
		process.exit(0);
	}

	console.error(`error: status=${res.status}; no auth URL in npm-notice`);
	console.error("npm-notice:", notice || "(empty)");
	console.error("body:", text.slice(0, 500));
	process.exit(1);
}

const invokedDirectly =
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
	await main();
}
