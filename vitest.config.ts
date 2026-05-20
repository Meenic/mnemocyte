import { resolve } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

const isPackageMode = process.env.TEST_PACKAGE === "1";

export default defineConfig({
	resolve: {
		alias: isPackageMode
			? { mnemocyte: resolve("dist/index.mjs") }
			: { mnemocyte: resolve("src/index.ts") },
	},
	test: {
		environment: "node",
		include: [...configDefaults.include, "test/**/*.test.mjs"],
	},
});
