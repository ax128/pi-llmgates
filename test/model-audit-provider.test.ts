import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCompatProvider } from "../extensions/compat/provider.js";
import type { CompatInstance } from "../extensions/compat/types.js";
import {
	createModelAuditRuntime,
	modelAuditProcessStats,
	resetModelAuditProcessStats,
	type ModelAuditStreamHook,
} from "../extensions/model-audit/runtime.js";
import { MODEL_AUDIT_ROOT_ENV, readModelAuditFile } from "../extensions/model-audit/store.js";
import { startLoopbackServer } from "./helpers/loopback-server.js";
import { withTempAgentDir } from "./helpers/temp-agent-dir.js";

const INSTANCE: CompatInstance = {
	id: "work-newapi",
	name: "Work NewAPI",
	scheme: "newapi",
	baseUrl: "https://gateway.example/v1",
};

const savedEnv = {
	LLMGATES_PRICING_AUTO_UPDATE: process.env.LLMGATES_PRICING_AUTO_UPDATE,
	[MODEL_AUDIT_ROOT_ENV]: process.env[MODEL_AUDIT_ROOT_ENV],
};

beforeEach(() => {
	process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
	resetModelAuditProcessStats();
});

afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function model(id: string, baseUrl: string): Model<Api> {
	return {
		id,
		name: id,
		provider: INSTANCE.id,
		baseUrl,
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 1_024,
	};
}

function completionChunks(responseModel: string): () => AsyncIterable<Buffer> {
	return async function* () {
		const chunk = (body: unknown) => Buffer.from(`data: ${JSON.stringify(body)}\n\n`);
		yield chunk({
			id: "c1",
			object: "chat.completion.chunk",
			created: 1,
			model: responseModel,
			choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }],
		});
		yield chunk({
			id: "c1",
			object: "chat.completion.chunk",
			created: 1,
			model: responseModel,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		});
		yield Buffer.from("data: [DONE]\n\n");
	};
}

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

describe("compat provider model audit wiring", () => {
	it("hands the hook the provider id, the inference model, and the caller's options", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const seen: Array<{ providerId: string; model: { id: string; baseUrl?: string }; options: unknown }> = [];
			const hook: ModelAuditStreamHook = {
				observeStream(call) {
					seen.push({ providerId: call.providerId, model: call.model as never, options: call.options });
					return call.start(call.options);
				},
			};
			const provider = createCompatProvider({ agentDir, instance: INSTANCE, modelAudit: hook });
			const options = {
				apiKey: "k",
				onPayload() {
					throw new Error("stop before network");
				},
			};
			await provider.streamSimple(model("gpt-5", INSTANCE.baseUrl), context, options).result();
			await provider.stream(model("gpt-5", INSTANCE.baseUrl), context, options as never).result();
			expect(seen).toHaveLength(2);
			for (const entry of seen) {
				expect(entry.providerId).toBe(INSTANCE.id);
				expect(entry.model.id).toBe("gpt-5");
				expect(entry.options).toBe(options);
			}
		} finally {
			cleanup();
		}
	});

	it("records a series mismatch end to end through the real openai-completions adapter", async () => {
		const server = await startLoopbackServer([
			{
				method: "POST",
				path: "/v1/chat/completions",
				headers: { "content-type": "text/event-stream" },
				body: completionChunks("gpt-4o-mini"),
			},
		]);
		const { agentDir, cleanup } = withTempAgentDir();
		const env: NodeJS.ProcessEnv = {};
		const runtime = createModelAuditRuntime({ agentDir, env, debug: () => undefined });
		const cwd = join(agentDir, "project");
		try {
			runtime.sessionStart({ hasUI: true, mode: "tui", cwd, sessionId: "root-1" });
			runtime.beforeAgentStart();
			const provider = createCompatProvider({ agentDir, instance: INSTANCE, modelAudit: runtime });
			const message: AssistantMessage = await provider
				.streamSimple(model("gpt-5", `${server.baseUrl}/v1`), context, { apiKey: "k" })
				.result();
			expect(message.stopReason).toBe("stop");

			const historyPath = runtime.status().marker!.historyPath;
			await vi.waitFor(() => {
				const read = readModelAuditFile(historyPath);
				expect(read.status).toBe("ok");
				if (read.status !== "ok") return;
				expect(read.file.records[0]).toMatchObject({
					rootSessionId: "root-1",
					provider: INSTANCE.id,
					api: "openai-completions",
					sentModel: "gpt-5",
					responseModel: "gpt-4o-mini",
					originTurnId: runtime.status().marker!.originTurnId,
				});
				expect(read.file.roots["root-1"]).toMatchObject({ all: 1 });
			});
			// pi-ai 0.81.x never calls options.fetch, so the adapter's responseModel
			// field carries the observation; 1.6+ reads it from the response bytes.
			const counts = modelAuditProcessStats().byApi["openai-completions"];
			expect(counts.response + counts.field).toBe(1);
			expect(counts.none).toBe(0);
			await runtime.sessionShutdown();
		} finally {
			await server.close();
			cleanup();
		}
	});

	it("writes nothing for a version variant of the requested model", async () => {
		const server = await startLoopbackServer([
			{
				method: "POST",
				path: "/v1/chat/completions",
				headers: { "content-type": "text/event-stream" },
				body: completionChunks("gpt-5-2025-08-07"),
			},
		]);
		const { agentDir, cleanup } = withTempAgentDir();
		const runtime = createModelAuditRuntime({ agentDir, env: {}, debug: () => undefined });
		try {
			runtime.sessionStart({ hasUI: true, mode: "tui", cwd: join(agentDir, "p"), sessionId: "root-2" });
			const provider = createCompatProvider({ agentDir, instance: INSTANCE, modelAudit: runtime });
			const historyPath = runtime.status().marker!.historyPath;
			await provider.streamSimple(model("gpt-5", `${server.baseUrl}/v1`), context, { apiKey: "k" }).result();
			await runtime.sessionShutdown();
			const counts = modelAuditProcessStats().byApi["openai-completions"];
			expect(counts.response + counts.field).toBe(1);
			expect(readModelAuditFile(historyPath).status).toBe("missing");
		} finally {
			await server.close();
			cleanup();
		}
	});
});
