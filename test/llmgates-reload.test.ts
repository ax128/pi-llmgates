import { describe, expect, it, vi } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	mergeCatalogReloadOutcomes,
	runCatalogReloadCommand,
	type CatalogReloadContext,
	type CatalogReloadTarget,
} from "../extensions/llmgates-reload.js";
import { acquireEndpointInFlight, releaseEndpointInFlight } from "../extensions/endpoint.js";
import type { EndpointRefreshResult } from "../extensions/provider.js";

const CORE = "llmgates";
const TWO_API = "work-cpa";

function model(id: string, provider: string = CORE): Model<Api> {
	return {
		id,
		name: id,
		provider,
		api: "openai-completions",
		baseUrl: "https://example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};
}

function makeCtx(opts: { current?: Model<Api>; findImpl?: (provider: string, id: string) => Model<Api> | undefined } = {}) {
	let current = opts.current;
	const setModel = vi.fn(async (m: Model<Api>) => {
		current = m;
		return true;
	});
	const notifications: Array<{ message: string; level: "info" | "warning" | "error" }> = [];
	const ctx: CatalogReloadContext = {
		waitForIdle: vi.fn(async () => {}),
		getModel: () => current,
		find: opts.findImpl ?? ((provider, id) => (current?.provider === provider && current.id === id ? current : undefined)),
		setModel,
		notify: (message, level) => notifications.push({ message, level }),
	};
	return { ctx, notifications, setModel, setCurrent: (m?: Model<Api>) => (current = m) };
}

function okRefresh(models: Model<Api>[]): EndpointRefreshResult {
	return { status: "ok", models };
}

describe("mergeCatalogReloadOutcomes", () => {
	it("reports success for all providers", () => {
		expect(
			mergeCatalogReloadOutcomes([
				{ providerId: CORE, label: "core", status: "ok", modelCount: 3 },
				{ providerId: TWO_API, label: "2API/cpa", status: "ok", modelCount: 2 },
			]),
		).toEqual({
			level: "info",
			message: "Refreshed catalog for core (3 model(s)), 2API/cpa (2 model(s)).",
		});
	});

	it("reports warning when some providers fail", () => {
		const result = mergeCatalogReloadOutcomes([
			{ providerId: CORE, label: "core", status: "ok", modelCount: 1 },
			{ providerId: TWO_API, label: "2API/cpa", status: "partial", detail: "offline mode" },
		]);
		expect(result.level).toBe("warning");
		expect(result.message).toContain("partial");
		expect(result.message).toContain("offline mode");
	});
});

describe("runCatalogReloadCommand", () => {
	it("refreshes all targets and rebinds the current model", async () => {
		releaseEndpointInFlight();
		const refreshed = model("claude-opus-4-7", CORE);
		refreshed.thinkingLevelMap = { off: "none", xhigh: "xhigh", max: "max" };
		const refresh = vi.fn(async (): Promise<EndpointRefreshResult> => okRefresh([refreshed]));
		const targets = (): CatalogReloadTarget[] => [
			{ providerId: CORE, label: "core", refreshEndpointForeground: refresh },
		];
		const { ctx, notifications, setModel } = makeCtx({
			current: model("claude-opus-4-7", CORE),
			findImpl: () => refreshed,
		});

		await runCatalogReloadCommand(targets, ctx);

		expect(refresh).toHaveBeenCalledOnce();
		expect(setModel).toHaveBeenCalledWith(refreshed);
		expect(notifications.at(-1)).toEqual({
			level: "info",
			message: "Refreshed catalog for core (1 model(s)).",
		});
	});

	it("rejects when another catalog command is in flight", async () => {
		expect(acquireEndpointInFlight()).toBe(true);
		const { ctx, notifications } = makeCtx();
		await runCatalogReloadCommand(
			() => [{ providerId: CORE, label: "core", refreshEndpointForeground: async () => okRefresh([]) }],
			ctx,
		);
		releaseEndpointInFlight();
		expect(notifications[0]?.level).toBe("error");
		expect(notifications[0]?.message).toContain("already running");
	});

	it("reports offline refresh as partial", async () => {
		releaseEndpointInFlight();
		const { ctx, notifications } = makeCtx();
		await runCatalogReloadCommand(
			() => [
				{
					providerId: CORE,
					label: "core",
					refreshEndpointForeground: async () => ({ status: "offline" }),
				},
			],
			ctx,
		);
		expect(notifications.at(-1)).toEqual({
			level: "warning",
			message: "Catalog refresh was partial:\ncore: offline mode",
		});
	});
});
