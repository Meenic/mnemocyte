import { defineConfig } from "vitest/config";

// `mnemocyte` resolves to its built dist/ through the workspace link, the
// public API an app sees. The bin tests run the built dist/cli.mjs.
export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		testTimeout: 30_000,
	},
});
