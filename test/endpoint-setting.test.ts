import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	buildSelectorSnapshot,
	createInteractionCancellation,
	runEndpointSettingCommand,
	type EndpointSettingContext,
	type EndpointSettingRuntime,
	type EndpointSettingTarget,
} from "../extensions/endpoint-setting.js";
import {
	acquireEndpointInFlight,
	releaseEndpointInFlight,
	runEndpointCommand,
} from "../extensions/endpoint.js";
import {
	readModelOverridesFile,
	writeModelOverrides,
	type ModelOverrideWrite,
	type OverrideScope,
} from "../extensions/model-overrides.js";
import {
	parseSelectorList,
	SELECTOR_ENDPOINT_OPTIONS,
	type SelectorSelection,
	type SelectorSnapshot,
} from "../extensions/endpoint-selector.js";
import type { EndpointRefreshResult } from "../extensions/provider.js";
import { runCatalogReloadCommand } from "../extensions/llmgates-reload.js";

const CORE = "llmgates";
const TWO_API = "cpa";
/** Step-2 label for `messages`, straight from SELECTOR_ENDPOINT_OPTIONS. */
const MESSAGES_CHOICE = SELECTOR_ENDPOINT_OPTIONS.find(
	(option) => option.choice === "messages",
)!.label;

afterEach(() => {
	releaseEndpointInFlight();
});

function model(id: string, api: Api, provider = CORE, name = id): Model<Api> {
	return {
		id,
		name,
		provider,
		api,
		baseUrl: "https://example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};
}

function tempDir(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "llmgates-setting-"));
	mkdirSync(join(dir, "llmgates"), { recursive: true, mode: 0o700 });
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

interface TargetSpec {
	providerId: string;
	scope: OverrideScope;
	label?: string;
	refresh?: EndpointRefreshResult | (() => Promise<EndpointRefreshResult>);
}

interface HarnessOptions {
	agentDir: string;
	targets: TargetSpec[];
	/** Registry contents AFTER the refresh (what verification observes). */
	registry: Model<Api>[];
	/** Registry contents before any refresh; defaults to `registry`. */
	initialRegistry?: Model<Api>[];
	current?: Model<Api>;
	mode?: string;
	/**
	 * What the tui checkbox picker returns. Defaults to parsing `editor` against
	 * the snapshot the picker was handed, so one fixture drives both step-1
	 * surfaces.
	 */
	pick?:
		| SelectorSelection[]
		| undefined
		| (() => Promise<SelectorSelection[] | undefined>);
	editor?: string | undefined | (() => Promise<string | undefined>);
	select?: string | undefined;
	setModelImpl?: (model: Model<Api>) => Promise<boolean>;
	writeImpl?: (
		scope: OverrideScope,
		writes: ReadonlyArray<{ targetId: string; write: ModelOverrideWrite }>,
	) => Promise<void>;
}

function harness(options: HarnessOptions) {
	let registry = options.initialRegistry ?? options.registry;
	let current = options.current;
	const notifications: Array<{ message: string; level: string }> = [];
	const writeCalls: Array<{
		scope: OverrideScope;
		writes: ReadonlyArray<{ targetId: string; write: ModelOverrideWrite }>;
	}> = [];
	const order: string[] = [];
	let editorPrefill = "";
	let editorCalls = 0;

	const refreshCalls: string[] = [];
	const targets: EndpointSettingTarget[] = options.targets.map((spec) => ({
		providerId: spec.providerId,
		label: spec.label ?? spec.providerId,
		scope: spec.scope,
		refreshEndpointForeground: async () => {
			order.push(`refresh:${spec.providerId}`);
			refreshCalls.push(spec.providerId);
			// A successful refresh is what makes the post-change registry visible.
			registry = options.registry;
			const refresh = spec.refresh ?? {
				status: "ok",
				models: options.registry,
			};
			return typeof refresh === "function" ? refresh() : refresh;
		},
	}));

	const setModel = vi.fn(async (next: Model<Api>) => {
		if (options.setModelImpl) return options.setModelImpl(next);
		current = next;
		return true;
	});

	const runtime: EndpointSettingRuntime = {
		agentDir: options.agentDir,
		targets: () => targets,
		writeOverrides: async (scope, writes) => {
			order.push(`write:${scope.kind === "core" ? "core" : scope.instanceId}`);
			writeCalls.push({ scope, writes });
			if (options.writeImpl) return options.writeImpl(scope, writes);
			await writeModelOverrides(options.agentDir, scope, writes);
		},
	};

	const ctx: EndpointSettingContext = {
		mode: options.mode ?? "tui",
		waitForIdle: vi.fn(async () => {}),
		getModel: () => current,
		getAllModels: () => registry,
		find: (providerId, modelId) =>
			registry.find(
				(entry) => entry.provider === providerId && entry.id === modelId,
			),
		setModel,
		pick: async (snapshot) => {
			if ("pick" in options) {
				const value = options.pick;
				return typeof value === "function" ? value() : value;
			}
			const value = options.editor;
			const text = typeof value === "function" ? await value() : value;
			return text === undefined
				? undefined
				: parseSelectorList(text, snapshot).selected;
		},
		editor: async (_title, prefill) => {
			editorCalls += 1;
			editorPrefill = prefill;
			const value = options.editor;
			return typeof value === "function" ? value() : value;
		},
		select: async () => options.select,
		notify: (message, level) => notifications.push({ message, level }),
	};

	return {
		runtime,
		ctx,
		notifications,
		writeCalls,
		refreshCalls,
		order,
		setModel,
		prefill: () => editorPrefill,
		editorCalls: () => editorCalls,
	};
}

