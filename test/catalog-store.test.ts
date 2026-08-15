/**
 * pi-ai >=0.84 replaced the provider-scoped `context.store` with the read-only
 * `context.stored` snapshot plus the generation-checked `context.publish()`.
 * These cover the adapter that spans both contracts, plus end-to-end gateway
 * refreshes on the new one.
 */

import type {
	Api,
	Credential,
	Model,
	RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogStoreFromRefreshContext } from "../extensions/catalog-store.js";
import { createCompatProvider } from "../extensions/compat/provider.js";
import type { CompatInstance } from "../extensions/compat/types.js";
import { encodeCompatRefreshMeta } from "../extensions/compat/storage.js";
import {
	createMemoryStore,
	createPublishingStore,
	type FakeRefreshPhase,
} from "./helpers/fake-store.js";
import { withTempAgentDir } from "./helpers/temp-agent-dir.js";

const BASE_URL = "https://gateway.example/v1";

const INSTANCE: CompatInstance = {
	id: "work-newapi",
	name: "Work NewAPI",
	scheme: "newapi",
	baseUrl: BASE_URL,
};

const originalEnv = {
	LLMGATES_PRICING_AUTO_UPDATE: process.env.LLMGATES_PRICING_AUTO_UPDATE,
	PI_OFFLINE: process.env.PI_OFFLINE,
};

afterEach(() => {
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	vi.restoreAllMocks();
});

