/**
 * URL transport policy and extension config file access.
 * No network I/O. Does not interpret API keys as config values.
 */

import { readFileSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { dirname, join } from "node:path";
import { normalizeInferenceBaseUrl } from "./catalog.js";
import type { InputHistoryScope } from "./input-history-store.js";
import {
	atomicWriteJson,
	ensureDirMode,
	envFlag,
	isPlainObject,
	LLMGATES_CONFIG_FILE,
	SECRET_DIR_MODE,
	withFileLock,
} from "./util.js";

export interface UrlValidationResult {
	ok: boolean;
	baseUrlInput?: string;
	inferenceBaseUrl?: string;
	error?: string;
}

export const CONFIG_FILE_NAME = LLMGATES_CONFIG_FILE;

export const BUILTIN_PROVIDER_IDS = new Set<string>([
	"amazon-bedrock",
	"ant-ling",
	"anthropic",
	"azure-openai-responses",
	"cerebras",
	"cloudflare-ai-gateway",
	"cloudflare-workers-ai",
	"deepseek",
	"fireworks",
	"github-copilot",
	"google",
	"google-vertex",
	"groq",
	"huggingface",
	"kimi-coding",
	"minimax",
	"minimax-cn",
	"mistral",
	"moonshotai",
	"moonshotai-cn",
	"nvidia",
	"openai",
	"openai-codex",
	"opencode",
	"opencode-go",
	"openrouter",
	"qwen-token-plan",
	"qwen-token-plan-cn",
	"radius",
	"together",
	"vercel-ai-gateway",
	"xai",
	"xiaomi",
	"xiaomi-token-plan-ams",
	"xiaomi-token-plan-cn",
	"xiaomi-token-plan-sgp",
	"zai",
	"zai-coding-cn",
	// Legacy Pi provider ID, intentionally reserved beyond the current builtin snapshot.
	"google-gemini-cli",
]);

// BlockList checks IPv4-mapped IPv6 (::ffff:127.0.0.1 and ::ffff:7f00:1) against the IPv4 rule.
const LOOPBACK_RANGES = new BlockList();
LOOPBACK_RANGES.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK_RANGES.addAddress("::1", "ipv6");

const LINK_LOCAL_V6 = new BlockList();
LINK_LOCAL_V6.addSubnet("fe80::", 10, "ipv6");

/** Accept localhost, 127/8, ::1, and IPv4-mapped loopback. */
export function isLoopbackHostname(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (host === "localhost") {
		return true;
	}
	try {
		return LOOPBACK_RANGES.check(host, host.includes(":") ? "ipv6" : "ipv4");
	} catch {
		// Not an IP literal (DNS name) — never loopback for transport policy.
		return false;
	}
}

function isPrivateOrLinkLocalIpLiteral(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	const version = isIP(host);
	if (version === 4) {
		const [a, b] = host.split(".").map((part) => Number.parseInt(part, 10));
		if (a === 10) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && b === 168) return true;
		if (a === 169 && b === 254) return true;
		if (a === 0) return true;
		return false;
	}
	if (version === 6) {
		try {
			if (LINK_LOCAL_V6.check(host, "ipv6")) return true;
		} catch {
			// Not a literal we can classify.
		}
		if (host.startsWith("fc") || host.startsWith("fd")) return true;
		if (host.startsWith("::ffff:")) {
			const mapped = host.slice("::ffff:".length);
			if (isIP(mapped) === 4) {
				return isPrivateOrLinkLocalIpLiteral(mapped);
			}
			const hexMapped = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(mapped);
			if (hexMapped) {
				const hi = Number.parseInt(hexMapped[1]!, 16);
				const lo = Number.parseInt(hexMapped[2]!, 16);
				const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
				if (isIP(dotted) === 4) {
					return isPrivateOrLinkLocalIpLiteral(dotted);
				}
			}
		}
		return false;
	}
	return false;
}

