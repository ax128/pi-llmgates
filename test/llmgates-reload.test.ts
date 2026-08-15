import { describe, expect, it, vi } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	mergeCatalogReloadOutcomes,
	runCatalogReloadCommand,
	type CatalogReloadContext,
	type CatalogReloadTarget,
} from "../extensions/llmgates-reload.js";
import { acquireEndpointInFlight, releaseEndpointInFlight, runEndpointCommand } from "../extensions/endpoint.js";
import { runEndpointSettingCommand } from "../extensions/endpoint-setting.js";
import type { EndpointRefreshResult } from "../extensions/catalog-store.js";

const GATEWAY = "work-newapi";
const OTHER = "work-cpa";

function model(id: string, provider: string = GATEWAY): Model<Api> {
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
				{ providerId: GATEWAY, label: `gateway/${GATEWAY}`, status: "ok", modelCount: 3 },
				{ providerId: OTHER, label: "gateway/cpa", status: "ok", modelCount: 2 },
			]),
		).toEqual({
			level: "info",
			message: `Refreshed catalog for gateway/${GATEWAY} (3 model(s)), gateway/cpa (2 model(s)).`,
		});
	});

	it("reports warning when some providers fail", () => {
		const result = mergeCatalogReloadOutcomes([
			{ providerId: GATEWAY, label: `gateway/${GATEWAY}`, status: "ok", modelCount: 1 },
			{ providerId: OTHER, label: "gateway/cpa", status: "partial", detail: "offline mode" },
		]);
		expect(result.level).toBe("warning");
		expect(result.message).toContain("partial");
		expect(result.message).toContain("offline mode");
	});

	it("does not call a zero-success run partial", () => {
		const result = mergeCatalogReloadOutcomes([
			{ providerId: GATEWAY, label: `gateway/${GATEWAY}`, status: "partial", detail: "offline mode" },
			{ providerId: OTHER, label: "gateway/cpa", status: "failed", detail: "boom" },
		]);
		expect(result.level).toBe("warning");
		expect(result.message).not.toContain("partial");
		expect(result.message).toContain("did not update any provider");
	});
});

describe("runCatalogReloadCommand", () => {
	it("refreshes all targets and rebinds the current model", async () => {
		releaseEndpointInFlight();
		const refreshed = model("claude-opus-4-7", GATEWAY);
		refreshed.thinkingLevelMap = { off: "none", xhigh: "xhigh", max: "max" };
		const refresh = vi.fn(async (): Promise<EndpointRefreshResult> => okRefresh([refreshed]));
		const targets = (): CatalogReloadTarget[] => [
			{ providerId: GATEWAY, label: `gateway/${GATEWAY}`, refreshEndpointForeground: refresh },
		];
		const { ctx, notifications, setModel } = makeCtx({
			current: model("claude-opus-4-7", GATEWAY),
			findImpl: () => refreshed,
		});

		await runCatalogReloadCommand(targets, ctx);

		expect(refresh).toHaveBeenCalledOnce();
		expect(setModel).toHaveBeenCalledWith(refreshed);
		expect(notifications.at(-1)).toEqual({
			level: "info",
			message: `Refreshed catalog for gateway/${GATEWAY} (1 model(s)).`,
		});
	});

	it("rejects when another catalog command is in flight", async () => {
		expect(acquireEndpointInFlight()).toBe(true);
		const { ctx, notifications } = makeCtx();
		await runCatalogReloadCommand(
			() => [{ providerId: GATEWAY, label: `gateway/${GATEWAY}`, refreshEndpointForeground: async () => okRefresh([]) }],
			ctx,
		);
		releaseEndpointInFlight();
		expect(notifications[0]?.level).toBe("error");
		expect(notifications[0]?.message).toContain("already running");
	});

	it("does not claim partial success when no provider was updated", async () => {
		releaseEndpointInFlight();
		const { ctx, notifications } = makeCtx();
		await runCatalogReloadCommand(
			() => [
				{
					providerId: GATEWAY,
					label: `gateway/${GATEWAY}`,
					refreshEndpointForeground: async () => ({ status: "offline" }),
				},
			],
			ctx,
		);
		expect(notifications.at(-1)).toEqual({
			level: "warning",
			message: `Catalog refresh did not update any provider:\ngateway/${GATEWAY}: offline mode`,
		});
	});

	it("warns when the current model is gone from the refreshed catalog", async () => {
		releaseEndpointInFlight();
		const { ctx, notifications, setModel } = makeCtx({
			current: model("retired-model", GATEWAY),
			// The refresh succeeded but dropped this id from the catalog.
			findImpl: () => undefined,
		});

		await runCatalogReloadCommand(
			() => [
				{
					providerId: GATEWAY,
					label: `gateway/${GATEWAY}`,
					refreshEndpointForeground: async () => okRefresh([model("other", GATEWAY)]),
				},
			],
			ctx,
		);

		expect(setModel).not.toHaveBeenCalled();
		expect(notifications.at(-1)?.level).toBe("warning");
		expect(notifications.at(-1)?.message).toMatch(/no longer in the catalog/i);
	});
});

