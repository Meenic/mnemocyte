import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const sourceAlias = [
	{
		find: "mnemocyte/embedders/openai",
		replacement: resolve("src/embedders/openai.ts"),
	},
	{ find: "mnemocyte", replacement: resolve("src/index.ts") },
];
const packageAlias = [
	{
		find: "mnemocyte/embedders/openai",
		replacement: resolve("dist/embedders/openai.mjs"),
	},
	{ find: "mnemocyte", replacement: resolve("dist/index.mjs") },
];

export default defineConfig({
	test: {
		environment: "node",
		projects: [
			{
				extends: true,
				resolve: {
					alias: sourceAlias,
				},
				test: {
					name: "unit",
					include: ["test/**/*.test.ts"],
					exclude: [
						"test/integration/**",
						"test/package/**",
						"test/benchmarks/**",
					],
					typecheck: {
						tsconfig: "tsconfig.test.json",
					},
				},
			},
			{
				extends: true,
				resolve: {
					alias: sourceAlias,
				},
				test: {
					name: "integration",
					include: ["test/integration/**/*.test.ts"],
					fileParallelism: false,
					testTimeout: 60_000,
					typecheck: {
						tsconfig: "tsconfig.test.json",
					},
				},
			},
			{
				extends: true,
				resolve: {
					alias: packageAlias,
				},
				test: {
					name: "package",
					include: ["test/package/exports.test.ts"],
					typecheck: {
						tsconfig: "test/package/tsconfig.json",
						include: ["test/package/exports-types.test-d.ts"],
					},
				},
			},
		],
	},
});
