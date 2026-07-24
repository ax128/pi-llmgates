#!/usr/bin/env node
/**
 * Probe npm publish auth challenge and print the browser login URL.
 * Usage (from repo root, with .env loaded or NPM_TOKEN set):
 *   node ./scripts/npm-publish-auth-link.mjs
 */
import { readFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

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

loadDotEnv();
const token = process.env.NPM_TOKEN;
if (!token) {
	console.error("error: missing NPM_TOKEN (.env or env)");
	process.exit(1);
}

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const packOut = execFileSync("npm", ["pack", "--ignore-scripts"], { encoding: "utf8" });
const filename = packOut.trim().split(/\r?\n/).pop();
const tgz = readFileSync(filename);
const putUrl = `https://registry.npmjs.org/${manifest.name.replace("/", "%2f")}`;

const body = {
	_id: manifest.name,
	name: manifest.name,
	description: manifest.description,
	"dist-tags": { latest: manifest.version },
	versions: {
		[manifest.version]: {
			...manifest,
			_id: `${manifest.name}@${manifest.version}`,
			dist: {
				tarball: `https://registry.npmjs.org/${manifest.name}/-/${filename}`,
				shasum: createHash("sha1").update(tgz).digest("hex"),
				integrity: "sha512-" + createHash("sha512").update(tgz).digest("base64"),
			},
		},
	},
	_attachments: {
		[filename]: {
			content_type: "application/octet-stream",
			data: tgz.toString("base64"),
			length: tgz.length,
		},
	},
};

let res;
try {
	res = await fetch(putUrl, {
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
} finally {
	try {
		unlinkSync(filename);
	} catch {
		// ignore
	}
}

const notice = res.headers.get("npm-notice") || "";
const match = notice.match(/https:\/\/www\.npmjs\.com\/[^\s]+/);
const text = await res.text();

if (res.status === 200 || res.status === 201) {
	console.log("ALREADY_PUBLISHED_OR_OK");
	console.log(text.slice(0, 200));
	process.exit(0);
}

if (match) {
	console.log(match[0]);
	process.exit(0);
}

console.error(`error: status=${res.status}; no auth URL in npm-notice`);
console.error("npm-notice:", notice || "(empty)");
console.error("body:", text.slice(0, 500));
process.exit(1);
