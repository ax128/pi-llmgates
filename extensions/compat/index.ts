import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Credential, OAuthCredential, Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createCompatBootstrapProvider,
	createCompatProvider,
	type CompatProvider,
	type CompatProviderOptions,
} from "./provider.js";
import {
	addInstance,
	assertAuthEntryAbsent,
	decodeCompatRefreshMeta,
	deleteProviderAuthEntry,
	deleteProviderAuthEntryIfEqual,
	listInstances,
	parseAuthFile,
	removeInstance,
	writeProviderOAuthCredential,
} from "./storage.js";
import { normalizeInstanceId, type CompatInstance } from "./types.js";

export interface RegisterCompatGatewaysOptions {
	reservedProviderIds?: Iterable<string>;
	fetchImpl?: typeof fetch;
	now?: () => number;
	createProvider?: (options: CompatProviderOptions) => CompatProvider;
}

export interface CompatGatewayRegistration {
	providers: Map<string, CompatProvider>;
	bootstrapProvider: Provider;
}

export type CompatCommand =
	| { action: "list" }
	| { action: "remove"; id: string }
	| { action: "help" };

const COMPAT_COMMAND_USAGE = "Usage: /2api list | /2api remove <id> | /2api help";
const COMPAT_COMMAND_HELP = `${COMPAT_COMMAND_USAGE}\nOrphan auth (an auth.json key with no registry entry) is not removed by /2api remove; delete that key manually or re-add with the same ID remains blocked. /logout may list removed IDs until /reload.`;

export function parseCompatCommand(args: string): CompatCommand {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0 || (parts.length === 1 && parts[0]?.toLowerCase() === "help")) {
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

export function formatCompatInstanceList(instances: readonly CompatInstance[]): string {
	if (instances.length === 0) return "No configured 2api instances.";
	return instances
		.map((instance) => `id=${instance.id} scheme=${instance.scheme} baseUrl=${instance.baseUrl} name=${instance.name}`)
		.join("\n");
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function compatInitError(error: unknown): Error {
	return new Error(`Compat initialization failed: ${error instanceof Error ? error.message : String(error)}`, {
		cause: error,
	});
}

function logWarn(message: string): void {
	console.warn(`[pi-llmgates-compat] ${message}`);
}

function readAuthMap(agentDir: string): Record<string, Credential> {
	try {
		return parseAuthFile(readFileSync(join(agentDir, "auth.json"), "utf8")) as Record<string, Credential>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

function matchingOAuthCredential(
	auth: Record<string, Credential>,
	instance: CompatInstance,
): OAuthCredential | undefined {
	const credential = auth[instance.id];
	if (credential?.type !== "oauth" || !credential.access?.trim()) return undefined;
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
	let startupCredentials = new Map<string, OAuthCredential>();
	try {
		instances = listInstances(agentDir);
		const seen = new Set<string>();
		for (const instance of instances) {
			normalizeInstanceId(instance.id, reservedProviderIds);
			const key = instance.id.toLowerCase();
			if (seen.has(key)) throw new Error(`Registry contains duplicate stored ID "${instance.id}"`);
			seen.add(key);
		}
		const auth = readAuthMap(agentDir);
		startupCredentials = new Map(instances.flatMap((instance) => {
			const credential = matchingOAuthCredential(auth, instance);
			return credential ? [[instance.id, credential] as const] : [];
		}));
	} catch (error) {
		throw compatInitError(error);
	}

	async function withIdTransaction<T>(id: string, fn: () => Promise<T>): Promise<T> {
		const key = id.toLowerCase();
		const previous = idTransactions.get(key);
		const run = previous ? previous.catch(() => {}).then(fn) : fn();
		const tail = run.then(() => undefined, () => undefined);
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
			logWarn(`Failed to re-register ${provider.id}: ${error instanceof Error ? error.message : String(error)}`);
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

	const bootstrapProvider = createCompatBootstrapProvider({
		reservedProviderIds,
		fetchImpl: options.fetchImpl,
		now: options.now,
		async onValidated({ instance, credential, initialCatalog }) {
			await withIdTransaction(instance.id, async () => {
				if (listInstances(agentDir).some((stored) => stored.id.toLowerCase() === instance.id.toLowerCase())) {
					throw new Error(`Instance ID "${instance.id}" already exists in the compatibility registry`);
				}
				await assertAuthEntryAbsent(agentDir, instance.id);
				await writeProviderOAuthCredential(agentDir, instance.id, credential);
				try {
					await addInstance(agentDir, instance);
				} catch (error) {
					try {
						await deleteProviderAuthEntryIfEqual(agentDir, instance.id, credential);
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
				provider.beginSession("bootstrap");
				try {
					pi.registerProvider(provider);
				} catch (error) {
					if (providers.get(instance.id) === provider) providers.delete(instance.id);
					await provider.shutdown();
					throw new Error(
						`Instance ${instance.id} was persisted, but runtime registration failed; run /reload to recover. ${error instanceof Error ? error.message : String(error)}`,
						{ cause: error },
					);
				}
				provider.startInitialPricingSync();
			});
		},
	});

	pi.registerProvider(bootstrapProvider);
	for (const instance of instances) {
		if (!startupCredentials.has(instance.id)) {
			logWarn(`Skipping ${instance.id}: registry metadata has no matching OAuth auth entry; run /login llmgates-2api or repair auth.json.`);
			continue;
		}
		const provider = makeProvider(instance);
		providers.set(instance.id, provider);
		try {
			pi.registerProvider(provider);
		} catch (error) {
			providers.delete(instance.id);
			throw compatInitError(error);
		}
	}

	pi.registerCommand("2api", {
		description: "List, remove, or get help for 2api gateway instances",
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
					ctx.ui.notify(formatCompatInstanceList(listInstances(agentDir)), "info");
				} catch (error) {
					ctx.ui.notify(`Failed to read 2api registry: ${errorText(error)}`, "error");
				}
				return;
			}

			await withIdTransaction(command.id, async () => {
				let instance: CompatInstance | undefined;
				try {
					instance = listInstances(agentDir)
						.find((stored) => stored.id.toLowerCase() === command.id.toLowerCase());
				} catch (error) {
					ctx.ui.notify(`Failed to read 2api registry: ${errorText(error)}`, "error");
					return;
				}
				if (!instance) {
					ctx.ui.notify(`2api instance "${command.id}" was not found or was already removed.`, "info");
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

				if (failures.length > 0) {
					ctx.ui.notify(`2api instance "${instance.id}" removal was partial: ${failures.join("; ")}`, "warning");
					return;
				}
				ctx.ui.notify(`Removed 2api instance "${instance.id}".`, "info");
			});
		},
	});

	pi.on("session_start", (event) => {
		const reason = typeof (event as { reason?: unknown })?.reason === "string"
			? (event as { reason: string }).reason
			: "start";
		for (const provider of providers.values()) {
			provider.beginSession(reason);
			void provider.startBackgroundRefresh()
				.then(() => registerCurrent(provider))
				.catch(() => {});
		}
	});

	pi.on("session_shutdown", async () => {
		await Promise.allSettled([...providers.values()].map((provider) => provider.shutdown()));
	});

	return { providers, bootstrapProvider };
}
