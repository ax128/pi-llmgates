import { readFileSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type {
	AuthInteraction,
	Credential,
	OAuthCredential,
	Provider,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EndpointRefreshResult } from "../provider.js";
import {
	createCompatBootstrapProvider,
	createCompatProvider,
	runCompatInstanceLogin,
	type CompatBootstrapResult,
	type CompatProvider,
	type CompatProviderOptions,
} from "./provider.js";
import {
	addInstance,
	assertAuthEntryAbsent,
	decodeCompatRefreshMeta,
	deleteInstanceOverrides,
	deleteLegacyBootstrapAuthEntry,
	deleteProviderAuthEntry,
	deleteProviderAuthEntryIfEqual,
	listInstances,
	parseAuthFile,
	removeInstance,
	writeProviderOAuthCredential,
} from "./storage.js";
import {
	normalizeInstanceId,
	type CompatInstance,
	type CompatScheme,
} from "./types.js";

export interface RegisterCompatGatewaysOptions {
	reservedProviderIds?: Iterable<string>;
	fetchImpl?: typeof fetch;
	now?: () => number;
	createProvider?: (options: CompatProviderOptions) => CompatProvider;
	/** Register the legacy llmgates-2api recovery provider immediately. */
	registerBootstrapProvider?: boolean;
}

export interface CompatGatewayRegistration {
	providers: Map<string, CompatProvider>;
	bootstrapProvider: Provider;
	/** Add and register an instance from the merged `/login LLMGates` flow. */
	loginInstance(
		interaction: AuthInteraction,
		scheme: CompatScheme,
	): Promise<CompatInstance>;
	/** Register the legacy recovery provider once, only when core login is unavailable. */
	registerBootstrapProvider(): void;
	/**
	 * Foreground refresh for one instance, routed through this module so the
	 * refreshed catalog is re-registered with pi. The provider's own
	 * refreshEndpointForeground only publishes in-memory models; without the
	 * re-registration the model registry keeps the pre-change `api` and a caller
	 * verifying against it would always see a stale value.
	 */
	refreshEndpointForeground(instanceId: string): Promise<EndpointRefreshResult>;
}

export type CompatCommand =
	| { action: "list" }
	| { action: "remove"; id: string }
	| { action: "help" };

const COMPAT_COMMAND_USAGE =
	"Usage: /llmgates list | /llmgates remove <id> | /llmgates help";
const COMPAT_COMMAND_HELP = `${COMPAT_COMMAND_USAGE}\n/logout removes its selected auth.json credential; this extension then deletes the matching compatible gateway registry entry and endpoint overrides. If the watcher is not running, /reload or a restart completes cleanup. Orphan auth (an auth.json key with no registry entry) must be deleted manually.`;

export function parseCompatCommand(args: string): CompatCommand {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	if (
		parts.length === 0 ||
		(parts.length === 1 && parts[0]?.toLowerCase() === "help")
	) {
		return { action: "help" };
	}
	if (parts.length === 1 && parts[0]?.toLowerCase() === "list") {
		return { action: "list" };
	}
	if (parts.length === 2 && parts[0]?.toLowerCase() === "remove") {
		return { action: "remove", id: parts[1]! };
	}
	throw new Error(COMPAT_COMMAND_USAGE);
}

export function formatCompatInstanceList(
	instances: readonly CompatInstance[],
): string {
	if (instances.length === 0)
		return "No configured compatible gateway instances.";
	return instances
		.map(
			(instance) =>
				`id=${instance.id} scheme=${instance.scheme} baseUrl=${instance.baseUrl} name=${instance.name}`,
		)
		.join("\n");
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function compatInitError(error: unknown): Error {
	return new Error(
		`Compat initialization failed: ${error instanceof Error ? error.message : String(error)}`,
		{
			cause: error,
		},
	);
}

function logWarn(message: string): void {
	console.warn(`[pi-llmgates-compat] ${message}`);
}

function readAuthMap(agentDir: string): Record<string, Credential> {
	try {
		return parseAuthFile(
			readFileSync(join(agentDir, "auth.json"), "utf8"),
		) as Record<string, Credential>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

function hasAuthEntry(
	auth: Record<string, Credential>,
	providerId: string,
): boolean {
	return Object.keys(auth).some(
		(key) => key.toLowerCase() === providerId.toLowerCase(),
	);
}

type CleanupAuthRead =
	| { status: "ok"; auth: Record<string, Credential> }
	| { status: "missing" }
	| { status: "unreadable"; error: unknown };

/**
 * Logout cleanup must never infer "logged out" from a file it could not read:
 * a missing auth.json (manual credential reset, sync gap) or one caught
 * mid-rewrite must skip the round instead of purging every instance. Unlike
 * `readAuthMap` (startup, where ENOENT legitimately means "no credentials"),
 * deletion decisions need a positively readable file.
 */
function readAuthMapForCleanup(agentDir: string): CleanupAuthRead {
	try {
		return {
			status: "ok",
			auth: parseAuthFile(
				readFileSync(join(agentDir, "auth.json"), "utf8"),
			) as Record<string, Credential>,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { status: "missing" };
		return { status: "unreadable", error };
	}
}

function matchingOAuthCredential(
	auth: Record<string, Credential>,
	instance: CompatInstance,
): OAuthCredential | undefined {
	const credential = auth[instance.id];
	if (credential?.type !== "oauth" || !credential.access?.trim())
		return undefined;
	const meta = decodeCompatRefreshMeta(credential.refresh);
	return meta?.scheme === instance.scheme ? credential : undefined;
}

export function registerCompatGateways(
	pi: ExtensionAPI,
	agentDir: string,
	options: RegisterCompatGatewaysOptions = {},
): CompatGatewayRegistration {
	const providers = new Map<string, CompatProvider>();
	const idTransactions = new Map<string, Promise<void>>();
	const reservedProviderIds = [...(options.reservedProviderIds ?? [])];
	const createProvider = options.createProvider ?? createCompatProvider;

	let instances: CompatInstance[];
	let startupAuth: Record<string, Credential> = {};
	let startupCredentials = new Map<string, OAuthCredential>();
	try {
		instances = listInstances(agentDir);
		const seen = new Set<string>();
		for (const instance of instances) {
			normalizeInstanceId(instance.id, reservedProviderIds);
			const key = instance.id.toLowerCase();
			if (seen.has(key))
				throw new Error(
					`Registry contains duplicate stored ID "${instance.id}"`,
				);
			seen.add(key);
		}
		const auth = readAuthMap(agentDir);
		startupAuth = auth;
		startupCredentials = new Map(
			instances.flatMap((instance) => {
				const credential = matchingOAuthCredential(auth, instance);
				return credential ? [[instance.id, credential] as const] : [];
			}),
		);
	} catch (error) {
		throw compatInitError(error);
	}

	async function withIdTransaction<T>(
		id: string,
		fn: () => Promise<T>,
	): Promise<T> {
		const key = id.toLowerCase();
		const previous = idTransactions.get(key);
		const run = previous ? previous.catch(() => {}).then(fn) : fn();
		const tail = run.then(
			() => undefined,
			() => undefined,
		);
		idTransactions.set(key, tail);
		try {
			return await run;
		} finally {
			if (idTransactions.get(key) === tail) idTransactions.delete(key);
		}
	}

	function registerCurrent(provider: CompatProvider): void {
		if (providers.get(provider.id) !== provider) return;
		try {
			pi.registerProvider(provider);
		} catch (error) {
			logWarn(
				`Failed to re-register ${provider.id}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async function retirePreviousProvider(instanceId: string): Promise<void> {
		const previousEntry = [...providers.entries()].find(
			([id]) => id.toLowerCase() === instanceId.toLowerCase(),
		);
		if (!previousEntry) return;

		const [previousKey, previousProvider] = previousEntry;
		providers.delete(previousKey);
		const failures: string[] = [];
		try {
			await previousProvider.shutdown();
		} catch (error) {
			failures.push(`provider shutdown: ${errorText(error)}`);
		}
		try {
			pi.unregisterProvider(previousProvider.id);
		} catch (error) {
			failures.push(`runtime unregister: ${errorText(error)}`);
		}
		if (failures.length > 0) {
			throw new Error(
				`Previous runtime provider retirement failed for ${instanceId}; ` +
					`run /reload to recover. ${failures.join("; ")}`,
			);
		}
	}

	let authWatcher: FSWatcher | undefined;
	let orphanCleanup: Promise<void> | undefined;
	let orphanCleanupRequested = false;
	let orphanCleanupRetryTimer: ReturnType<typeof setTimeout> | undefined;
	let orphanCleanupRetryCount = 0;

	const ORPHAN_CLEANUP_MAX_RETRIES = 3;
	const ORPHAN_CLEANUP_RETRY_DELAY_MS = 1_000;

	function scheduleOrphanCleanupRetry(): void {
		if (orphanCleanupRetryTimer) return;
		if (orphanCleanupRetryCount >= ORPHAN_CLEANUP_MAX_RETRIES) {
			logWarn(
				`auth.json stayed unreadable after ${ORPHAN_CLEANUP_MAX_RETRIES} cleanup retries; run /reload to retry logout cleanup.`,
			);
			return;
		}
		orphanCleanupRetryCount += 1;
		orphanCleanupRetryTimer = setTimeout(() => {
			orphanCleanupRetryTimer = undefined;
			requestOrphanCleanup();
		}, ORPHAN_CLEANUP_RETRY_DELAY_MS);
		orphanCleanupRetryTimer.unref();
	}

	function stopOrphanCleanupRetry(): void {
		if (orphanCleanupRetryTimer) {
			clearTimeout(orphanCleanupRetryTimer);
			orphanCleanupRetryTimer = undefined;
		}
	}

	async function pruneOrphanedInstances(): Promise<void> {
		const authRead = readAuthMapForCleanup(agentDir);
		if (authRead.status === "unreadable") {
			logWarn(
				`auth.json is temporarily unreadable; skipping compatible gateway logout cleanup this round: ${errorText(authRead.error)}`,
			);
			scheduleOrphanCleanupRetry();
			return;
		}
		if (authRead.status === "missing") {
			if (listInstances(agentDir).length > 0) {
				logWarn(
					"auth.json is missing; skipping compatible gateway logout cleanup this round so instances are not deleted on a missing file.",
				);
			}
			return;
		}
		// A positively readable file settles any pending retry budget.
		stopOrphanCleanupRetry();
		orphanCleanupRetryCount = 0;
		const auth = authRead.auth;
		for (const instance of listInstances(agentDir)) {
			if (hasAuthEntry(auth, instance.id)) continue;
			await withIdTransaction(instance.id, async () => {
				const currentAuthRead = readAuthMapForCleanup(agentDir);
				if (currentAuthRead.status !== "ok") {
					if (currentAuthRead.status === "unreadable")
						scheduleOrphanCleanupRetry();
					return;
				}
				if (hasAuthEntry(currentAuthRead.auth, instance.id)) return;
				const current = listInstances(agentDir).find(
					(stored) => stored.id.toLowerCase() === instance.id.toLowerCase(),
				);
				if (!current) return;

				const failures: string[] = [];
				try {
					await retirePreviousProvider(current.id);
				} catch (error) {
					failures.push(`provider cleanup: ${errorText(error)}`);
					logWarn(
						`Failed to purge logged-out ${current.id}: ${failures.join("; ")}; ` +
							"registry and endpoint overrides were kept so /reload can recover.",
					);
					return;
				}
				try {
					await removeInstance(agentDir, current.id);
				} catch (error) {
					failures.push(`registry cleanup: ${errorText(error)}`);
				}
				try {
					await deleteInstanceOverrides(agentDir, current.id);
				} catch (error) {
					failures.push(`endpoint override cleanup: ${errorText(error)}`);
				}
				if (failures.length > 0) {
					logWarn(
						`Failed to purge logged-out ${current.id}: ${failures.join("; ")}`,
					);
					return;
				}
				logWarn(
					`Removed logged-out compatible gateway instance "${current.id}": registry entry, runtime provider, and endpoint overrides deleted.`,
				);
			});
		}
	}

	function requestOrphanCleanup(): void {
		orphanCleanupRequested = true;
		if (orphanCleanup) return;
		orphanCleanup = Promise.resolve()
			.then(async () => {
				while (orphanCleanupRequested) {
					orphanCleanupRequested = false;
					await pruneOrphanedInstances();
				}
			})
			.catch((error) =>
				logWarn(
					`Failed to purge logged-out compatible gateway instances: ${errorText(error)}`,
				),
			)
			.finally(() => {
				orphanCleanup = undefined;
				if (orphanCleanupRequested) requestOrphanCleanup();
			});
	}

	function startAuthWatcher(): void {
		if (authWatcher) return;
		try {
			authWatcher = watch(
				agentDir,
				{ persistent: false },
				(_event, filename) => {
					if (!filename || filename.toString() === "auth.json")
						requestOrphanCleanup();
				},
			);
			authWatcher.on("error", (error) => {
				authWatcher = undefined;
				logWarn(`auth.json watcher stopped: ${errorText(error)}`);
			});
		} catch (error) {
			logWarn(
				`Could not watch auth.json for logout cleanup: ${errorText(error)}`,
			);
		}
	}

	function stopAuthWatcher(): void {
		authWatcher?.close();
		authWatcher = undefined;
	}

	function rollbackStartupInstances(
		registered: readonly CompatProvider[],
	): void {
		for (const provider of [...registered].reverse()) {
			if (providers.get(provider.id) === provider) {
				providers.delete(provider.id);
			}
			try {
				pi.unregisterProvider(provider.id);
			} catch (error) {
				logWarn(
					`Failed to unregister ${provider.id} during startup rollback: ${errorText(error)}`,
				);
			}
			void provider.shutdown().catch((error) => {
				logWarn(
					`Failed to shut down ${provider.id} during startup rollback: ${errorText(error)}`,
				);
			});
		}
	}

	function makeProvider(
		instance: CompatInstance,
		initialCatalog?: CompatProviderOptions["initialCatalog"],
	): CompatProvider {
		let provider!: CompatProvider;
		provider = createProvider({
			agentDir,
			instance,
			initialCatalog,
			fetchImpl: options.fetchImpl,
			now: options.now,
			onModelsChanged: (changed) => {
				if (changed === provider) registerCurrent(provider);
			},
		});
		return provider;
	}

	async function persistValidated({
		instance,
		credential,
		initialCatalog,
	}: CompatBootstrapResult): Promise<void> {
		await withIdTransaction(instance.id, async () => {
			if (
				listInstances(agentDir).some(
					(stored) => stored.id.toLowerCase() === instance.id.toLowerCase(),
				)
			) {
				throw new Error(
					`Instance ID "${instance.id}" already exists in the compatibility registry; ` +
						"if it was just logged out, wait for the cleanup to finish or run /reload.",
				);
			}
			await assertAuthEntryAbsent(agentDir, instance.id);
			await writeProviderOAuthCredential(agentDir, instance.id, credential);
			try {
				await addInstance(agentDir, instance);
			} catch (error) {
				try {
					await deleteProviderAuthEntryIfEqual(
						agentDir,
						instance.id,
						credential,
					);
				} catch (compensationError) {
					throw new Error(
						`Registry write failed and exact auth compensation also failed: ${compensationError instanceof Error ? compensationError.message : String(compensationError)}`,
						{ cause: error },
					);
				}
				throw error;
			}

			const provider = makeProvider(instance, initialCatalog);
			providers.set(instance.id, provider);
			provider.beginSession("login");
			try {
				pi.registerProvider(provider);
			} catch (error) {
				if (providers.get(instance.id) === provider)
					providers.delete(instance.id);
				await provider.shutdown();
				throw new Error(
					`Instance ${instance.id} was persisted, but runtime registration failed; run /reload to recover. ${error instanceof Error ? error.message : String(error)}`,
					{ cause: error },
				);
			}
			provider.startInitialPricingSync();
		});
	}

	const bootstrapProvider = createCompatBootstrapProvider({
		reservedProviderIds,
		resolveExistingInstanceIds: () =>
			listInstances(agentDir).map((instance) => instance.id),
		fetchImpl: options.fetchImpl,
		now: options.now,
		onValidated: persistValidated,
	});
	let bootstrapRegistered = false;
	function registerBootstrapProvider(): void {
		if (bootstrapRegistered) return;
		pi.registerProvider(bootstrapProvider);
		bootstrapRegistered = true;
	}
	if (options.registerBootstrapProvider !== false) {
		registerBootstrapProvider();
	} else if (hasAuthEntry(startupAuth, bootstrapProvider.id)) {
		// Remove the old managed marker once the bootstrap provider disappears
		// from normal `/login`; instance credentials live under their own ids.
		void deleteLegacyBootstrapAuthEntry(agentDir).catch((error) => {
			logWarn(
				`Failed to remove legacy ${bootstrapProvider.id} auth marker: ${errorText(error)}`,
			);
		});
	}

	function loginInstance(
		interaction: AuthInteraction,
		scheme: CompatScheme,
	): Promise<CompatInstance> {
		return runCompatInstanceLogin(interaction, {
			reservedProviderIds,
			resolveExistingInstanceIds: () =>
				listInstances(agentDir).map((instance) => instance.id),
			fetchImpl: options.fetchImpl,
			now: options.now,
			scheme,
			onValidated: persistValidated,
		});
	}

	pi.registerCommand("llmgates", {
		description: "List, remove, or get help for compatible gateway instances",
		handler: async (args, ctx) => {
			let command: CompatCommand;
			try {
				command = parseCompatCommand(args);
			} catch (error) {
				ctx.ui.notify(errorText(error), "error");
				return;
			}

			if (command.action === "help") {
				ctx.ui.notify(COMPAT_COMMAND_HELP, "info");
				return;
			}
			if (command.action === "list") {
				try {
					ctx.ui.notify(
						formatCompatInstanceList(listInstances(agentDir)),
						"info",
					);
				} catch (error) {
					ctx.ui.notify(
						`Failed to read compatible gateway registry: ${errorText(error)}`,
						"error",
					);
				}
				return;
			}

			await withIdTransaction(command.id, async () => {
				let instance: CompatInstance | undefined;
				try {
					instance = listInstances(agentDir).find(
						(stored) => stored.id.toLowerCase() === command.id.toLowerCase(),
					);
				} catch (error) {
					ctx.ui.notify(
						`Failed to read compatible gateway registry: ${errorText(error)}`,
						"error",
					);
					return;
				}
				if (!instance) {
					ctx.ui.notify(
						`Compatible gateway instance "${command.id}" was not found or was already removed.`,
						"info",
					);
					return;
				}

				const provider = providers.get(instance.id);
				if (provider) providers.delete(instance.id);
				const failures: string[] = [];
				if (provider) {
					try {
						await provider.shutdown();
					} catch (error) {
						failures.push(`provider shutdown: ${errorText(error)}`);
					}
				}
				try {
					pi.unregisterProvider(instance.id);
				} catch (error) {
					failures.push(`runtime unregister: ${errorText(error)}`);
				}
				try {
					await removeInstance(agentDir, instance.id);
				} catch (error) {
					failures.push(`registry cleanup: ${errorText(error)}`);
				}
				try {
					await deleteProviderAuthEntry(agentDir, instance.id);
				} catch (error) {
					failures.push(`auth cleanup: ${errorText(error)}`);
				}
				try {
					// Leaving this behind means a later instance recreated with the same id
					// silently inherits the removed one's endpoints.
					await deleteInstanceOverrides(agentDir, instance.id);
				} catch (error) {
					failures.push(`endpoint override cleanup: ${errorText(error)}`);
				}

				if (failures.length > 0) {
					ctx.ui.notify(
						`Compatible gateway instance "${instance.id}" removal was partial: ${failures.join("; ")}`,
						"warning",
					);
					return;
				}
				ctx.ui.notify(
					`Removed compatible gateway instance "${instance.id}".`,
					"info",
				);
			});
		},
	});

	pi.on("session_start", (event) => {
		startAuthWatcher();
		requestOrphanCleanup();
		const reason =
			typeof (event as { reason?: unknown })?.reason === "string"
				? (event as { reason: string }).reason
				: "start";
		for (const provider of providers.values()) {
			provider.beginSession(reason);
			void provider
				.startBackgroundRefresh()
				.then(() => registerCurrent(provider))
				.catch(() => {});
		}
	});

	pi.on("session_shutdown", async () => {
		stopAuthWatcher();
		stopOrphanCleanupRetry();
		await Promise.allSettled([
			...[...providers.values()].map((provider) => provider.shutdown()),
			...(orphanCleanup ? [orphanCleanup] : []),
		]);
	});

	const startupRegistered: CompatProvider[] = [];
	for (const instance of instances) {
		if (!startupCredentials.has(instance.id)) {
			if (hasAuthEntry(startupAuth, instance.id)) {
				logWarn(
					`Skipping ${instance.id}: registry metadata has no matching OAuth auth entry; ` +
						`repair auth.json or remove it with /llmgates remove ${instance.id}.`,
				);
			}
			continue;
		}
		const provider = makeProvider(instance);
		providers.set(instance.id, provider);
		try {
			pi.registerProvider(provider);
			startupRegistered.push(provider);
		} catch (error) {
			providers.delete(instance.id);
			rollbackStartupInstances(startupRegistered);
			throw compatInitError(error);
		}
	}

	async function refreshEndpointForeground(
		instanceId: string,
	): Promise<EndpointRefreshResult> {
		const provider = providers.get(instanceId);
		if (!provider) return { status: "not-ready" };
		const result = await provider.refreshEndpointForeground();
		if (result.status === "ok") registerCurrent(provider);
		return result;
	}

	return {
		providers,
		bootstrapProvider,
		loginInstance,
		registerBootstrapProvider,
		refreshEndpointForeground,
	};
}
