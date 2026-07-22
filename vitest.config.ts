import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// Pure tests import catalog.ts only (no pi-coding-agent) — keep isolation minimal.
		isolate: false,
		testTimeout: 10_000,
	},
});
