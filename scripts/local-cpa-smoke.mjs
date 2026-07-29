#!/usr/bin/env node
/**
 * Smoke test: reproduce pi cpa + claude-opus-4-8 stream against local 2API.
 * Usage: node scripts/local-cpa-smoke.mjs [--agent-dir ~/.pi/agent]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createCompatProvider } from "../extensions/compat/provider.ts";
import { decodeCompatRefreshMeta } from "../extensions/compat/storage.ts";

const agentDir = process.argv.includes("--agent-dir")
	? process.argv[process.argv.indexOf("--agent-dir") + 1]
	: join(process.env.HOME ?? "", ".pi/agent");

const auth = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"));
const registry = JSON.parse(readFileSync(join(agentDir, "llmgates/2api.json"), "utf8"));
const modelsStore = JSON.parse(readFileSync(join(agentDir, "models-store.json"), "utf8"));
const instance = registry.instances.find((i) => i.id === "cpa");
if (!instance) throw new Error("cpa instance missing in 2api.json");

const credential = auth.cpa;
if (!credential?.access) throw new Error("cpa credential missing");

const stored = modelsStore.cpa?.models?.find((m) => m.id === "claude-opus-4-8");
console.log("instance.baseUrl:", instance.baseUrl);
console.log("stored.baseUrl:", stored?.baseUrl, "api:", stored?.api);

const provider = createCompatProvider({ agentDir, instance });
const modelFromProvider = () => provider.getModels().find((m) => m.id === "claude-opus-4-8");

async function tryStream(label, model) {
	if (!model) {
		console.log(`[${label}] model not found`);
		return;
	}
	console.log(`[${label}] baseUrl=${model.baseUrl} api=${model.api}`);
	try {
		const stream = provider.streamSimple(
			model,
			{ messages: [{ role: "user", content: "回复 OK", timestamp: Date.now() }] },
			{ apiKey: credential.access, reasoning: "xhigh" },
		);
		let text = "";
		for await (const event of stream) {
			if (event.type === "text_delta") text += event.delta;
			if (event.type === "error") {
				console.log(`[${label}] stream error event:`, JSON.stringify(event));
				throw new Error(event.errorMessage ?? "stream error");
			}
		}
		const result = await stream.result();
		if (result.stopReason === "error") {
			console.log(`[${label}] result error:`, JSON.stringify(result));
			throw new Error(result.errorMessage ?? "result error");
		}
		console.log(`[${label}] OK:`, text.slice(0, 120));
	} catch (error) {
		console.log(`[${label}] FAIL:`, error instanceof Error ? error.message : String(error));
		if (error instanceof Error && error.cause) console.log(`[${label}] cause:`, error.cause);
	}
}

// 1) cold provider before refresh — uses empty/patched initial models
await tryStream("cold-getModels", modelFromProvider());

// 2) refresh from CPA /v1/models
await provider.refreshModels?.({
	credential,
	store: {
		async read() {
			return { models: modelsStore.cpa?.models ?? [], checkedAt: Date.now() };
		},
		async write() {},
	},
	allowNetwork: true,
	force: true,
});
await tryStream("after-refresh", modelFromProvider());

// 3) simulate pi prepareRequest overwriting baseUrl with auth …/v1
if (stored) {
	const piPrepared = structuredClone(stored);
	piPrepared.baseUrl = instance.baseUrl; // pi overwrites model.baseUrl from toAuth()
	await tryStream("pi-prepared-baseUrl-/v1", piPrepared);
}

console.log("refresh meta:", decodeCompatRefreshMeta(credential.refresh));
