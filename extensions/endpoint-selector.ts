/**
 * /endpoint-setting selector rendering + parsing (pure functions, no UI, no I/O).
 *
 * Spec: docs/superpowers/specs/2026-07-29-endpoint-interactive-design.md (rev 6) §4.3/§4.4.
 *
 * Step 1 is a checklist rendered into `ui.editor`; the user flips `[ ]` to `[x]`
 * and the edited text comes back here to be parsed. Model IDs are resolved against
 * the SAME snapshot that produced the text (frozen id→provider map), never by
 * prefix or fuzzy matching, so a hand-edited ID can only ever be rejected — it can
 * never silently retarget a different model.
 */

/** pi `api` → the endpoint word shown in the checklist and accepted by /endpoint. */
const API_TO_ENDPOINT_LABEL: Record<string, string> = {
	"openai-completions": "chat",
	"anthropic-messages": "messages",
	"openai-responses": "responses",
};

export function endpointLabelForApi(api: string): string {
	return API_TO_ENDPOINT_LABEL[api] ?? api;
}

export interface SelectorModelRow {
	id: string;
	name: string;
	/** Current effective endpoint word (already resolved from the registry `api`). */
	endpoint: string;
	/** True when this model has an explicit per-model override on disk. */
	hasOverride: boolean;
}

export interface SelectorGroup {
	/** pi provider id — the write target for every row in this group. */
	providerId: string;
	/** Ownership label shown in the group header, e.g. "core" or "2API/cpa". */
	label: string;
	models: SelectorModelRow[];
}

export interface SelectorUnmanaged {
	total: number;
	/** Per-provider counts, already sorted by the caller (largest first). */
	byProvider: ReadonlyArray<{ providerId: string; count: number }>;
}

export interface SelectorSnapshot {
	groups: SelectorGroup[];
	unmanaged: SelectorUnmanaged;
}

export interface SelectorSelection {
	modelId: string;
	providerId: string;
}

export interface SelectorParseResult {
	selected: SelectorSelection[];
	/** Checked IDs that are not in the managed snapshot, with the reason. */
	rejected: string[];
	/** Lines that look like entries but could not be parsed. Never fatal. */
	warnings: string[];
}

const HEADER_LINES = [
	"# /endpoint-setting · 在要修改的模型前把 [ ] 改成 [x]，保存后进入下一步",
	"# 格式: [ ] <model-id>  <显示名>  <当前出口>       * = 已有 override",
	"# 以 # 开头的行会被忽略；不要修改 model-id",
];

const UNMANAGED_HEADER = "# ── 本扩展不管辖（无 api 写入通道，不可配置）──";

