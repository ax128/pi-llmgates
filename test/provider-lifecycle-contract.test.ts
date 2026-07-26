/**
 * Behaviour-parity contract for the two independent provider implementations.
 *
 * `extensions/provider.ts` (native LLMGates) and `extensions/compat/provider.ts`
 * (2API instances) deliberately stay separate: unifying them costs ~7 hooks to
 * remove only 8 byte-identical lines. The duplication that matters is not the
 * code, it is the risk that a lifecycle fix lands on one side only.
 *
 * These tests pin the invariants both implementations must share. A fix or
 * regression applied to a single provider fails here.
 */

import type { OAuthCredential, RefreshModelsContext } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLLMGatesProvider } from "../extensions/provider.js";
import { createCompatProvider } from "../extensions/compat/provider.js";
import type { CompatInstance } from "../extensions/compat/types.js";
import { scriptedAuthInteraction } from "./helpers/auth-interaction.js";
import { createMemoryStore } from "./helpers/fake-store.js";
import { startLoopbackServer, type MockRoute } from "./helpers/loopback-server.js";
import { withTempAgentDir } from "./helpers/temp-agent-dir.js";

const API_KEY = "k-secret";
const LOGIN_CATALOG = JSON.stringify([{ id: "m1", name: "M1" }]);

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Minimal shared surface; both factories return a superset of this. */
interface LifecycleProvider {
	getModels(): readonly { id: string }[];
	refreshModels?(context: RefreshModelsContext): Promise<void>;
	auth: { oauth?: { login(interaction: never): Promise<OAuthCredential> } };
	beginSession(reason: string): void;
	shutdown(): Promise<void>;
	startBackgroundRefresh(options?: { force?: boolean }): Promise<void>;
}

interface ProviderCase {
	name: string;
	/** Path the provider hits for its catalog; differs by design (query string vs bare). */
	modelsPath: string;
	create(agentDir: string, serverBaseUrl: string): LifecycleProvider;
}

const COMPAT_INSTANCE: CompatInstance = {
	id: "work-newapi",
	name: "Work NewAPI",
	scheme: "newapi",
	baseUrl: "http://127.0.0.1:1/v1",
};

const CASES: ProviderCase[] = [
	{
		name: "native",
		modelsPath: "/v1/models?client_version=pi",
		create: (agentDir) =>
			createLLMGatesProvider({
				agentDir,
				providerId: "llmgates",
				providerName: "LLMGates",
			}) as unknown as LifecycleProvider,
	},
	{
		name: "compat",
		modelsPath: "/v1/models",
		create: (agentDir, serverBaseUrl) =>
			createCompatProvider({
				agentDir,
				instance: { ...COMPAT_INSTANCE, baseUrl: `${serverBaseUrl}/v1` },
			}) as unknown as LifecycleProvider,
	},
];

async function setupCase(providerCase: ProviderCase) {
	let hits = 0;
	const route: MockRoute = {
		path: providerCase.modelsPath,
		body: LOGIN_CATALOG,
		onRequest: () => {
			hits += 1;
		},
	};
	const server = await startLoopbackServer([route]);
	const { agentDir, cleanup } = withTempAgentDir();
	const provider = providerCase.create(agentDir, server.baseUrl);
	const store = createMemoryStore();

	const refresh = (extra: Partial<RefreshModelsContext> & { credential: OAuthCredential }) =>
		provider.refreshModels!({ store, allowNetwork: true, ...extra } as RefreshModelsContext);

	return {
		route,
		provider,
		store,
		hits: () => hits,
		modelIds: () => provider.getModels().map((model) => model.id),
		/** Both providers prompt for base URL then API key, and prime a pending catalog. */
		login: () =>
			provider.auth.oauth!.login(
				scriptedAuthInteraction([`${server.baseUrl}/v1`, API_KEY]) as never,
			),
		refresh,
		/** Login + consume the pending catalog, leaving a primed, non-stale provider. */
		async prime() {
			const credential = await this.login();
			await refresh({ credential });
			return credential;
		},
		async dispose() {
			await provider.shutdown().catch(() => {});
			cleanup();
			await server.close();
		},
	};
}

