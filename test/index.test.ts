import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("extension entrypoints", () => {
	it("owns core, balance, and compat registration in one entrypoint", () => {
		const root = join(import.meta.dirname, "..");
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
			pi?: { extensions?: string[] };
		};
		const entrypoint = readFileSync(join(root, "extensions", "index.ts"), "utf8");

		expect(pkg.pi?.extensions).toContain("./extensions/index.ts");
		expect(pkg.pi?.extensions).not.toContain("./extensions/balance.ts");
		expect(pkg.pi?.extensions).not.toContain("./extensions/compat/index.ts");
		expect(entrypoint).toMatch(/registerCompatGateways/);
		expect(entrypoint).toMatch(/onModelsChanged/);
		expect(entrypoint).not.toMatch(/modelCount > 0/);
	});
});