export function assertUrlTransportAllowed(
	input: string,
): { ok: true; url: URL } | { ok: false; error: string } {
	const trimmed = input.trim();
	if (!trimmed) {
		return { ok: false, error: "URL is empty" };
	}

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return { ok: false, error: "URL is not valid" };
	}

	if (url.username || url.password) {
		return { ok: false, error: "URL must not include credentials" };
	}

	const protocol = url.protocol.toLowerCase();
	if (protocol !== "https:" && protocol !== "http:") {
		return { ok: false, error: "URL must use http or https" };
	}

	const hostname = url.hostname;
	if (!hostname) {
		return { ok: false, error: "URL is missing hostname" };
	}

	if (protocol === "http:" && !isLoopbackHostname(hostname)) {
		return {
			ok: false,
			error: "remote HTTP is not allowed; use HTTPS or loopback HTTP",
		};
	}

	const bareHost = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (bareHost === "0.0.0.0" || bareHost === "::") {
		return { ok: false, error: "URL host is not allowed" };
	}

	if (
		envFlag("LLMGATES_BLOCK_PRIVATE_URLS") === true &&
		!isLoopbackHostname(hostname) &&
		isPrivateOrLinkLocalIpLiteral(hostname)
	) {
		return { ok: false, error: "URL host is a private or link-local address" };
	}

	return { ok: true, url };
}

