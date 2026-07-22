import type { Api, Model, ProviderModelsStore } from "@earendil-works/pi-ai";

export function createMemoryStore(initial?: {
	models: Model<Api>[];
	checkedAt?: number;
}): ProviderModelsStore & {
	writes: Array<{ models: Model<Api>[]; checkedAt?: number }>;
	failNextWrite?: Error;
} {
	let entry = initial;
	const writes: Array<{ models: Model<Api>[]; checkedAt?: number }> = [];
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
