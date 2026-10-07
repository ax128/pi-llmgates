/** Real SDK lifecycle gate. Only synthetic in-process model responses; no network/provider calls.
 * Usage: node test/runtime/usage-sdk.mjs <isolated SDK prefix> <built package root> [persist]
 * The SDK prefix must contain node_modules and a copied package under plugin/ so peer resolution
 * uses THAT runtime version, not the development worktree's SDK.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const [sdkPrefix, packageRoot, persistence] = process.argv.slice(2).map((s) => s && resolve(s));
assert(sdkPrefix && packageRoot, "SDK prefix and built package root required");
const resume = process.env.USAGE_GATE_RESUME ? JSON.parse(process.env.USAGE_GATE_RESUME) : undefined;
const root = resume?.root ?? mkdtempSync(join(tmpdir(), "usage-sdk-gate-"));
const cwd = join(root, "cwd"), agentDir = join(root, "agent");
if (!resume) { mkdirSync(cwd); mkdirSync(agentDir); }
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.LLMGATES_TPS_PERSIST = persistence ? "1" : "0";
process.env.LLMGATES_TPS = "1";
process.env.LLMGATES_TPS_TOOL_USAGE = "1";
const sdk = await import(pathToFileURL(join(sdkPrefix, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href);
const ai = await import(pathToFileURL(join(sdkPrefix, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
const { default: tps } = await import(pathToFileURL(join(packageRoot, "dist/tps.js")).href);
const commands = new Map(), statuses = [], errors = [], early = [];
const model = { type: "chat", id: "fixture", name: "Fixture", provider: "usage-fixture", api: "usage-fixture", baseUrl: "https://invalid.invalid", input: ["text"], reasoning: false, contextWindow: 100000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
let nextCost = 3, context, currentManager, nextTool, nestedMode = "normal", modelRequests = 0;
const toolEvents = [];
const usage = (cost) => ({ input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });
const fixture = (pi) => {
	pi.registerProvider("usage-fixture", { apiKey: "synthetic-not-a-secret", api: "usage-fixture", models: [model], streamSimple: () => {
		const stream = ai.createAssistantMessageEventStream(); modelRequests++;
		const tool = nextTool; nextTool = undefined;
		const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: tool ? [{ type: "toolCall", id: `fixture-tool-${modelRequests}`, name: tool, arguments: {} }] : [{ type: "text", text: "synthetic" }], stopReason: tool ? "toolUse" : "stop", usage: usage(nextCost) };
		queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason, message }); stream.end(); });
		return stream;
	} });
	if (sdk.VERSION === "1.0.4") {
		const result = (cost) => ({ content: [{ type: "text", text: "synthetic tool" }], usage: usage(cost) });
		const tool = (name, execute) => pi.registerTool({ name, label: name, description: name, parameters: { type: "object", properties: {}, additionalProperties: true }, execute });
		tool("usage_leaf", async () => result(3));
		tool("subagent_supervisor", async () => result(4));
		tool("usage_mid", async (_id, _args, _signal, _update, ctx) => { await ctx.executeTool("usage_leaf", {}); return result(2); });
		tool("usage_parent", async (_id, _args, _signal, _update, ctx) => {
			if (nestedMode === "normal") await Promise.all([ctx.executeTool("usage_mid", {}), ctx.executeTool("usage_leaf", {})]);
			else if (nestedMode === "excluded") await ctx.executeTool("subagent_supervisor", {});
			else await ctx.executeTool("usage_leaf", { padding: "x".repeat(9000) });
			return result(5);
		});
		pi.on("tool_execution_end", (event) => toolEvents.push({ id: event.toolCallId, parent: event.parentToolCallId, cost: event.result?.usage?.cost?.total }));
	}
	pi.on("session_start", (_event, ctx) => { context = ctx; });
	pi.on("message_end", (event, ctx) => {
		if (event.message.role === "assistant") early.push({ message: event.message, alreadyVisible: ctx.sessionManager.getEntries().some((e) => e.type === "message" && e.message === event.message) });
	});
	tps({ ...pi, registerCommand(name, command) { commands.set(name, command); pi.registerCommand(name, command); } });
};
const ui = { theme: { fg: (_c, s) => s }, setStatus: (_key, s) => { if (s) statuses.push(s); }, notify() {}, select: async () => undefined };
const createRuntime = async (options) => {
	currentManager = options.sessionManager;
	const services = await sdk.createAgentSessionServices({ ...options, settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false } }), resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [fixture] } });
	return { ...(await sdk.createAgentSessionFromServices({ services, sessionManager: options.sessionManager, sessionStartEvent: options.sessionStartEvent, model, noTools: sdk.VERSION === "1.0.4" ? "builtin" : "all" })), services, diagnostics: services.diagnostics };
};
let runtime;
const wait = async (predicate) => { for (let i = 0; i < 500; i++) { if (predicate()) return; await new Promise((r) => setTimeout(r, 10)); } assert(predicate(), `gate timed out: ${statuses.at(-1)}; errors=${errors.join(";")}`); };
const bind = async (session) => { await session.bindExtensions({ uiContext: ui, mode: "tui", onError: (e) => errors.push(e.message) }); };
const all = (n) => new RegExp(`^All(?:\\(partial\\))? [^,]+\\$${n.toFixed(2)}0?(?: \\+ \\?)?,`);
try {
	runtime = await sdk.createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager: resume ? sdk.SessionManager.open(resume.sessionFile, join(root, "sessions")) : sdk.SessionManager.create(cwd, join(root, "sessions")) });
	runtime.setRebindSession(bind); await bind(runtime.session);
	if (resume) {
		await wait(() => all(resume.expected).test(statuses.at(-1)));
		assert.equal(modelRequests, 0);
		assert.deepEqual(errors, []);
		assert.match(statuses.at(-1), /Turn 0s\.0c\.\$0\.000/);
		console.log(JSON.stringify({ version: sdk.VERSION, coldProcessRestore: true, expected: resume.expected }));
	} else {
	await runtime.session.prompt("fixture first"); await wait(() => all(3).test(statuses.at(-1)));
	nextCost = 5; await runtime.session.prompt("fixture second"); await wait(() => all(8).test(statuses.at(-1)));
	assert.match(statuses.at(-1), /Turn \d+s\.1c\.[~?]*\$5\.00/);
	assert.equal(early.length, 2);
	for (const e of early) assert(context.sessionManager.getEntries().some((entry) => entry.type === "message" && entry.message === e.message), "SDK must expose the same live assistant object for proven association");
	const sessionFile = runtime.session.sessionFile;
	assert(sessionFile);
	await runtime.session.reload(); await wait(() => all(8).test(statuses.at(-1)));
	nextCost = 2; await runtime.session.prompt("after reload"); await wait(() => all(10).test(statuses.at(-1)));
	assert.match(statuses.at(-1), /Turn \d+s\.1c\.[~?]*\$2\.00/);
	await runtime.newSession(); await wait(() => !all(10).test(statuses.at(-1)));
	await runtime.switchSession(sessionFile); await wait(() => all(10).test(statuses.at(-1)));
	const forkPoint = context.sessionManager.getEntries().find((e) => e.type === "message" && e.message.role === "assistant");
	assert(forkPoint); await runtime.fork(forkPoint.id, { position: "at" }); await wait(() => all(3).test(statuses.at(-1)));
	assert.notEqual(runtime.session.sessionFile, sessionFile);
	if (sdk.VERSION === "1.0.4") {
		nextCost = 1; nextTool = "usage_parent";
		await runtime.session.prompt("nested synthetic"); await wait(() => all(18).test(statuses.at(-1)));
		const pooled = context.sessionManager.getEntries().findLast((e) => e.type === "message" && e.message.role === "toolResult");
		assert.equal(pooled.message.usage.cost.total, 13); // nested 3+2+3, parent self 5
		assert.equal(pooled.message.nestedCalls.complete, true);
		assert.equal(pooled.message.nestedCalls.calls.length, 3);
		assert.equal(toolEvents.findLast((e) => !e.parent).cost, 5); // end event is NOT pooled
		assert.equal(toolEvents.filter((e) => e.parent).length, 3);
		for (const [mode, expected] of [["excluded", 20], ["truncated", 22]]) {
			nestedMode = mode; nextTool = "usage_parent";
			await runtime.session.prompt(`nested ${mode}`); await wait(() => all(expected).test(statuses.at(-1)));
		}
		const truncated = context.sessionManager.getEntries().findLast((e) => e.type === "message" && e.message.role === "toolResult");
		assert.equal(truncated.message.nestedCalls.complete, false);
		const turn = statuses.at(-1).split(", Turn")[1];
		const calls = /^All(?:\(partial\))? ([^.]+)\./.exec(statuses.at(-1))[1];
		const requestsBeforeIdle = modelRequests;
		currentManager.appendUsage("cache_warm", "usage-fixture", "fixture", usage(0.25));
		await wait(() => all(22.25).test(statuses.at(-1)));
		currentManager.appendUsage("future-valid-kind", "usage-fixture", "fixture", usage(0.5));
		await wait(() => all(22.75).test(statuses.at(-1)));
		assert.equal(statuses.at(-1).split(", Turn")[1], turn);
		assert.equal(/^All(?:\(partial\))? ([^.]+)\./.exec(statuses.at(-1))[1], calls);
		assert.equal(modelRequests, requestsBeforeIdle);
		await runtime.session.reload(); await wait(() => all(22.75).test(statuses.at(-1)));
	}
	const finalSessionFile = runtime.session.sessionFile;
	await runtime.dispose(); runtime = undefined;
	const child = spawnSync(process.execPath, [process.argv[1], sdkPrefix, packageRoot, ...(persistence ? ["persist"] : [])], { encoding: "utf8", env: { ...process.env, USAGE_GATE_RESUME: JSON.stringify({ root, sessionFile: finalSessionFile, expected: sdk.VERSION === "1.0.4" ? 22.75 : 3 }) }, timeout: 20000 });
	assert.equal(child.status, 0, child.stderr);
	assert.match(child.stdout, /"coldProcessRestore":true/);
	assert.deepEqual(errors, []);
	console.log(JSON.stringify({ version: sdk.VERSION, coldProcessRestore: true, persist: !!persistence, newResumeForkReload: true, liveObjectAssociation: true, messageEndAlreadyVisible: early.slice(0, 2).map((e) => e.alreadyVisible), all8Then10Turn2: true, ...(sdk.VERSION === "1.0.4" ? { nestedPooledOnce: true, excludedAndTruncatedFailClosed: true, idleUsageWithoutTurnOrCalls: true } : {}) }));
	}
} finally { if (runtime) await runtime.dispose(); if (!resume) rmSync(root, { recursive: true, force: true }); }
