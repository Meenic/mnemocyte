import { defineConfig } from "vitest/config";

// The loader's own functions on temporary folders. Each bin's package tests
// run it from the built dist/.
export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
	},
});