describe("catalog reload in-flight guard", () => {
	it("is refused while /endpoint holds the guard", async () => {
		releaseEndpointInFlight();
		expect(acquireEndpointInFlight()).toBe(true);
		const { ctx, notifications } = makeCtx();
		await runCatalogReloadCommand(
			() => [{ providerId: GATEWAY, label: `gateway/${GATEWAY}`, refreshEndpointForeground: async () => okRefresh([]) }],
			ctx,
		);
		releaseEndpointInFlight();
		expect(notifications[0]?.level).toBe("error");
		expect(notifications[0]?.message).toMatch(/already running/i);
	});

	it("is refused while /endpoint-setting holds the guard", async () => {
		releaseEndpointInFlight();
		expect(acquireEndpointInFlight()).toBe(true);
		const { ctx, notifications } = makeCtx();
		await runCatalogReloadCommand(
			() => [{ providerId: GATEWAY, label: `gateway/${GATEWAY}`, refreshEndpointForeground: async () => okRefresh([]) }],
			ctx,
		);
		releaseEndpointInFlight();
		expect(notifications[0]?.level).toBe("error");
		expect(notifications[0]?.message).toMatch(/catalog refresh command is already running/i);
	});

	it("refuses /endpoint-setting while reload holds the guard", async () => {
		releaseEndpointInFlight();
		expect(acquireEndpointInFlight()).toBe(true);
		const notifications: Array<{ message: string; level: string }> = [];
		await runEndpointSettingCommand(
			{
				agentDir: "/tmp/unused",
				targets: () => [
					{ providerId: GATEWAY, label: `gateway/${GATEWAY}`, scope: { kind: "2api", instanceId: GATEWAY }, refreshEndpointForeground: async () => okRefresh([]) },
				],
				writeOverrides: async () => {},
			},
			{
				mode: "tui",
				waitForIdle: async () => {},
				getModel: () => undefined,
				getAllModels: () => [],
				find: () => undefined,
				setModel: async () => true,
				notify: (message, level) => notifications.push({ message, level }),
				pick: async () => undefined,
				editor: async () => undefined,
				select: async () => undefined,
			},
		);
		releaseEndpointInFlight();
		expect(notifications[0]?.level).toBe("error");
		expect(notifications[0]?.message).toMatch(/catalog refresh command is already running/i);
	});

	it("refuses /endpoint while reload holds the guard", async () => {
		releaseEndpointInFlight();
		expect(acquireEndpointInFlight()).toBe(true);
		const notifications: Array<{ message: string; level: string }> = [];
		await runEndpointCommand(
			"messages m1",
			{
				managedProviderIds: () => [GATEWAY],
				refreshEndpointForeground: async () => ({ status: "ok", models: [] }),
				writeOverride: async () => {
					throw new Error("must not write");
				},
			},
			{
				waitForIdle: async () => {},
				getModel: () => undefined,
				modelRegistry: { find: () => undefined },
				setModel: async () => true,
				notify: (message, level) => notifications.push({ message, level }),
			},
		);
		releaseEndpointInFlight();
		expect(notifications[0]?.level).toBe("error");
		expect(notifications[0]?.message).toMatch(/already running/i);
	});
});

describe("catalog reload concurrency", () => {
	it("refreshes every target concurrently instead of serially", async () => {
		releaseEndpointInFlight();
		const { ctx, notifications } = makeCtx();

		// Concurrency is asserted structurally rather than by wall clock: every target
		// must be in flight before ANY of them is allowed to finish. Serial execution
		// deadlocks this barrier instead of merely running slower, so the test cannot
		// pass by accident on a loaded machine or fail by accident on a slow one.
		const TARGETS = ["gw-0", "gw-1", "gw-2", "gw-3"];
		let inFlightNow = 0;
		let peakConcurrency = 0;
		let releaseAll!: () => void;
		const allStarted = new Promise<void>((resolve) => {
			releaseAll = resolve;
		});
		const gatedRefresh = (label: string): CatalogReloadTarget => ({
			providerId: label,
			label,
			refreshEndpointForeground: async () => {
				inFlightNow += 1;
				peakConcurrency = Math.max(peakConcurrency, inFlightNow);
				if (inFlightNow === TARGETS.length) releaseAll();
				await allStarted;
				inFlightNow -= 1;
				return okRefresh([]);
			},
		});

		await runCatalogReloadCommand(() => TARGETS.map(gatedRefresh), ctx);

		expect(peakConcurrency).toBe(TARGETS.length);
		expect(notifications.at(-1)?.level).toBe("info");
	});

	it("keeps per-target outcomes in display order when one fails", async () => {
		releaseEndpointInFlight();
		const { ctx, notifications } = makeCtx();

		await runCatalogReloadCommand(
			() => [
				{ providerId: GATEWAY, label: `gateway/${GATEWAY}`, refreshEndpointForeground: async () => okRefresh([model("m1")]) },
				{
					providerId: OTHER,
					label: "gateway/cpa",
					refreshEndpointForeground: async () => {
						throw new Error("gateway unreachable");
					},
				},
			],
			ctx,
		);

		const message = notifications.at(-1)?.message ?? "";
		expect(notifications.at(-1)?.level).toBe("warning");
		expect(message.indexOf(`gateway/${GATEWAY}`)).toBeLessThan(message.indexOf("gateway/cpa"));
		expect(message).toMatch(/gateway unreachable/i);
	});

	it("aborts and frees the guard when the agent never settles", async () => {
		releaseEndpointInFlight();
		const { ctx, notifications } = makeCtx();
		ctx.waitForIdle = vi.fn(() => new Promise<void>(() => {}));
		ctx.idleWaitTimeoutMs = 20;
		const refresh = vi.fn(async () => okRefresh([]));

		await runCatalogReloadCommand(
			() => [{ providerId: GATEWAY, label: `gateway/${GATEWAY}`, refreshEndpointForeground: refresh }],
			ctx,
		);

		expect(refresh).not.toHaveBeenCalled();
		expect(notifications[0]).toEqual({
			message: expect.stringMatching(/still busy/i),
			level: "error",
		});
		expect(acquireEndpointInFlight()).toBe(true);
		releaseEndpointInFlight();
	});
});