export function normalizeAndValidateBaseUrl(
	input: string | undefined,
): UrlValidationResult {
	const trimmed = input?.trim();
	if (!trimmed) {
		return { ok: false, error: "baseUrl is empty" };
	}

	let raw = trimmed;
	if (!/^https?:\/\//i.test(raw)) {
		raw = `https://${raw}`;
	}

	const allowed = assertUrlTransportAllowed(raw);
	if (!allowed.ok) {
		return { ok: false, error: allowed.error.replace(/^URL/, "baseUrl") };
	}

	try {
		return {
			ok: true,
			baseUrlInput: allowed.url.toString(),
			inferenceBaseUrl: normalizeInferenceBaseUrl(allowed.url.toString()),
		};
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * `llmgates/config.json` — extension-level settings only. Gateway credentials
 * never live here: every gateway instance keeps its key in pi-owned auth.json
 * and its metadata in `llmgates/2api.json`.
 */
export interface LLMGatesConfigFile {
	/** When true (default), sync upstream retail prices for catalog entries. */
	pricingAutoUpdate?: boolean;
	/** When true (default), persist interactive input across pi processes. */
	inputHistory?: boolean;
	/** Which history file interactive input is persisted to. Default "cwd". */
	inputHistoryScope?: InputHistoryScope;
	/** When true (default), start every fresh session on the model last used. */
	restoreLastModel?: boolean;
	[key: string]: unknown;
}

export function loadValidatedConfigFile(agentDir: string): LLMGatesConfigFile {
	const configPath = join(agentDir, CONFIG_FILE_NAME);
	try {
		const raw = readFileSync(configPath, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!isPlainObject(parsed)) {
			throw new Error(`${CONFIG_FILE_NAME} must contain a JSON object`);
		}
		const config: LLMGatesConfigFile = { ...parsed };
		if (
			config.pricingAutoUpdate !== undefined &&
			typeof config.pricingAutoUpdate !== "boolean"
		) {
			throw new Error(
				`${CONFIG_FILE_NAME}.pricingAutoUpdate must be a boolean`,
			);
		}
		if (
			config.inputHistory !== undefined &&
			typeof config.inputHistory !== "boolean"
		) {
			throw new Error(`${CONFIG_FILE_NAME}.inputHistory must be a boolean`);
		}
		if (
			config.inputHistoryScope !== undefined &&
			config.inputHistoryScope !== "cwd" &&
			config.inputHistoryScope !== "global"
		) {
			throw new Error(
				`${CONFIG_FILE_NAME}.inputHistoryScope must be "cwd" or "global"`,
			);
		}
		if (
			config.restoreLastModel !== undefined &&
			typeof config.restoreLastModel !== "boolean"
		) {
			throw new Error(`${CONFIG_FILE_NAME}.restoreLastModel must be a boolean`);
		}
		return config;
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") {
			return {};
		}
		throw error;
	}
}

/** Env LLMGATES_PRICING_AUTO_UPDATE overrides llmgates/config.json. Default: true. */
export function resolvePricingAutoUpdate(agentDir: string): boolean {
	const env = envFlag("LLMGATES_PRICING_AUTO_UPDATE");
	if (env !== undefined) {
		return env;
	}
	try {
		const file = loadValidatedConfigFile(agentDir);
		if (typeof file.pricingAutoUpdate === "boolean") {
			return file.pricingAutoUpdate;
		}
	} catch {
		// fall through to default
	}
	return true;
}

export const RESTORE_LAST_MODEL_ENV = "LLMGATES_RESTORE_LAST_MODEL";

/**
 * Env LLMGATES_RESTORE_LAST_MODEL overrides llmgates/config.json. Default: true.
 *
 * Same precedence as `resolvePricingAutoUpdate`, and the same tolerance for a
 * malformed file: a hand edit must not be able to break session startup.
 */
export function resolveRestoreLastModel(agentDir: string): boolean {
	const env = envFlag(RESTORE_LAST_MODEL_ENV);
	if (env !== undefined) {
		return env;
	}
	try {
		const file = loadValidatedConfigFile(agentDir);
		if (typeof file.restoreLastModel === "boolean") {
			return file.restoreLastModel;
		}
	} catch {
		// fall through to default
	}
	return true;
}

export const INPUT_HISTORY_ENV = "LLMGATES_INPUT_HISTORY";
export const INPUT_HISTORY_SCOPE_ENV = "LLMGATES_INPUT_HISTORY_SCOPE";

/** Where an effective setting came from, so /input-history can explain itself. */
export type SettingSource = "env" | "config" | "default";

export interface InputHistorySettings {
	enabled: boolean;
	enabledSource: SettingSource;
	scope: InputHistoryScope;
	scopeSource: SettingSource;
}

/**
 * Unrecognized values fall through to config/default, matching `envFlag`'s tri-state.
 * A value that does not win must not be reported as an override either — see
 * `resolveInputHistorySettings`.
 */
function envScope(env: NodeJS.ProcessEnv = process.env): InputHistoryScope | undefined {
	const raw = env[INPUT_HISTORY_SCOPE_ENV]?.trim().toLowerCase();
	if (raw === "cwd" || raw === "global") return raw;
	return undefined;
}

/**
 * env > llmgates/config.json > default, the same precedence `resolvePricingAutoUpdate`
 * uses. Defaults are ON and "cwd": pi already stores every user message in a per-cwd
 * session file, so persisting input at the same granularity adds aggregation but no
 * new cross-project exposure. "global" is the only option that does, so it stays an
 * explicit opt-in.
 *
 * A malformed config file falls back to the defaults rather than throwing, so a hand
 * edit cannot make the editor un-installable.
 */
export function resolveInputHistorySettings(agentDir: string): InputHistorySettings {
	const envEnabled = envFlag(INPUT_HISTORY_ENV);
	const envScopeValue = envScope();

	let fileEnabled: boolean | undefined;
	let fileScope: InputHistoryScope | undefined;
	try {
		const file = loadValidatedConfigFile(agentDir);
		if (typeof file.inputHistory === "boolean") fileEnabled = file.inputHistory;
		if (file.inputHistoryScope === "cwd" || file.inputHistoryScope === "global") {
			fileScope = file.inputHistoryScope;
		}
	} catch {
		// fall through to defaults
	}

	return {
		enabled: envEnabled ?? fileEnabled ?? true,
		enabledSource:
			envEnabled !== undefined ? "env" : fileEnabled !== undefined ? "config" : "default",
		scope: envScopeValue ?? fileScope ?? "cwd",
		scopeSource:
			envScopeValue !== undefined ? "env" : fileScope !== undefined ? "config" : "default",
	};
}

/**
 * Merge `patch` into llmgates/config.json under the file lock.
 *
 * A config file that fails validation makes this throw WITHOUT writing: overwriting
 * an unparseable file with a "clean" object would silently drop whatever else the
 * user has in there (`pricingAutoUpdate`, unknown keys kept by `loadValidatedConfigFile`).
 * Only command handlers call this — never the history persistence path, which must
 * not take a second file lock.
 */
export async function updateConfigFile(
	agentDir: string,
	patch: Partial<LLMGatesConfigFile>,
): Promise<void> {
	const configPath = join(agentDir, CONFIG_FILE_NAME);
	ensureDirMode(dirname(configPath), SECRET_DIR_MODE);
	await withFileLock(configPath, () => {
		const config = loadValidatedConfigFile(agentDir);
		atomicWriteJson(configPath, { ...config, ...patch });
	});
}