/** Check every model in the checklist body, leaving comments untouched. */
function checkAll(text: string): string {
	return text.replace(/^\[ ]/gm, "[x]");
}

describe("buildSelectorSnapshot", () => {
	it("groups managed providers and summarizes everything else", () => {
		const targets: EndpointSettingTarget[] = [
			{
				providerId: CORE,
				label: "core",
				scope: { kind: "core" },
				refreshEndpointForeground: async () => ({ status: "not-ready" }),
			},
			{
				providerId: TWO_API,
				label: "gateway/cpa",
				scope: { kind: "2api", instanceId: TWO_API },
				refreshEndpointForeground: async () => ({ status: "not-ready" }),
			},
		];
		const snapshot = buildSelectorSnapshot(
			targets,
			[
				model("core-a", "openai-completions"),
				model("core-b", "anthropic-messages"),
				model("cpa-a", "openai-completions", TWO_API),
				model("x1", "openai-responses", "openai"),
				model("x2", "openai-responses", "openai"),
				model("y1", "openai-responses", "cc"),
			],
			(target, modelId) => target.providerId === CORE && modelId === "core-b",
		);

		expect(snapshot.groups.map((group) => group.providerId)).toEqual([
			CORE,
			TWO_API,
		]);
		expect(snapshot.groups[0]!.models).toEqual([
			{ id: "core-a", name: "core-a", endpoint: "chat", hasOverride: false },
			{ id: "core-b", name: "core-b", endpoint: "messages", hasOverride: true },
		]);
		expect(snapshot.unmanaged).toEqual({
			total: 3,
			byProvider: [
				{ providerId: "openai", count: 2 },
				{ providerId: "cc", count: 1 },
			],
		});
	});

	it("omits a managed provider that currently has no models", () => {
		const snapshot = buildSelectorSnapshot(
			[
				{
					providerId: CORE,
					label: "core",
					scope: { kind: "core" },
					refreshEndpointForeground: async () => ({ status: "not-ready" }),
				},
			],
			[],
			() => false,
		);
		expect(snapshot.groups).toEqual([]);
	});
});

describe("/endpoint-setting override marker", () => {
	/** Intercept step 1 to keep the snapshot the picker was handed. */
	function captureSnapshot(h: ReturnType<typeof harness>) {
		let captured: SelectorSnapshot | undefined;
		const pick = h.ctx.pick;
		h.ctx.pick = async (snapshot) => {
			captured = snapshot;
			return pick(snapshot);
		};
		return () => captured;
	}

	it("marks only per-model entries, never rows that just inherit defaults.endpoint", async () => {
		const { dir, cleanup } = tempDir();
		try {
			writeFileSync(
				join(dir, "llmgates/models.json"),
				JSON.stringify({
					defaults: { endpoint: "responses" },
					models: { m2: { endpoint: "messages" } },
				}),
			);
			const h = harness({
				agentDir: dir,
				targets: [{ providerId: CORE, scope: { kind: "core" } }],
				registry: [
					model("m1", "openai-responses"),
					model("m2", "anthropic-messages"),
				],
				// Cancelling at step 1 is enough: the snapshot is what this asserts.
				pick: undefined,
			});
			const snapshot = captureSnapshot(h);

			await runEndpointSettingCommand(h.runtime, h.ctx);

			expect(snapshot()?.groups[0]?.models).toEqual([
				{ id: "m1", name: "m1", endpoint: "responses", hasOverride: false },
				{ id: "m2", name: "m2", endpoint: "messages", hasOverride: true },
			]);
		} finally {
			cleanup();
		}
	});

	it("reads each target's own override file", async () => {
		const { dir, cleanup } = tempDir();
		try {
			writeFileSync(
				join(dir, "llmgates/models.json"),
				JSON.stringify({ models: { m1: { endpoint: "messages" } } }),
			);
			mkdirSync(join(dir, "llmgates/2api-models"), {
				recursive: true,
				mode: 0o700,
			});
			writeFileSync(
				join(dir, `llmgates/2api-models/${TWO_API}.json`),
				JSON.stringify({ models: { x1: { endpoint: "responses" } } }),
			);
			const h = harness({
				agentDir: dir,
				targets: [
					{ providerId: CORE, scope: { kind: "core" } },
					{ providerId: TWO_API, scope: { kind: "2api", instanceId: TWO_API } },
				],
				registry: [
					model("m1", "anthropic-messages"),
					model("x1", "openai-responses", TWO_API),
					model("x2", "openai-completions", TWO_API),
				],
				pick: undefined,
			});
			const snapshot = captureSnapshot(h);

			await runEndpointSettingCommand(h.runtime, h.ctx);

			expect(
				snapshot()?.groups.map((group) =>
					group.models.map((entry) => [entry.id, entry.hasOverride]),
				),
			).toEqual([
				[["m1", true]],
				[
					["x1", true],
					["x2", false],
				],
			]);
		} finally {
			cleanup();
		}
	});
});

