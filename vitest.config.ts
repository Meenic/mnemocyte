import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const sourceAlias = [
	{
		find: /^mnemocyte\/stores\/(.+)$/,
		replacement: resolve("src/stores/$1.ts"),
	},
	{ find: "mnemocyte/postgres", replacement: resolve("src/postgres.ts") },
	{
		find: /^mnemocyte\/embedders\/(.+)$/,
		replacement: resolve("src/embedders/$1.ts"),
	},
	{
		find: "mnemocyte/embedders",
		replacement: resolve("src/embedders/index.ts"),
	},
	{ find: "mnemocyte", replacement: resolve("src/index.ts") },
];

export default defineConfig({
	test: {
		benchmark: {
			include: ["test/benchmarks/**/*.bench.ts"],
		},
		projects: [
			{
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
				},
			},
			{
				resolve: {
					alias: sourceAlias,
				},
				test: {
					name: "integration",
					include: ["test/integration/**/*.test.ts"],
					fileParallelism: false,
					testTimeout: 60_000,
				},
			},
			{
				test: {
					name: "package",
					include: ["test/package/*.test.ts"],
					typecheck: {
						tsconfig: "test/package/tsconfig.json",
						include: ["test/package/exports-types.test-d.ts"],
					},
				},
			},
		],
	},
});
