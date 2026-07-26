/**
 * Config I/O helpers. Connection ownership lives in connection.ts; network in http.ts.
 */

import { dirname, join } from "node:path";
import * as lockfile from "proper-lockfile";
import {
	CONFIG_FILE_NAME,
	loadValidatedConfigFile,
	type LLMGatesConfigFile,
} from "./connection.js";
import {
	atomicWriteJson,
	createFileIfMissingMode,
	ensureDirMode,
	LOCK_OPTIONS,
	SECRET_DIR_MODE,
	SECRET_FILE_MODE,
} from "./util.js";

export const CREDENTIAL_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;

export type { LLMGatesConfigFile };

async function withConfigLock<T>(agentDir: string, fn: (configPath: string) => Promise<T> | T): Promise<T> {
	const configPath = join(agentDir, CONFIG_FILE_NAME);
	ensureDirMode(dirname(configPath), SECRET_DIR_MODE);
	const release = await lockfile.lock(configPath, LOCK_OPTIONS);
	try {
		createFileIfMissingMode(configPath, "{}\n", SECRET_FILE_MODE);
		return await fn(configPath);
	} finally {
		await release();
	}
}

function mergeConfigPreservingSecrets(
	existing: LLMGatesConfigFile,
	patch: { baseUrl?: string; providerId?: string; providerName?: string },
): LLMGatesConfigFile {
	const next: LLMGatesConfigFile = { ...existing };

	if (patch.baseUrl !== undefined) {
		next.baseUrl = patch.baseUrl;
	}
	if (patch.providerId !== undefined) {
		next.providerId = patch.providerId;
	}
	if (patch.providerName !== undefined) {
		next.providerName = patch.providerName;
	}

	if (typeof existing.apiKey === "string" && existing.apiKey.length > 0) {
		// Never accept apiKey from login patch. Preserve existing ambient file key only.
		next.apiKey = existing.apiKey;
	} else {
		delete next.apiKey;
	}

	return next;
}

export async function saveConfigFilePreservingSecrets(
	agentDir: string,
	patch: { baseUrl?: string; providerId?: string; providerName?: string },
): Promise<void> {
	await withConfigLock(agentDir, () => {
		let existing: LLMGatesConfigFile = {};
		try {
			existing = loadValidatedConfigFile(agentDir);
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			if (err.code !== "ENOENT") {
				// If file exists but is invalid, fail closed rather than overwrite.
				throw error;
			}
		}
		const next = mergeConfigPreservingSecrets(existing, patch);
		atomicWriteJson(join(agentDir, CONFIG_FILE_NAME), next, {
			fileMode: SECRET_FILE_MODE,
			dirMode: SECRET_DIR_MODE,
		});
	});
}