describe("/endpoint-setting mode guard", () => {
	it.each(["print", "json"])(
		"refuses in %s mode and points at /endpoint",
		async (mode) => {
			const { dir, cleanup } = tempDir();
			try {
				const h = harness({
					agentDir: dir,
					mode,
					targets: [{ providerId: CORE, scope: { kind: "core" } }],
					registry: [model("m1", "openai-completions")],
					editor: "[x] m1",
					select: "messages   → anthropic-messages",
				});

				await runEndpointSettingCommand(h.runtime, h.ctx);

				expect(h.notifications).toEqual([
					{ message: expect.stringMatching(/\/endpoint </), level: "error" },
				]);
				expect(h.writeCalls).toEqual([]);
				expect(existsSync(join(dir, "llmgates/models.json"))).toBe(false);
			} finally {
				cleanup();
			}
		},
	);

	it.each(["tui", "rpc"])("runs normally in %s mode", async (mode) => {
		const { dir, cleanup } = tempDir();
		try {
			const h = harness({
				agentDir: dir,
				mode,
				targets: [{ providerId: CORE, scope: { kind: "core" } }],
				registry: [model("m1", "anthropic-messages")],
				initialRegistry: [model("m1", "openai-completions")],
				editor: "[x] m1",
				select: "messages   → anthropic-messages",
			});

			await runEndpointSettingCommand(h.runtime, h.ctx);

			expect(h.notifications[0]?.level).toBe("info");
			expect(readModelOverridesFile(dir)?.models?.m1?.endpoint).toBe(
				"messages",
			);
		} finally {
			cleanup();
		}
	});

	it("uses the checkbox picker in tui mode and the editor checklist in rpc mode", async () => {
		const { dir, cleanup } = tempDir();
		try {
			for (const [mode, expectedEditorCalls] of [
				["tui", 0],
				["rpc", 1],
			] as const) {
				const h = harness({
					agentDir: dir,
					mode,
					targets: [{ providerId: CORE, scope: { kind: "core" } }],
					registry: [model("m1", "anthropic-messages")],
					initialRegistry: [model("m1", "openai-completions")],
					editor: "[x] m1",
					select: "messages   → anthropic-messages",
				});

				await runEndpointSettingCommand(h.runtime, h.ctx);

				expect(h.editorCalls()).toBe(expectedEditorCalls);
				expect(h.writeCalls).toHaveLength(1);
			}
		} finally {
			cleanup();
		}
	});
});

describe("/endpoint-setting cancellation", () => {
	it.each([
		[
			"step 1 cancelled",
			{ editor: undefined, select: "messages   → anthropic-messages" },
		],
		[
			"nothing selected",
			{ editor: "[ ] m1", select: "messages   → anthropic-messages" },
		],
		["step 2 cancelled", { editor: "[x] m1", select: undefined }],
	])("writes nothing when %s", async (_label, overrides) => {
		const { dir, cleanup } = tempDir();
		const piModels = join(dir, "models.json");
		writeFileSync(piModels, JSON.stringify({ providers: {} }));
		const before = statSync(piModels).mtimeMs;
		try {
			const h = harness({
				agentDir: dir,
				targets: [{ providerId: CORE, scope: { kind: "core" } }],
				registry: [model("m1", "openai-completions")],
				...overrides,
			});

			await runEndpointSettingCommand(h.runtime, h.ctx);

			expect(h.notifications).toEqual([
				{ message: expect.stringMatching(/cancelled/i), level: "info" },
			]);
			expect(h.writeCalls).toEqual([]);
			expect(h.refreshCalls).toEqual([]);
			expect(existsSync(join(dir, "llmgates/models.json"))).toBe(false);
			expect(statSync(piModels).mtimeMs).toBe(before);
		} finally {
			cleanup();
		}
	});
});