function model(id: string, providerId: string = INSTANCE.id): Model<Api> {
	return {
		id,
		name: id,
		provider: providerId,
		baseUrl: BASE_URL,
		api: "openai-completions" as Api,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

/** Both context shapes are version-specific, so tests build them structurally. */
function asRefreshContext(fields: Record<string, unknown>): RefreshModelsContext {
	return fields as unknown as RefreshModelsContext;
}

function compatCredential(): Credential {
	return {
		type: "oauth",
		access: "k-secret",
		refresh: encodeCompatRefreshMeta({
			baseUrl: BASE_URL,
			scheme: INSTANCE.scheme,
		}),
		expires: 1,
		validationNonce: "nonce",
	};
}

function jsonFetch(payload: unknown): typeof fetch {
	return (async () => new Response(JSON.stringify(payload))) as typeof fetch;
}

describe("catalogStoreFromRefreshContext", () => {
	it("reads the stored snapshot and commits through publish", async () => {
		const backing = createPublishingStore({
			models: [model("cached")],
			checkedAt: 5,
		});
		const phase = backing.phase();
		const store = catalogStoreFromRefreshContext(
			asRefreshContext({ allowNetwork: true, ...phase }),
			() => {},
		);

		expect((await store.read())?.models.map((m) => m.id)).toEqual(["cached"]);

		const applied: string[] = [];
		const committed = await store.commit(
			{ models: [model("fresh")], checkedAt: 9 },
			() => applied.push("update"),
		);

		expect(committed).toBe(true);
		expect(applied).toEqual(["update"]);
		expect(backing.writes).toHaveLength(1);
		expect(backing.read()?.models.map((m) => m.id)).toEqual(["fresh"]);
	});

	it("reports a superseded publish without persisting or updating", async () => {
		const backing = createPublishingStore();
		const stale = backing.phase();
		const store = catalogStoreFromRefreshContext(
			asRefreshContext({ allowNetwork: true, ...stale }),
			() => {},
		);
		// A newer refresh phase supersedes the captured publish, exactly as pi does
		// for the store handle the provider keeps past refreshModels().
		backing.phase();

		const applied: string[] = [];
		const committed = await store.commit(
			{ models: [model("fresh")], checkedAt: 9 },
			() => applied.push("update"),
		);

		expect(committed).toBe(false);
		expect(applied).toEqual([]);
		expect(backing.writes).toHaveLength(0);
	});

	it("reports an aborted publish as not committed instead of throwing", async () => {
		const backing = createPublishingStore();
		const controller = new AbortController();
		const phase = backing.phase(controller.signal);
		const store = catalogStoreFromRefreshContext(
			asRefreshContext({ allowNetwork: true, ...phase }),
			() => {},
		);
		controller.abort();

		await expect(
			store.commit({ models: [model("fresh")] }, () => {
				throw new Error("update must not run");
			}),
		).resolves.toBe(false);
		expect(backing.writes).toHaveLength(0);
	});

	it("keeps a committed transaction whose update aborted the phase", async () => {
		// Production shape: `update` publishes models, which re-registers the
		// provider, which makes pi supersede and abort this very refresh. pi races
		// the publish promise against that signal, so it rejects *after* the entry
		// persisted and the update ran. That must still read as committed.
		const backing = createPublishingStore();
		const controller = new AbortController();
		const phase = backing.phase(controller.signal);
		const store = catalogStoreFromRefreshContext(
			asRefreshContext({ allowNetwork: true, ...phase }),
			() => {},
		);

		const applied: string[] = [];
		await expect(
			store.commit({ models: [model("fresh")], checkedAt: 9 }, () => {
				applied.push("update");
				controller.abort();
			}),
		).resolves.toBe(true);
		expect(applied).toEqual(["update"]);
		expect(backing.writes).toHaveLength(1);
	});

	it("propagates a publish persistence failure", async () => {
		const backing = createPublishingStore();
		const phase = backing.phase();
		phase.publish = async () => {
			throw new Error("disk full");
		};
		const store = catalogStoreFromRefreshContext(
			asRefreshContext({ allowNetwork: true, ...phase }),
			() => {},
		);

		await expect(store.commit({ models: [model("fresh")] })).rejects.toThrow(
			"disk full",
		);
	});

	it("uses the legacy store when the context has no publish", async () => {
		const backing = createMemoryStore({
			models: [model("cached")],
			checkedAt: 2,
		});
		const store = catalogStoreFromRefreshContext(
			asRefreshContext({ allowNetwork: true, store: backing }),
			() => {},
		);

		expect((await store.read())?.models.map((m) => m.id)).toEqual(["cached"]);

		const applied: string[] = [];
		const committed = await store.commit(
			{ models: [model("fresh")], checkedAt: 7 },
			() => applied.push("first"),
		);
		expect(committed).toBe(true);
		expect(applied).toEqual(["first"]);

		await expect(
			store.commit({ models: [] }, () => applied.push("second")),
		).resolves.toBe(true);
		expect(applied).toEqual(["first", "second"]);
	});

	it("falls back to memory-only publishing when neither contract is present", async () => {
		const warnings: string[] = [];
		const store = catalogStoreFromRefreshContext(
			asRefreshContext({ allowNetwork: true }),
			(message) => warnings.push(message),
		);

		expect(await store.read()).toBeUndefined();
		const applied: string[] = [];
		await expect(
			store.commit({ models: [model("fresh")] }, () => applied.push("update")),
		).resolves.toBe(true);
		expect(applied).toEqual(["update"]);
	});
});

describe("gateway refresh on the publish contract", () => {
	it("persists and publishes a fetched catalog", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const provider = createCompatProvider({
				agentDir,
				instance: INSTANCE,
				fetchImpl: jsonFetch([{ id: "m1" }]),
			});
			const backing = createPublishingStore();

			await provider.refreshModels!(
				asRefreshContext({
					credential: compatCredential(),
					allowNetwork: true,
					force: true,
					...backing.phase(),
				}),
			);

			expect(provider.getModels().map((m) => m.id)).toEqual(["m1"]);
			expect(backing.writes).toHaveLength(1);
			expect(backing.read()?.models.map((m) => m.id)).toEqual(["m1"]);
		} finally {
			cleanup();
		}
	});

	it("restores the stored snapshot without network access", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const provider = createCompatProvider({
				agentDir,
				instance: INSTANCE,
				fetchImpl: (async () => {
					throw new Error("no network in this phase");
				}) as typeof fetch,
			});
			const backing = createPublishingStore({
				models: [model("cached")],
				checkedAt: 1,
			});

			await provider.refreshModels!(
				asRefreshContext({
					credential: compatCredential(),
					allowNetwork: false,
					...backing.phase(),
				}),
			);

			expect(provider.getModels().map((m) => m.id)).toEqual(["cached"]);
			expect(backing.writes).toHaveLength(0);
		} finally {
			cleanup();
		}
	});

	it("background refresh commits through the captured publish", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			let payload: unknown = [{ id: "m1" }];
			const provider = createCompatProvider({
				agentDir,
				instance: INSTANCE,
				fetchImpl: (async () =>
					new Response(JSON.stringify(payload))) as typeof fetch,
			});
			const backing = createPublishingStore();

			await provider.refreshModels!(
				asRefreshContext({
					credential: compatCredential(),
					allowNetwork: true,
					force: true,
					...backing.phase(),
				}),
			);
			expect(provider.getModels().map((m) => m.id)).toEqual(["m1"]);

			// The handle outlives refreshModels(); a later background refresh must
			// still persist and publish through it.
			payload = [{ id: "m2" }];
			await provider.startBackgroundRefresh({ force: true });

			expect(provider.getModels().map((m) => m.id)).toEqual(["m2"]);
			expect(backing.writes).toHaveLength(2);
			expect(backing.read()?.models.map((m) => m.id)).toEqual(["m2"]);
		} finally {
			cleanup();
		}
	});

	it("keeps a catalog whose publish was superseded mid-fetch", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const backing = createPublishingStore();
			let payload: unknown = [{ id: "m1" }];
			let supersedeDuringFetch = false;
			const provider = createCompatProvider({
				agentDir,
				instance: INSTANCE,
				fetchImpl: (async () => {
					// Publishing models re-registers the provider, and pi answers that
					// with a new global refresh — so a sibling provider publishing
					// while this fetch is in flight supersedes our publish handle.
					if (supersedeDuringFetch) backing.phase();
					return new Response(JSON.stringify(payload));
				}) as typeof fetch,
			});

			await provider.refreshModels!(
				asRefreshContext({
					credential: compatCredential(),
					allowNetwork: true,
					force: true,
					...backing.phase(),
				}),
			);
			expect(provider.getModels().map((m) => m.id)).toEqual(["m1"]);

			payload = [{ id: "m2" }];
			supersedeDuringFetch = true;
			await provider.startBackgroundRefresh({ force: true });

			// Nothing persisted (pi owns that call), but the fresh catalog must still
			// reach the session instead of being silently dropped.
			expect(provider.getModels().map((m) => m.id)).toEqual(["m2"]);
			expect(backing.writes).toHaveLength(1);

			// A later cache-only refresh must not restore the older stored catalog
			// over the newer in-memory one.
			supersedeDuringFetch = false;
			await provider.refreshModels!(
				asRefreshContext({
					credential: compatCredential(),
					allowNetwork: false,
					...backing.phase(),
				}),
			);
			expect(provider.getModels().map((m) => m.id)).toEqual(["m2"]);
		} finally {
			cleanup();
		}
	});

	it("still applies a foreground refresh when persistence is superseded", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const provider = createCompatProvider({
				agentDir,
				instance: INSTANCE,
				fetchImpl: jsonFetch([{ id: "m1" }]),
			});
			const backing = createPublishingStore();

			await provider.refreshModels!(
				asRefreshContext({
					credential: compatCredential(),
					allowNetwork: true,
					force: true,
					...backing.phase(),
				}),
			);
			// pi starts a newer refresh, which supersedes the captured publish.
			backing.phase();

			// /endpoint asked for this catalog, so it takes effect for the session
			// even though pi refused the store write.
			const result = await provider.refreshEndpointForeground();
			expect(result.status).toBe("ok");
			expect(provider.getModels().map((m) => m.id)).toEqual(["m1"]);
			expect(backing.writes).toHaveLength(1);
		} finally {
			cleanup();
		}
	});

	it("commits even though publishing aborted its own refresh", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const backing = createPublishingStore();
			const controller = new AbortController();
			const provider = createCompatProvider({
				agentDir,
				instance: INSTANCE,
				fetchImpl: jsonFetch([{ id: "m1" }]),
				// Publishing re-registers the provider, and pi answers that by
				// superseding — and aborting — this very refresh phase.
				onModelsChanged: () => controller.abort(),
			});

			await expect(
				provider.refreshModels!(
					asRefreshContext({
						credential: compatCredential(),
						allowNetwork: true,
						force: true,
						...backing.phase(controller.signal),
					}),
				),
			).resolves.toBeUndefined();

			// The transaction completed before the abort: persisted, not "failed".
			expect(provider.getModels().map((m) => m.id)).toEqual(["m1"]);
			expect(backing.writes).toHaveLength(1);
			expect(backing.read()?.models.map((m) => m.id)).toEqual(["m1"]);
		} finally {
			cleanup();
		}
	});

	it("foreground refresh reports ok when publishing aborted the phase", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const backing = createPublishingStore();
			let abortOnPublish: AbortController | undefined;
			const provider = createCompatProvider({
				agentDir,
				instance: INSTANCE,
				fetchImpl: jsonFetch([{ id: "m1" }]),
				onModelsChanged: () => abortOnPublish?.abort(),
			});
			const controller = new AbortController();
			abortOnPublish = controller;

			await provider.refreshModels!(
				asRefreshContext({
					credential: compatCredential(),
					allowNetwork: true,
					force: true,
					...backing.phase(controller.signal),
				}),
			);

			// /endpoint must not surface the self-inflicted abort as a hard error.
			const result = await provider.refreshEndpointForeground();
			expect(result.status).toBe("ok");
			expect(backing.writes).toHaveLength(1);
		} finally {
			cleanup();
		}
	});

	it("clears the memory-ahead marker once a commit persists", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const backing = createPublishingStore();
			let payload: unknown = [{ id: "m1" }];
			let supersedeDuringFetch = false;
			const provider = createCompatProvider({
				agentDir,
				instance: INSTANCE,
				fetchImpl: (async () => {
					if (supersedeDuringFetch) backing.phase();
					return new Response(JSON.stringify(payload));
				}) as typeof fetch,
			});

			await provider.refreshModels!(
				asRefreshContext({
					credential: compatCredential(),
					allowNetwork: true,
					force: true,
					...backing.phase(),
				}),
			);

			payload = [{ id: "m2" }];
			supersedeDuringFetch = true;
			await provider.startBackgroundRefresh({ force: true });
			expect(provider.getModels().map((m) => m.id)).toEqual(["m2"]);

			// Marker set: a restore must not pull the older entry back over it.
			await provider.refreshModels!(
				asRefreshContext({
					credential: compatCredential(),
					allowNetwork: false,
					...backing.phase(),
					stored: { models: [model("fromdisk")], checkedAt: 1 },
				}),
			);
			expect(provider.getModels().map((m) => m.id)).toEqual(["m2"]);

			// A commit that persists again puts the store back in front.
			payload = [{ id: "m3" }];
			supersedeDuringFetch = false;
			await provider.startBackgroundRefresh({ force: true });
			expect(backing.read()?.models.map((m) => m.id)).toEqual(["m3"]);

			await provider.refreshModels!(
				asRefreshContext({
					credential: compatCredential(),
					allowNetwork: false,
					...backing.phase(),
					stored: { models: [model("fromdisk")], checkedAt: 1 },
				}),
			);
			expect(provider.getModels().map((m) => m.id)).toEqual(["fromdisk"]);
		} finally {
			cleanup();
		}
	});

	it("keeps the memory-ahead marker across a session boundary", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const backing = createPublishingStore();
			let payload: unknown = [{ id: "m1" }];
			let supersedeDuringFetch = false;
			const provider = createCompatProvider({
				agentDir,
				instance: INSTANCE,
				fetchImpl: (async () => {
					if (supersedeDuringFetch) backing.phase();
					return new Response(JSON.stringify(payload));
				}) as typeof fetch,
			});

			await provider.refreshModels!(
				asRefreshContext({
					credential: compatCredential(),
					allowNetwork: true,
					force: true,
					...backing.phase(),
				}),
			);
			payload = [{ id: "m2" }];
			supersedeDuringFetch = true;
			await provider.startBackgroundRefresh({ force: true });
			expect(provider.getModels().map((m) => m.id)).toEqual(["m2"]);

			// A new session inside a live process must not undo a catalog that only
			// lives in memory — otherwise the restore reverts the last /endpoint.
			supersedeDuringFetch = false;
			provider.beginSession("next");
			await provider.refreshModels!(
				asRefreshContext({
					credential: compatCredential(),
					allowNetwork: false,
					...backing.phase(),
				}),
			);
			expect(provider.getModels().map((m) => m.id)).toEqual(["m2"]);

			// A restart after shutdown drops the handle, so the store leads again.
			await provider.shutdown();
			provider.beginSession("restart");
			await provider.refreshModels!(
				asRefreshContext({
					credential: compatCredential(),
					allowNetwork: false,
					...backing.phase(),
				}),
			);
			expect(provider.getModels().map((m) => m.id)).toEqual(["m1"]);
		} finally {
			cleanup();
		}
	});

	it("publishes in memory when persistence is superseded", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const provider = createCompatProvider({
				agentDir,
				instance: INSTANCE,
				fetchImpl: jsonFetch([{ id: "m1" }]),
			});
			const backing = createPublishingStore();
			const phase: FakeRefreshPhase = backing.phase();
			// A newer refresh starts while this one is still fetching.
			backing.phase();

			await provider.refreshModels!(
				asRefreshContext({
					credential: compatCredential(),
					allowNetwork: true,
					force: true,
					...phase,
				}),
			);

			// pi owns persistence and refused this handle, but the fetched catalog is
			// still the newest one this provider has: publish it rather than drop it.
			expect(backing.writes).toHaveLength(0);
			expect(provider.getModels().map((m) => m.id)).toEqual(["m1"]);
		} finally {
			cleanup();
		}
	});
});
