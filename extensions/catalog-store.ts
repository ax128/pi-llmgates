/**
 * Refresh-context catalog storage, normalized across pi-ai versions.
 *
 * pi-ai < 0.84 hands `refreshModels()` a provider-scoped `context.store` with
 * `read()`/`write()`. 0.84 removed it: the cached entry arrives as the read-only
 * `context.stored` snapshot, and persistence goes through the generation-checked
 * `context.publish({ persist, update })` transaction, which runs `update`
 * synchronously right after the store write and answers false once a newer
 * refresh has superseded this one.
 *
 * The provider keeps the store handle past the refresh call (background and
 * /endpoint foreground refreshes commit through it), so this adapter exposes the
 * union as one long-lived object: `read()` for the restore phase, `commit()` for
 * the write-then-publish transaction.
 */

import type { Api, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import { isAbortLikeError } from "./util.js";

export interface CatalogStoreEntry {
	models: readonly Model<Api>[];
	checkedAt?: number;
}

/**
 * Tri-state result of a foreground catalog refresh, shared by every command that
 * drives one (`/endpoint`, `/endpoint-setting`, `/llmgates-reload`) and by the
 * gateway providers that produce it.
 */
export type EndpointRefreshResult =
	| { status: "offline" }
	| { status: "not-ready" }
	| { status: "superseded" }
	| { status: "ok"; models: Model<Api>[] };

export interface CatalogStore {
	/** Cached catalog for this refresh phase. Rejects only on the legacy read path. */
	read(): Promise<CatalogStoreEntry | undefined>;
	/**
	 * Persist `entry`, then run `update` synchronously while this refresh still
	 * owns the catalog — callers put their post-write guards and in-memory publish
	 * there. Rejects when persistence itself fails.
	 *
	 * Resolves true when `update` ran, which in both contracts means the entry
	 * persisted first. Resolves false when pi skipped the whole transaction
	 * because a newer refresh superseded this handle: nothing persisted and
	 * nothing published, so callers that must not lose a fresh catalog publish it
	 * in memory themselves (see `modelsAheadOfStore`). Without an `update`, the
	 * result is simply whether the entry persisted.
	 */
	commit(entry: CatalogStoreEntry, update?: () => void): Promise<boolean>;
}

interface LegacyProviderStore {
	read(): Promise<CatalogStoreEntry | undefined>;
	write(entry: CatalogStoreEntry): Promise<void>;
}

interface CatalogPublication {
	persist?: CatalogStoreEntry | null;
	update?: () => void;
}

/** Structural view of both context shapes; neither field exists in both versions. */
interface RefreshContextCompat {
	store?: LegacyProviderStore;
	stored?: Readonly<CatalogStoreEntry>;
	publish?: (publication: CatalogPublication) => Promise<boolean>;
}

let warnedUnsupportedContract = false;

/**
 * Adapter over whichever storage contract `context` carries. An unknown contract
 * (a future pi that drops both) degrades to memory-only: models still publish,
 * nothing persists.
 */
export function catalogStoreFromRefreshContext(
	context: RefreshModelsContext,
	logWarn: (message: string) => void,
): CatalogStore {
	const compat = context as unknown as RefreshContextCompat;

	if (typeof compat.publish === "function") {
		const publish = compat.publish.bind(compat);
		const stored = compat.stored;
		return {
			async read() {
				return stored
					? { models: stored.models, checkedAt: stored.checkedAt }
					: undefined;
			},
			async commit(entry, update) {
				// Report whether `update` ran rather than what publish() returned: pi
				// rejects the returned promise as soon as the refresh signal aborts,
				// including after a completed transaction. Publishing models
				// re-registers the provider, which makes pi start a new global refresh
				// and abort this very signal, so that race is the common case.
				let applied = false;
				const wrapped = update
					? () => {
							applied = true;
							update();
						}
					: undefined;
				try {
					const published = await publish({
						persist: { models: entry.models, checkedAt: entry.checkedAt },
						...(wrapped ? { update: wrapped } : {}),
					});
					return update ? applied : published;
				} catch (error) {
					if (isAbortLikeError(error)) return applied;
					throw error;
				}
			},
		};
	}

	const store = compat.store;
	if (store) {
		return {
			read() {
				return store.read();
			},
			async commit(entry, update) {
				await store.write(entry);
				update?.();
				return true;
			},
		};
	}

	if (!warnedUnsupportedContract) {
		warnedUnsupportedContract = true;
		logWarn(
			"This pi build exposes no model-cache contract; catalogs are kept in memory for this session only.",
		);
	}
	return {
		async read() {
			return undefined;
		},
		async commit(_entry, update) {
			update?.();
			return true;
		},
	};
}
