import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("extension entrypoints", () => {
	it("registers /balance only from index.ts to preserve legacy fail-closed", () => {
		const pkg = JSON.parse(
			readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"),
		) as { pi?: { extensions?: string[] } };
		expect(pkg.pi?.extensions).toContain("./extensions/index.ts");
		expect(pkg.pi?.extensions).not.toContain("./extensions/balance.ts");
	});
});
