import type { Api, Model, ProviderModelsStore } from "@earendil-works/pi-ai";

export interface FakeStoreEntry {
	models: Model<Api>[];
	checkedAt?: number;
}

/**
 * pi-ai <0.84 refresh contract: a provider-scoped read/write store. Typed as
 * pi's own `ProviderModelsStore` so the legacy fake stays pinned to the
 * interface the 0.81–0.83 path is claimed to keep working against.
 */
export function createMemoryStore(initial?: FakeStoreEntry): ProviderModelsStore & {
	writes: FakeStoreEntry[];
	failNextWrite?: Error;
} {
	let entry = initial;
	const writes: FakeStoreEntry[] = [];
	const store = {
		writes,
		failNextWrite: undefined as Error | undefined,
		async read() {
			return entry ? { models: entry.models, checkedAt: entry.checkedAt } : undefined;
		},
		async write(next: { models: readonly Model<Api>[]; checkedAt?: number }) {
			if (store.failNextWrite) {
				const err = store.failNextWrite;
				store.failNextWrite = undefined;
				throw err;
			}
			entry = { models: [...next.models], checkedAt: next.checkedAt };
			writes.push({ models: [...next.models], checkedAt: next.checkedAt });
		},
		async delete() {
			entry = undefined;
		},
	};
	return store;
}

export interface FakePublication {
	persist?: { models: readonly Model<Api>[]; checkedAt?: number } | null;
	update?: () => void;
}

export interface FakeRefreshPhase {
	stored?: { models: readonly Model<Api>[]; checkedAt?: number };
	signal: AbortSignal;
	publish(publication: FakePublication): Promise<boolean>;
}

function abortError(): DOMException {
	return new DOMException("The operation was aborted.", "AbortError");
}

/**
 * pi's `raceWithAbortSignal`: stop waiting for the transaction as soon as the
 * signal aborts, even when the transaction itself went on to succeed.
 */
function raceWithAbortSignal<T>(
	operation: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	if (signal.aborted) {
		void operation.catch(() => {});
		return Promise.reject(abortError());
	}
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const onAbort = () => {
			if (settled) return;
			settled = true;
			reject(abortError());
		};
		signal.addEventListener("abort", onAbort, { once: true });
		void operation.then(
			(value) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

/**
 * pi-ai >=0.84 refresh contract: a read-only `stored` snapshot plus a
 * generation-checked `publish()` that persists, then runs `update` synchronously
 * while the phase is still current. Superseded phases publish nothing and answer
 * false.
 *
 * The returned promise is raced against the signal exactly as pi does, so an
 * `update` that aborts the phase — which is what publishing does in production,
 * because re-registering the provider supersedes the refresh — rejects the
 * publish **after** the transaction already persisted and applied.
 */
export function createPublishingStore(initial?: FakeStoreEntry): {
	writes: FakeStoreEntry[];
	failNextWrite?: Error;
	read(): FakeStoreEntry | undefined;
	/** Start a refresh phase; supersedes every phase handed out before it. */
	phase(signal?: AbortSignal): FakeRefreshPhase;
} {
	let entry = initial;
	let generation = 0;
	const writes: FakeStoreEntry[] = [];
	const store = {
		writes,
		failNextWrite: undefined as Error | undefined,
		read() {
			return entry;
		},
		phase(signal: AbortSignal = new AbortController().signal): FakeRefreshPhase {
			generation += 1;
			const phaseGeneration = generation;
			return {
				stored: entry
					? { models: [...entry.models], checkedAt: entry.checkedAt }
					: undefined,
				signal,
				publish(publication: FakePublication) {
					const transaction = (async () => {
						// pi queues publications per provider, so the abort race is armed
						// before the transaction body runs. Mirror that ordering.
						await Promise.resolve();
						if (signal.aborted || phaseGeneration !== generation) return false;
						if (publication.persist === null) {
							entry = undefined;
						} else if (publication.persist !== undefined) {
							if (store.failNextWrite) {
								const err = store.failNextWrite;
								store.failNextWrite = undefined;
								throw err;
							}
							entry = {
								models: [...publication.persist.models],
								checkedAt: publication.persist.checkedAt,
							};
							writes.push({
								models: [...publication.persist.models],
								checkedAt: publication.persist.checkedAt,
							});
						}
						if (signal.aborted || phaseGeneration !== generation) return false;
						publication.update?.();
						return true;
					})();
					return raceWithAbortSignal(transaction, signal);
				},
			};
		},
	};
	return store;
}
