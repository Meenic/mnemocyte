import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const sourceAlias = [
	{
		find: /^mnemocyte\/stores\/(.+)$/,
		replacement: resolve("src/stores/$1.ts"),
	},
	{ find: "mnemocyte/postgres", replacement: resolve("src/postgres.ts") },
	{ find: "mnemocyte/ai-sdk", replacement: resolve("src/ai-sdk.ts") },
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

// `POSTGRES_JS=3` runs the integration project on postgres.js 3.x (the
// `postgres-3` alias) instead of the 4.x dev dependency; CI runs both.
const postgresJsAlias =
	process.env.POSTGRES_JS === "3"
		? [{ find: /^postgres$/, replacement: "postgres-3" }]
		: [];

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
						"test/contract/**",
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
					// The shared Postgres contract on PGlite: no database service needed.
					name: "contract",
					include: ["test/contract/**/*.test.ts"],
					testTimeout: 60_000,
				},
			},
			{
				resolve: {
					alias: [...sourceAlias, ...postgresJsAlias],
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
				},
			},
		],
	},
});
