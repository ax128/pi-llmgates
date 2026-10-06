/** Real SDK lifecycle gate. Only synthetic in-process model responses; no network/provider calls.
 * Usage: node test/runtime/usage-sdk.mjs <isolated SDK prefix> <built package root> [persist]
 * The SDK prefix must contain node_modules and a copied package under plugin/ so peer resolution
 * uses THAT runtime version, not the development worktree's SDK.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const [sdkPrefix, packageRoot, persistence] = process.argv.slice(2).map((s) => s && resolve(s));
assert(sdkPrefix && packageRoot, "SDK prefix and built package root required");
const root = mkdtempSync(join(tmpdir(), "usage-sdk-gate-"));
const cwd = join(root, "cwd"), agentDir = join(root, "agent"); mkdirSync(cwd); mkdirSync(agentDir);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.LLMGATES_TPS_PERSIST = persistence ? "1" : "0";
process.env.LLMGATES_TPS = "1";
process.env.LLMGATES_USAGE_TOOL_USAGE = "1";
const sdk = await import(pathToFileURL(join(sdkPrefix, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href);
const ai = await import(pathToFileURL(join(sdkPrefix, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
const { default: tps } = await import(pathToFileURL(join(packageRoot, "dist/tps.js")).href);
const commands = new Map(), statuses = [], errors = [], early = [];
const model = { type: "chat", id: "fixture", name: "Fixture", provider: "usage-fixture", api: "usage-fixture", baseUrl: "https://invalid.invalid", input: ["text"], reasoning: false, contextWindow: 100000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
let nextCost = 3, context;
const fixture = (pi) => {
	pi.registerProvider("usage-fixture", { apiKey: "synthetic-not-a-secret", api: "usage-fixture", models: [model], streamSimple: () => {
		const stream = ai.createAssistantMessageEventStream();
		const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [{ type: "text", text: "synthetic" }], stopReason: "stop", usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: nextCost } } };
		queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "stop", message }); stream.end(); });
		return stream;
	} });
	pi.on("session_start", (_event, ctx) => { context = ctx; });
	pi.on("message_end", (event, ctx) => {
		if (event.message.role === "assistant") early.push({ message: event.message, alreadyVisible: ctx.sessionManager.getEntries().some((e) => e.type === "message" && e.message === event.message) });
	});
	tps({ ...pi, registerCommand(name, command) { commands.set(name, command); pi.registerCommand(name, command); } });
};
const ui = { theme: { fg: (_c, s) => s }, setStatus: (_key, s) => { if (s) statuses.push(s); }, notify() {}, select: async () => undefined };
const createRuntime = async (options) => {
	const services = await sdk.createAgentSessionServices({ ...options, settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false } }), resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [fixture] } });
	return { ...(await sdk.createAgentSessionFromServices({ services, sessionManager: options.sessionManager, sessionStartEvent: options.sessionStartEvent, model, noTools: "all" })), services, diagnostics: services.diagnostics };
};
let runtime;
const wait = async (predicate) => { for (let i = 0; i < 500; i++) { if (predicate()) return; await new Promise((r) => setTimeout(r, 10)); } assert(predicate(), `gate timed out: ${statuses.at(-1)}; errors=${errors.join(";")}`); };
const bind = async (session) => { await session.bindExtensions({ uiContext: ui, mode: "tui", onError: (e) => errors.push(e.message) }); };
const all = (n) => new RegExp(`^All(?:\\(partial\\))? \\d+c\\.[~?]*\\$${n.toFixed(2)}(?:,|0,)`);
try {
	runtime = await sdk.createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager: sdk.SessionManager.create(cwd, join(root, "sessions")) });
	runtime.setRebindSession(bind); await bind(runtime.session);
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
	assert.deepEqual(errors, []);
	console.log(JSON.stringify({ version: sdk.VERSION, persist: !!persistence, newResumeForkReload: true, liveObjectAssociation: true, messageEndAlreadyVisible: early.slice(0, 2).map((e) => e.alreadyVisible), all8Then10Turn2: true }));
} finally { if (runtime) await runtime.dispose(); rmSync(root, { recursive: true, force: true }); }