describe("/endpoint-setting batch write", () => {
	it("writes each provider once with all its models, and refreshes once", async () => {
		const { dir, cleanup } = tempDir();
		try {
			const after = [
				model("c1", "anthropic-messages"),
				model("c2", "anthropic-messages"),
				model("p1", "anthropic-messages", TWO_API),
			];
			const h = harness({
				agentDir: dir,
				targets: [
					{ providerId: CORE, scope: { kind: "core" } },
					{ providerId: TWO_API, scope: { kind: "2api", instanceId: TWO_API } },
				],
				registry: after,
				initialRegistry: [
					model("c1", "openai-completions"),
					model("c2", "openai-completions"),
					model("p1", "openai-completions", TWO_API),
				],
				editor: "[x] c1\n[x] c2\n[x] p1",
				select: "messages   → anthropic-messages",
			});

			await runEndpointSettingCommand(h.runtime, h.ctx);

			expect(h.writeCalls).toHaveLength(2);
			expect(h.writeCalls[0]!.scope).toEqual({ kind: "core" });
			expect(h.writeCalls[0]!.writes.map((entry) => entry.targetId)).toEqual([
				"c1",
				"c2",
			]);
			expect(h.writeCalls[1]!.scope).toEqual({
				kind: "2api",
				instanceId: TWO_API,
			});
			expect(h.writeCalls[1]!.writes.map((entry) => entry.targetId)).toEqual([
				"p1",
			]);
			expect(h.refreshCalls).toEqual([CORE, TWO_API]);
			expect(h.notifications).toEqual([
				{ message: expect.stringMatching(/3 model/), level: "info" },
			]);
		} finally {
			cleanup();
		}
	});

	it("serializes groups: a provider's write and refresh both finish before the next starts", async () => {
		const { dir, cleanup } = tempDir();
		try {
			const h = harness({
				agentDir: dir,
				targets: [
					{ providerId: CORE, scope: { kind: "core" } },
					{ providerId: TWO_API, scope: { kind: "2api", instanceId: TWO_API } },
				],
				registry: [
					model("c1", "anthropic-messages"),
					model("p1", "anthropic-messages", TWO_API),
				],
				editor: "[x] c1\n[x] p1",
				select: "messages   → anthropic-messages",
			});

			await runEndpointSettingCommand(h.runtime, h.ctx);

			// No interleaving: core's lock is released before the 2API lock is taken.
			expect(h.order).toEqual([
				"write:core",
				"refresh:llmgates",
				"write:cpa",
				"refresh:cpa",
			]);
		} finally {
			cleanup();
		}
	});

	it("keeps each provider's overrides in its own file", async () => {
		const { dir, cleanup } = tempDir();
		try {
			const h = harness({
				agentDir: dir,
				targets: [
					{ providerId: CORE, scope: { kind: "core" } },
					{ providerId: TWO_API, scope: { kind: "2api", instanceId: TWO_API } },
				],
				registry: [
					model("c1", "anthropic-messages"),
					model("p1", "anthropic-messages", TWO_API),
				],
				editor: "[x] c1\n[x] p1",
				select: "messages   → anthropic-messages",
			});

			await runEndpointSettingCommand(h.runtime, h.ctx);

			expect(readModelOverridesFile(dir)?.models).toEqual({
				c1: { endpoint: "messages" },
			});
			expect(
				readModelOverridesFile(dir, { kind: "2api", instanceId: TWO_API })
					?.models,
			).toEqual({ p1: { endpoint: "messages" } });
		} finally {
			cleanup();
		}
	});

	it("routes a model id shared by two providers to each provider's own file", async () => {
		const { dir, cleanup } = tempDir();
		try {
			let prefill = "";
			const h = harness({
				agentDir: dir,
				// The editor checklist (rpc) is where an id can be ambiguous at all; the
				// tui picker carries the provider on every row.
				mode: "rpc",
				targets: [
					{ providerId: CORE, label: "core", scope: { kind: "core" } },
					{
						providerId: TWO_API,
						label: "gateway/cpa",
						scope: { kind: "2api", instanceId: TWO_API },
					},
				],
				// A 2API relay re-exporting the same upstream id core already serves: the
				// two rendered rows are visually identical, so only the group header can
				// disambiguate them. Both must be reachable and land in separate files.
				registry: [
					model("shared", "anthropic-messages"),
					model("shared", "anthropic-messages", TWO_API),
				],
				initialRegistry: [
					model("shared", "openai-completions"),
					model("shared", "openai-completions", TWO_API),
				],
				editor: () => Promise.resolve(checkAll(prefill)),
				select: "messages   → anthropic-messages",
			});
			const originalEditor = h.ctx.editor;
			h.ctx.editor = async (title, text) => {
				prefill = text;
				return originalEditor(title, text);
			};

			await runEndpointSettingCommand(h.runtime, h.ctx);

			expect(h.notifications[0]?.level).toBe("info");
			expect(h.writeCalls.map((call) => call.scope)).toEqual([
				{ kind: "core" },
				{ kind: "2api", instanceId: TWO_API },
			]);
			expect(readModelOverridesFile(dir)?.models?.shared?.endpoint).toBe(
				"messages",
			);
			expect(
				readModelOverridesFile(dir, { kind: "2api", instanceId: TWO_API })
					?.models?.shared?.endpoint,
			).toBe("messages");
		} finally {
			cleanup();
		}
	});

	it("clears overrides for auto and verifies against the refreshed api", async () => {
		const { dir, cleanup } = tempDir();
		try {
			await writeModelOverrides(dir, { kind: "core" }, [
				{ targetId: "m1", write: { kind: "set", endpoint: "messages" } },
			]);
			const h = harness({
				agentDir: dir,
				targets: [{ providerId: CORE, scope: { kind: "core" } }],
				// `auto` cannot know the resulting api in advance; it must match
				// whatever this refresh produced.
				registry: [model("m1", "openai-responses")],
				initialRegistry: [model("m1", "anthropic-messages")],
				editor: "[x] m1",
				select: "auto       → 清除 override，回落默认",
			});

			await runEndpointSettingCommand(h.runtime, h.ctx);

			expect(h.notifications[0]?.level).toBe("info");
			expect(readModelOverridesFile(dir)?.models?.m1).toBeUndefined();
		} finally {
			cleanup();
		}
	});
});