function padEnd(value: string, width: number): string {
	return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/** Render the checklist prefilled into `ui.editor`. Deterministic, no I/O. */
export function renderSelectorList(snapshot: SelectorSnapshot): string {
	const lines: string[] = [...HEADER_LINES];
	const idWidth = Math.max(
		12,
		...snapshot.groups.flatMap((group) => group.models.map((model) => model.id.length)),
	);
	const nameWidth = Math.max(
		8,
		...snapshot.groups.flatMap((group) => group.models.map((model) => model.name.length)),
	);

	for (const group of snapshot.groups) {
		lines.push("");
		lines.push(`# ── ${group.providerId} · ${group.label} ──`);
		for (const model of group.models) {
			const marker = model.hasOverride ? " *" : "";
			lines.push(
				`[ ] ${padEnd(model.id, idWidth)}  ${padEnd(model.name, nameWidth)}  ${model.endpoint}${marker}`,
			);
		}
	}

	if (snapshot.unmanaged.total > 0) {
		const detail = snapshot.unmanaged.byProvider
			.map((entry) => `${entry.providerId}(${entry.count})`)
			.join(", ");
		lines.push("");
		lines.push(UNMANAGED_HEADER);
		lines.push(
			`# 另有 ${snapshot.unmanaged.total} 个模型属其他 provider${detail ? `: ${detail}` : ""}，本扩展无法配置`,
		);
	}

	return `${lines.join("\n")}\n`;
}

/** `[x] id ...` / `[X] id ...` / `[ ] id ...` — capture the checkbox state and the id. */
const ENTRY_PATTERN = /^\[([ xX])\]\s+(\S+)(?:\s.*)?$/;

/** `# ── <providerId> · <label> ──` — the group header emitted by the renderer. */
const GROUP_HEADER_PATTERN = /^#\s*──\s*(\S+)\s*·/;

/**
 * Parse the edited checklist back into a selection, resolving every checked ID
 * against `snapshot`. Unknown IDs are rejected with a reason (never ignored);
 * unparseable lines become warnings without aborting the rest.
 *
 * Resolution is GROUP-AWARE. The same model id can legitimately exist under two
 * providers — a 2API relay commonly re-exports the same upstream ids that core
 * serves — and their rendered rows are visually identical, so only the enclosing
 * group header tells them apart. Binding such an id to whichever group happened
 * to come first would write the override to the WRONG provider's file and leave
 * the other provider's model permanently unreachable from the selector, all while
 * reporting success. Each row is therefore attributed to the group header above
 * it, and an id that is still ambiguous is rejected with an explanation rather
 * than guessed.
 */
export function parseSelectorList(text: string, snapshot: SelectorSnapshot): SelectorParseResult {
	const providersById = new Map<string, string[]>();
	for (const group of snapshot.groups) {
		for (const model of group.models) {
			const providers = providersById.get(model.id);
			if (!providers) providersById.set(model.id, [group.providerId]);
			else if (!providers.includes(group.providerId)) providers.push(group.providerId);
		}
	}
	const knownProviders = new Set(snapshot.groups.map((group) => group.providerId));

	const selected: SelectorSelection[] = [];
	const rejected: string[] = [];
	const warnings: string[] = [];
	const seen = new Set<string>();
	// Which group's rows we are currently inside. Reset by any other comment line
	// (the unmanaged summary) so rows can never inherit a stale group.
	let currentProvider: string | undefined;

	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		if (line.startsWith("#")) {
			const header = GROUP_HEADER_PATTERN.exec(line)?.[1];
			currentProvider = header && knownProviders.has(header) ? header : undefined;
			continue;
		}

		const match = ENTRY_PATTERN.exec(line);
		if (!match) {
			warnings.push(line);
			continue;
		}
		if (match[1] === " ") continue;

		const modelId = match[2]!;
		const candidates = providersById.get(modelId);
		if (!candidates) {
			rejected.push(`${modelId}（不在本扩展管辖的模型集合内，无 api 写入通道）`);
			continue;
		}

		const providerId =
			currentProvider && candidates.includes(currentProvider)
				? currentProvider
				: candidates.length === 1
					? candidates[0]!
					: undefined;
		if (!providerId) {
			rejected.push(
				`${modelId}（同时存在于 ${candidates.join(" / ")}，无法判断目标；请保留分组标题行，或用 /endpoint 精确指定）`,
			);
			continue;
		}

		// Keyed by provider as well: the same id under two providers is two targets.
		const key = `${providerId}\u0000${modelId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		selected.push({ modelId, providerId });
	}

	return { selected, rejected, warnings };
}

export type SelectorEndpointChoice = "chat" | "messages" | "responses" | "auto";

/** Step 2 options; the pi `api` each maps to is spelled out so the user can judge. */
export const SELECTOR_ENDPOINT_OPTIONS: ReadonlyArray<{
	choice: SelectorEndpointChoice;
	label: string;
}> = [
	{ choice: "chat", label: "chat       → openai-completions" },
	{ choice: "messages", label: "messages   → anthropic-messages" },
	{ choice: "responses", label: "responses  → openai-responses" },
	{ choice: "auto", label: "auto       → 清除 override，回落默认" },
];

export function parseSelectorEndpointChoice(
	label: string | undefined,
): SelectorEndpointChoice | undefined {
	if (!label) return undefined;
	return SELECTOR_ENDPOINT_OPTIONS.find((option) => option.label === label)?.choice;
}
