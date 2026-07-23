import type {
	Credential,
	CredentialInfo,
	CredentialStore,
} from "@earendil-works/pi-ai";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

function readCredentialMap(path: string): Record<string, Credential> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("auth.json must contain an object");
		}
		return parsed as Record<string, Credential>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

export class DiskMergingCredentialStore implements CredentialStore {
	readonly path: string;
	private data: Record<string, Credential>;

	constructor(agentDir: string) {
		this.path = join(agentDir, "auth.json");
		this.data = readCredentialMap(this.path);
	}

	async read(providerId: string): Promise<Credential | undefined> {
		return this.data[providerId];
	}

	async list(): Promise<readonly CredentialInfo[]> {
		return Object.entries(this.data).map(([providerId, credential]) => ({
			providerId,
			type: credential.type,
		}));
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		const current = readCredentialMap(this.path);
		const next = await fn(current[providerId]);
		if (next !== undefined) {
			current[providerId] = next;
			mkdirSync(dirname(this.path), { recursive: true });
			writeFileSync(this.path, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
		}
		this.data = current;
		return next ?? current[providerId];
	}

	async delete(providerId: string): Promise<void> {
		const current = readCredentialMap(this.path);
		delete current[providerId];
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileSync(this.path, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
		this.data = current;
	}
}
