import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { mapCompatModelsPayload } from "../extensions/compat/catalog.js";
import { createCompatProvider } from "../extensions/compat/provider.js";
import type { CompatInstance } from "../extensions/compat/types.js";
import { withTempAgentDir } from "./helpers/temp-agent-dir.js";

const INSTANCE: CompatInstance = {
	id: "work-newapi",
	name: "Work NewAPI",
	scheme: "newapi",
	baseUrl: "https://gateway.example/v1",
};

const CONTEXT: Context = {
	systemPrompt: "Test system prompt",
	messages: [{ role: "user", content: "Hello", timestamp: 1 }],
	tools: [{
		name: "test_tool",
		description: "Test-only tool",
		parameters: Type.Object({ path: Type.String() }),
	}],
};

function gatewayModel(upstream: {
	id: string;
	provider_id?: string;
	inference_endpoint?: string;
}): Model<Api> {
	return mapCompatModelsPayload([upstream], {
		providerId: INSTANCE.id,
		inferenceBaseUrl: INSTANCE.baseUrl,
	}).models[0]!;
}

async function capturePayload(
	model: Model<Api>,
	reasoning?: SimpleStreamOptions["reasoning"],
): Promise<Record<string, unknown>> {
	const { agentDir, cleanup } = withTempAgentDir();
	const transportFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(
		new Error("Unexpected network request during payload capture"),
	);
	try {
		const provider = createCompatProvider({
			agentDir,
			instance: INSTANCE,
			initialModels: [model],
		});
		let payload: Record<string, unknown> | undefined;
		const result = await provider.streamSimple(provider.getModels()[0]!, CONTEXT, {
			apiKey: "test-key",
			reasoning,
			maxTokens: 4096,
			onPayload(next) {
				payload = next as Record<string, unknown>;
				// Stop after serialization, before the upstream HTTP request.
				throw new Error("payload captured");
			},
		}).result();

		expect(result).toMatchObject({ stopReason: "error", errorMessage: "payload captured" });
		expect(transportFetch).not.toHaveBeenCalled();
		expect(payload).toBeDefined();
		return payload!;
	} finally {
		transportFetch.mockRestore();
		cleanup();
	}
}

function expectSystemRole(payload: Record<string, unknown>): void {
	expect(payload.messages).toMatchObject([
		{ role: "system", content: CONTEXT.systemPrompt },
		{ role: "user" },
	]);
}

describe("gateway-routed GLM transport", () => {
	it.each(["off", "low", "medium", "high", "xhigh", "max"] as const)(
		"uses the system role and preserves the request shape at thinking level %s",
		async (level) => {
			const payload = await capturePayload(
				gatewayModel({ id: "glm-4.7" }),
				level === "off" ? undefined : level,
			);

			expectSystemRole(payload);
			expect(payload.model).toBe("glm-4.7");
			expect(payload.max_tokens).toBe(4096);
			expect(payload).not.toHaveProperty("max_completion_tokens");
			expect(payload).not.toHaveProperty("store");
			expect(payload.tools).toHaveLength(1);
			// Gateways are not opted into the native Z.ai tool_stream extension.
			expect(payload).not.toHaveProperty("tool_stream");
			if (level === "off") {
				expect(payload.thinking).toEqual({ type: "disabled" });
				expect(payload).not.toHaveProperty("reasoning_effort");
			} else {
				expect(payload.thinking).toEqual({ type: "enabled", clear_thinking: false });
				expect(payload.reasoning_effort).toBe(level);
			}
		},
	);

	it("restores the same request shape for a serialized vendor alias without cached compat", async () => {
		const cached = JSON.parse(JSON.stringify(gatewayModel({
			id: "custom-glm",
			provider_id: " ZHIPUAI ",
		}))) as Model<Api>;
		delete cached.compat;

		const payload = await capturePayload(cached, "high");

		expectSystemRole(payload);
		expect(payload.model).toBe("custom-glm");
		expect(payload.thinking).toEqual({ type: "enabled", clear_thinking: false });
		expect(payload.reasoning_effort).toBe("high");
		expect(payload.max_tokens).toBe(4096);
		expect(payload).not.toHaveProperty("store");
	});

	it.each([
		{ id: "glm-alias", vendor: "moonshotai", thinking: { type: "enabled" }, effort: undefined },
		{ id: "deepseek-alias", vendor: "moonshotai", thinking: { type: "enabled" }, effort: undefined },
		{ id: "deepseek-alias", vendor: "zhipuai", thinking: { type: "enabled", clear_thinking: false }, effort: "high" },
	])("uses vendor $vendor transport for conflicting alias $id, fresh and cached", async ({ id, vendor, thinking, effort }) => {
		const fresh = gatewayModel({ id, provider_id: vendor });
		const cached = JSON.parse(JSON.stringify(fresh)) as Model<Api>;
		delete cached.compat;

		for (const model of [fresh, cached]) {
			const payload = await capturePayload(model, "high");
			expectSystemRole(payload);
			expect(payload.model).toBe(id);
			expect(payload.thinking).toEqual(thinking);
			if (effort === undefined) {
				expect(payload).not.toHaveProperty("reasoning_effort");
			} else {
				expect(payload.reasoning_effort).toBe(effort);
			}
		}
	});

	it("keeps the system role on a responses route without leaking completions fields", async () => {
		const payload = await capturePayload(gatewayModel({
			id: "glm-4.7",
			inference_endpoint: "responses",
		}), "high");

		expect(payload.input).toEqual(expect.arrayContaining([expect.objectContaining({ role: "system" })]));
		expect(payload.input).not.toEqual(expect.arrayContaining([expect.objectContaining({ role: "developer" })]));
		expect(payload).not.toHaveProperty("messages");
		expect(payload).not.toHaveProperty("thinking");
		expect(payload).not.toHaveProperty("max_tokens");
	});

	it("does not change the default request shape for unrelated models", async () => {
		const payload = await capturePayload(gatewayModel({ id: "gpt-4o" }), "high");

		expect(payload.messages).toMatchObject([{ role: "developer" }, { role: "user" }]);
		expect(payload.max_completion_tokens).toBe(4096);
		expect(payload).not.toHaveProperty("thinking");
	});
});
