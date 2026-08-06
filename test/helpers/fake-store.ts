import type { Api, Model } from "@earendil-works/pi-ai";

export interface FakeStoreEntry {
	models: Model<Api>[];
	checkedAt?: number;
}

/** pi-ai <0.84 refresh contract: a provider-scoped read/write store. */
export function createMemoryStore(initial?: FakeStoreEntry): {
	read(): Promise<FakeStoreEntry | undefined>;
	write(entry: { models: readonly Model<Api>[]; checkedAt?: number }): Promise<void>;
	delete(): Promise<void>;
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

/**
 * pi-ai >=0.84 refresh contract: a read-only `stored` snapshot plus a
 * generation-checked `publish()` that persists, then runs `update` synchronously
 * while the phase is still current. Superseded phases publish nothing and answer
 * false; an aborted signal rejects, exactly as pi's `raceWithAbortSignal` does.
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
				async publish(publication: FakePublication) {
					if (signal.aborted) {
						throw new DOMException("The operation was aborted.", "AbortError");
					}
					if (phaseGeneration !== generation) return false;
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
				},
			};
		},
	};
	return store;
}
