import { defineConfig } from "vitest/config";

// The release scripts over fixture changelogs in temporary folders.
export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
	},
});