const savedEnv = {
	LLMGATES_PRICING_AUTO_UPDATE: process.env.LLMGATES_PRICING_AUTO_UPDATE,
	PI_OFFLINE: process.env.PI_OFFLINE,
};

beforeEach(() => {
	// Keep LiteLLM off the wire so hit counts only reflect catalog traffic.
	process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
	delete process.env.PI_OFFLINE;
});

afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

for (const providerCase of CASES) {
	describe(`provider lifecycle contract: ${providerCase.name}`, () => {
		it("publishes the validated catalog when the login nonce matches", async () => {
			const c = await setupCase(providerCase);
			try {
				await c.prime();
				expect(c.modelIds()).toEqual(["m1"]);
				expect(c.store.writes).toHaveLength(1);
			} finally {
				await c.dispose();
			}
		});

		it("does not consume the pending catalog when the nonce does not match", async () => {
			const c = await setupCase(providerCase);
			try {
				const credential = await c.login();
				// Any network fallback must fail, so publishing can only mean pending was consumed.
				c.route.status = 500;
				c.route.body = "nope";

				await expect(
					c.refresh({ credential: { ...credential, validationNonce: "wrong-nonce" } }),
				).rejects.toThrow();

				expect(c.modelIds()).toEqual([]);
				expect(c.store.writes).toHaveLength(0);
			} finally {
				await c.dispose();
			}
		});

		it("skips the network inside the freshness window and honours force", async () => {
			const c = await setupCase(providerCase);
			try {
				const credential = await c.prime();
				const baseline = c.hits();

				await c.refresh({ credential });
				expect(c.hits()).toBe(baseline);

				await c.refresh({ credential, force: true });
				expect(c.hits()).toBe(baseline + 1);
			} finally {
				await c.dispose();
			}
		});

		it("stops touching the network and the store after shutdown", async () => {
			const c = await setupCase(providerCase);
			try {
				await c.prime();
				await c.provider.shutdown();

				const hitsAtShutdown = c.hits();
				const writesAtShutdown = c.store.writes.length;
				await c.provider.startBackgroundRefresh({ force: true });

				expect(c.hits()).toBe(hitsAtShutdown);
				expect(c.store.writes).toHaveLength(writesAtShutdown);
			} finally {
				await c.dispose();
			}
		});

		it("skips background refresh in PI_OFFLINE mode even when primed", async () => {
			const c = await setupCase(providerCase);
			try {
				await c.prime();
				// Store and connection are already captured, so only the offline guard can stop it.
				const hitsBeforeOffline = c.hits();
				process.env.PI_OFFLINE = "1";

				await c.provider.startBackgroundRefresh({ force: true });

				expect(c.hits()).toBe(hitsBeforeOffline);
			} finally {
				await c.dispose();
			}
		});

		it("lets the newest refresh win when a slower earlier one finishes late", async () => {
			const c = await setupCase(providerCase);
			try {
				const credential = await c.prime();

				let call = 0;
				c.route.body = () => {
					const id = ++call === 1 ? "stale" : "fresh";
					return (async function* () {
						if (id === "stale") {
							await delay(150);
						}
						yield Buffer.from(JSON.stringify([{ id, name: id }]));
					})();
				};

				const first = c.refresh({ credential, force: true });
				await delay(25);
				const second = c.refresh({ credential, force: true });
				await Promise.allSettled([first, second]);

				expect(c.modelIds()).toEqual(["fresh"]);
				expect(c.store.writes.at(-1)?.models.map((model) => model.id)).toEqual(["fresh"]);
			} finally {
				await c.dispose();
			}
		});
	});
}