describe("/endpoint-setting tri-state", () => {
	async function runWith(
		options: Partial<HarnessOptions> & {
			agentDir: string;
			targets: TargetSpec[];
		},
	) {
		const h = harness({
			registry: [model("m1", "anthropic-messages")],
			initialRegistry: [model("m1", "openai-completions")],
			editor: "[x] m1",
			select: "messages   → anthropic-messages",
			...options,
		});
		await runEndpointSettingCommand(h.runtime, h.ctx);
		return h;
	}

	it.each([
		["offline", { status: "offline" } as const, /offline/i],
		["not-ready", { status: "not-ready" } as const, /not ready/i],
		["superseded", { status: "superseded" } as const, /superseded/i],
	])(
		"reports partial when the refresh is %s",
		async (_label, refresh, pattern) => {
			const { dir, cleanup } = tempDir();
			try {
				const h = await runWith({
					agentDir: dir,
					targets: [{ providerId: CORE, scope: { kind: "core" }, refresh }],
				});

				expect(h.notifications).toEqual([
					{ message: expect.stringMatching(pattern), level: "warning" },
				]);
				// The file was still written: partial, never ok, never failed.
				expect(readModelOverridesFile(dir)?.models?.m1?.endpoint).toBe(
					"messages",
				);
			} finally {
				cleanup();
			}
		},
	);

	it("reports partial when the refresh throws", async () => {
		const { dir, cleanup } = tempDir();
		try {
			const h = await runWith({
				agentDir: dir,
				targets: [
					{
						providerId: CORE,
						scope: { kind: "core" },
						refresh: async () => {
							throw new Error("network down");
						},
					},
				],
			});

			expect(h.notifications).toEqual([
				{ message: expect.stringMatching(/network down/), level: "warning" },
			]);
			expect(readModelOverridesFile(dir)?.models?.m1?.endpoint).toBe(
				"messages",
			);
		} finally {
			cleanup();
		}
	});

	it("reports partial and names the models whose api did not take effect", async () => {
		const { dir, cleanup } = tempDir();
		try {
			const h = await runWith({
				agentDir: dir,
				targets: [{ providerId: CORE, scope: { kind: "core" } }],
				// m2 stayed on the old api after the refresh.
				registry: [
					model("m1", "anthropic-messages"),
					model("m2", "openai-completions"),
				],
				initialRegistry: [
					model("m1", "openai-completions"),
					model("m2", "openai-completions"),
				],
				editor: "[x] m1\n[x] m2",
			});

			expect(h.notifications[0]?.level).toBe("warning");
			expect(h.notifications[0]?.message).toMatch(/m2/);
			expect(h.notifications[0]?.message).not.toMatch(/\bm1\b/);
		} finally {
			cleanup();
		}
	});

	it.each([
		["setModel returns false", async () => false],
		[
			"setModel throws",
			async () => {
				throw new Error("rebind exploded");
			},
		],
	])(
		"reports partial when %s for the current model",
		async (_label, setModelImpl) => {
			const { dir, cleanup } = tempDir();
			try {
				const h = await runWith({
					agentDir: dir,
					targets: [{ providerId: CORE, scope: { kind: "core" } }],
					current: model("m1", "openai-completions"),
					setModelImpl: setModelImpl as (model: Model<Api>) => Promise<boolean>,
				});

				expect(h.notifications).toEqual([
					{ message: expect.stringMatching(/\/model/), level: "warning" },
				]);
			} finally {
				cleanup();
			}
		},
	);

	it("rebinds the current model when it is part of the selection", async () => {
		const { dir, cleanup } = tempDir();
		try {
			const h = await runWith({
				agentDir: dir,
				targets: [{ providerId: CORE, scope: { kind: "core" } }],
				current: model("m1", "openai-completions"),
			});

			expect(h.setModel).toHaveBeenCalledTimes(1);
			expect(h.setModel.mock.calls[0]![0].api).toBe("anthropic-messages");
			expect(h.notifications[0]?.level).toBe("info");
		} finally {
			cleanup();
		}
	});

	it("does not touch the current model when it is not in the selection", async () => {
		const { dir, cleanup } = tempDir();
		try {
			const h = await runWith({
				agentDir: dir,
				targets: [{ providerId: CORE, scope: { kind: "core" } }],
				current: model("other", "openai-completions"),
			});

			expect(h.setModel).not.toHaveBeenCalled();
			expect(h.notifications[0]?.level).toBe("info");
		} finally {
			cleanup();
		}
	});

	it("is partial when one provider's write fails and another succeeds", async () => {
		const { dir, cleanup } = tempDir();
		try {
			const h = await runWith({
				agentDir: dir,
				targets: [
					{ providerId: CORE, scope: { kind: "core" } },
					{ providerId: TWO_API, scope: { kind: "2api", instanceId: TWO_API } },
				],
				registry: [
					model("c1", "anthropic-messages"),
					model("p1", "anthropic-messages", TWO_API),
				],
				initialRegistry: [
					model("c1", "openai-completions"),
					model("p1", "openai-completions", TWO_API),
				],
				editor: "[x] c1\n[x] p1",
				writeImpl: async (scope, writes) => {
					if (scope.kind === "2api") throw new Error("disk full");
					await writeModelOverrides(dir, scope, writes);
				},
			});

			expect(h.notifications).toHaveLength(1);
			expect(h.notifications[0]?.level).toBe("warning");
			// Each provider's state is spelled out; the successful half stays applied.
			expect(h.notifications[0]?.message).toMatch(/llmgates.*applied/s);
			expect(h.notifications[0]?.message).toMatch(/cpa.*disk full/s);
			expect(readModelOverridesFile(dir)?.models?.c1?.endpoint).toBe(
				"messages",
			);
		} finally {
			cleanup();
		}
	});

	it("is failed only when every provider's write fails", async () => {
		const { dir, cleanup } = tempDir();
		try {
			const h = await runWith({
				agentDir: dir,
				targets: [
					{ providerId: CORE, scope: { kind: "core" } },
					{ providerId: TWO_API, scope: { kind: "2api", instanceId: TWO_API } },
				],
				registry: [
					model("c1", "anthropic-messages"),
					model("p1", "anthropic-messages", TWO_API),
				],
				initialRegistry: [
					model("c1", "openai-completions"),
					model("p1", "openai-completions", TWO_API),
				],
				editor: "[x] c1\n[x] p1",
				writeImpl: async () => {
					throw new Error("disk full");
				},
			});

			expect(h.notifications).toEqual([
				{ message: expect.stringMatching(/failed/i), level: "error" },
			]);
			expect(h.refreshCalls).toEqual([]);
			expect(existsSync(join(dir, "llmgates/models.json"))).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("never leaks an unexpected error as an unhandled rejection", async () => {
		const { dir, cleanup } = tempDir();
		try {
			const h = harness({
				agentDir: dir,
				targets: [{ providerId: CORE, scope: { kind: "core" } }],
				registry: [model("m1", "openai-completions")],
				editor: async () => {
					throw new Error("editor exploded");
				},
				select: "messages   → anthropic-messages",
			});

			await expect(
				runEndpointSettingCommand(h.runtime, h.ctx),
			).resolves.toBeUndefined();
			expect(h.notifications).toEqual([
				{ message: expect.stringMatching(/editor exploded/), level: "error" },
			]);
		} finally {
			cleanup();
		}
	});
});

describe("/endpoint-setting editor checklist (rpc fallback)", () => {
	it("renders the managed groups and discloses unmanaged models in the prefill", async () => {
		const { dir, cleanup } = tempDir();
		try {
			await writeModelOverrides(dir, { kind: "core" }, [
				{ targetId: "c1", write: { kind: "set", endpoint: "messages" } },
			]);
			const h = harness({
				agentDir: dir,
				mode: "rpc",
				targets: [
					{ providerId: CORE, label: "core", scope: { kind: "core" } },
					{
						providerId: TWO_API,
						label: "gateway/cpa",
						scope: { kind: "2api", instanceId: TWO_API },
					},
				],
				registry: [
					model("c1", "anthropic-messages", CORE, "Core One"),
					model("p1", "openai-completions", TWO_API, "Gateway One"),
					model("x1", "openai-responses", "openai"),
				],
				editor: undefined,
				select: undefined,
			});

			await runEndpointSettingCommand(h.runtime, h.ctx);

			const prefill = h.prefill();
			expect(prefill).toMatch(/# ── llmgates · core ──/);
			expect(prefill).toMatch(/# ── cpa · gateway\/cpa ──/);
			expect(prefill).toMatch(/^\[ ] c1\s+Core One\s+messages \*$/m);
			expect(prefill).toMatch(/^\[ ] p1\s+Gateway One\s+chat$/m);
			expect(prefill).toMatch(/另有 1 个模型.*openai/);
			expect(prefill).not.toMatch(/^\[ ] x1/m);
		} finally {
			cleanup();
		}
	});

	it("explains rejected and unparseable entries alongside the result", async () => {
		const { dir, cleanup } = tempDir();
		try {
			const h = harness({
				agentDir: dir,
				mode: "rpc",
				targets: [{ providerId: CORE, scope: { kind: "core" } }],
				registry: [model("m1", "anthropic-messages")],
				initialRegistry: [model("m1", "openai-completions")],
				editor: "[x] m1\n[x] not-a-model\nnonsense line",
				select: "messages   → anthropic-messages",
			});

			await runEndpointSettingCommand(h.runtime, h.ctx);

			expect(h.notifications).toHaveLength(1);
			expect(h.notifications[0]?.level).toBe("info");
			expect(h.notifications[0]?.message).toMatch(/not-a-model/);
			expect(h.notifications[0]?.message).toMatch(/nonsense line/);
			// The rejections do not stop the valid selection from being applied.
			expect(readModelOverridesFile(dir)?.models?.m1?.endpoint).toBe(
				"messages",
			);
		} finally {
			cleanup();
		}
	});

	it("selects every managed model when the whole checklist is checked", async () => {
		const { dir, cleanup } = tempDir();
		try {
			let prefill = "";
			const after = [
				model("c1", "anthropic-messages"),
				model("p1", "anthropic-messages", TWO_API),
			];
			const h = harness({
				agentDir: dir,
				mode: "rpc",
				targets: [
					{ providerId: CORE, scope: { kind: "core" } },
					{ providerId: TWO_API, scope: { kind: "2api", instanceId: TWO_API } },
				],
				registry: after,
				initialRegistry: [
					model("c1", "openai-completions"),
					model("p1", "openai-completions", TWO_API),
				],
				editor: () => Promise.resolve(checkAll(prefill)),
				select: "messages   → anthropic-messages",
			});
			// Capture the prefill the command produces, then hand it back fully checked.
			const originalEditor = h.ctx.editor;
			h.ctx.editor = async (title, text) => {
				prefill = text;
				return originalEditor(title, text);
			};

			await runEndpointSettingCommand(h.runtime, h.ctx);

			expect(
				h.writeCalls.map((call) => call.writes.map((entry) => entry.targetId)),
			).toEqual([["c1"], ["p1"]]);
			expect(h.notifications[0]?.level).toBe("info");
		} finally {
			cleanup();
		}
	});
});

describe("endpoint in-flight guard", () => {
	it("is shared: /endpoint is refused while the selector holds it", async () => {
		const { dir, cleanup } = tempDir();
		try {
			// Simulates the selector's editor being open: the guard is held.
			expect(acquireEndpointInFlight()).toBe(true);

			const notifications: Array<{ message: string; level: string }> = [];
			await runEndpointCommand(
				"messages m1",
				{
					coreProviderId: CORE,
					refreshEndpointForeground: async () => ({ status: "ok", models: [] }),
					writeOverride: async () => {
						throw new Error("must not write");
					},
				},
				{
					waitForIdle: async () => {},
					getModel: () => undefined,
					modelRegistry: { find: () => model("m1", "openai-completions") },
					setModel: async () => true,
					notify: (message, level) => notifications.push({ message, level }),
				},
			);

			expect(notifications).toEqual([
				{ message: expect.stringMatching(/already running/i), level: "error" },
			]);
			expect(existsSync(join(dir, "llmgates/models.json"))).toBe(false);
		} finally {
			releaseEndpointInFlight();
			cleanup();
		}
	});

	it("is shared: /llmgates-reload is refused while the selector holds it", async () => {
		try {
			expect(acquireEndpointInFlight()).toBe(true);
			const notifications: Array<{ message: string; level: string }> = [];
			await runCatalogReloadCommand(
				() => [
					{
						providerId: CORE,
						label: "core",
						refreshEndpointForeground: async () => ({ status: "ok", models: [] }),
					},
				],
				{
					waitForIdle: async () => {},
					getModel: () => undefined,
					find: () => undefined,
					setModel: async () => true,
					notify: (message, level) => notifications.push({ message, level }),
				},
			);
			expect(notifications).toEqual([
				{
					message: expect.stringMatching(/catalog refresh command is already running/i),
					level: "error",
				},
			]);
		} finally {
			releaseEndpointInFlight();
		}
	});

	it("is shared: the selector is refused while /endpoint holds it", async () => {
		const { dir, cleanup } = tempDir();
		try {
			expect(acquireEndpointInFlight()).toBe(true);
			const h = harness({
				agentDir: dir,
				targets: [{ providerId: CORE, scope: { kind: "core" } }],
				registry: [model("m1", "openai-completions")],
				editor: "[x] m1",
				select: "messages   → anthropic-messages",
			});

			await runEndpointSettingCommand(h.runtime, h.ctx);

			expect(h.notifications).toEqual([
				{ message: expect.stringMatching(/already running/i), level: "error" },
			]);
			expect(h.writeCalls).toEqual([]);
		} finally {
			releaseEndpointInFlight();
			cleanup();
		}
	});

	it("is released after a run so the next command can proceed", async () => {
		const { dir, cleanup } = tempDir();
		try {
			const h = harness({
				agentDir: dir,
				targets: [{ providerId: CORE, scope: { kind: "core" } }],
				registry: [model("m1", "openai-completions")],
				editor: undefined,
				select: undefined,
			});

			await runEndpointSettingCommand(h.runtime, h.ctx);

			expect(acquireEndpointInFlight()).toBe(true);
		} finally {
			releaseEndpointInFlight();
			cleanup();
		}
	});
});

describe("/endpoint-setting bounded idle wait", () => {
	it("aborts without writing and frees the shared guard when idle never arrives", async () => {
		const { dir, cleanup } = tempDir();
		try {
			const h = harness({
				agentDir: dir,
				targets: [{ providerId: CORE, scope: { kind: "core" } }],
				registry: [model("m1", "openai-completions")],
				editor: "[x] m1",
				select: MESSAGES_CHOICE,
			});
			// An agent turn that never settles used to hold the guard for the rest of
			// the process, permanently disabling all three endpoint commands.
			h.ctx.waitForIdle = vi.fn(() => new Promise<void>(() => {}));
			h.ctx.idleWaitTimeoutMs = 20;

			await runEndpointSettingCommand(h.runtime, h.ctx);

			expect(h.writeCalls).toHaveLength(0);
			expect(h.refreshCalls).toHaveLength(0);
			expect(h.notifications.at(-1)).toEqual({
				message: expect.stringMatching(/still busy/i),
				level: "error",
			});
			expect(existsSync(join(dir, "llmgates/models.json"))).toBe(false);
			// Guard released → the next command can run.
			expect(acquireEndpointInFlight()).toBe(true);
		} finally {
			releaseEndpointInFlight();
			cleanup();
		}
	});
});

describe("createInteractionCancellation", () => {
	it("resolves an interaction pi tore down without resolving it", async () => {
		const interaction = createInteractionCancellation();
		const pending = interaction.wrap(() => new Promise<string | undefined>(() => {}));
		interaction.cancel();
		await expect(pending).resolves.toBeUndefined();
	});

	it("passes a normal result through untouched", async () => {
		const interaction = createInteractionCancellation();
		await expect(interaction.wrap(async () => "picked")).resolves.toBe("picked");
	});

	it("is inert once the interaction has settled", async () => {
		const interaction = createInteractionCancellation();
		await interaction.wrap(async () => "picked");
		// No open interaction: cancel() must not throw or leak into the next wrap().
		expect(() => interaction.cancel()).not.toThrow();
		await expect(interaction.wrap(async () => "again")).resolves.toBe("again");
	});

	it("propagates a rejection from the interaction itself", async () => {
		const interaction = createInteractionCancellation();
		await expect(
			interaction.wrap(async () => {
				throw new Error("ui.custom exploded");
			}),
		).rejects.toThrow(/ui\.custom exploded/i);
	});
});

describe("/endpoint-setting interaction teardown", () => {
	it.each([
		["step 1 picker", "pick"],
		["the endpoint select", "select"],
	] as const)("unwinds and frees the guard when %s is cancelled", async (_label, step) => {
		const { dir, cleanup } = tempDir();
		try {
			const interaction = createInteractionCancellation();
			const h = harness({
				agentDir: dir,
				targets: [{ providerId: CORE, scope: { kind: "core" } }],
				registry: [model("m1", "openai-completions")],
				editor: "[x] m1",
				select: MESSAGES_CHOICE,
			});

			// Wire the surface under test the way registerEndpointSettingCommand does,
			// then have it hang the way a torn-down pi component does.
			const hang = () => new Promise<never>(() => {});
			if (step === "pick") {
				h.ctx.pick = () => interaction.wrap(hang);
			} else {
				h.ctx.select = () => interaction.wrap(hang);
			}

			const run = runEndpointSettingCommand(h.runtime, h.ctx);
			await new Promise((resolve) => setTimeout(resolve, 10));
			interaction.cancel(); // what the session_shutdown handler does
			await run;

			expect(h.writeCalls).toHaveLength(0);
			expect(h.notifications.at(-1)).toEqual({
				message: expect.stringMatching(/cancelled/i),
				level: "info",
			});
			expect(acquireEndpointInFlight()).toBe(true);
		} finally {
			releaseEndpointInFlight();
			cleanup();
		}
	});
});
