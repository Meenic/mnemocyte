import { readFileSync } from "node:fs";
import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { createPackedConsumer } from "./packed-consumer.js";

async function expectPathMissing(path: string): Promise<void> {
	await expect(access(path)).rejects.toThrow();
}

/** Every file reached from `entry` through relative static imports. */
async function staticImportGraph(entry: string): Promise<Set<string>> {
	const reached = new Set<string>();
	const pending = [entry];
	for (let file = pending.pop(); file; file = pending.pop()) {
		if (reached.has(file)) {
			continue;
		}
		reached.add(file);
		const source = await readFile(file, "utf8");
		for (const match of source.matchAll(
			/^import\s+(?:[^"']+\s+from\s+)?["'](\.{1,2}\/[^"']+)["'];?\s*$/gm,
		)) {
			pending.push(resolve(dirname(file), match[1] ?? ""));
		}
	}
	return reached;
}

describe("lazy Postgres package loading", () => {
	test("declares no runtime dependencies and marks database packages as optional peers", async () => {
		const manifest = JSON.parse(
			await readFile(resolve("package.json"), "utf8"),
		);

		expect(manifest.dependencies).toBeUndefined();
		const peers = [
			"@electric-sql/pglite",
			"@libsql/client",
			"ai",
			"drizzle-orm",
			"pg",
			"postgres",
			"vitest",
		];
		expect(Object.keys(manifest.peerDependencies).sort()).toEqual(peers);
		for (const peer of peers) {
			expect(manifest.peerDependenciesMeta[peer].optional).toBe(true);
		}
	});

	test.each([
		"dist/index.mjs",
		"dist/postgres.mjs",
		"dist/libsql.mjs",
		"dist/store.mjs",
		"dist/store-test.mjs",
	])(
		"keeps database packages out of the static import graph of %s",
		async (entry) => {
			for (const file of await staticImportGraph(resolve(entry))) {
				const source = await readFile(file, "utf8");
				expect(source, file).not.toMatch(
					/^import\s+(?:[^"']+\s+from\s+)?["'](?:drizzle-orm(?:\/[^"']*)?|postgres|pg|@electric-sql\/pglite(?:\/[^"']*)?|@libsql\/[^"']*|libsql)["'];?\s*$/m,
				);
			}
		},
	);

	test.each([
		"dist/index.mjs",
		"dist/postgres.mjs",
		"dist/libsql.mjs",
		"dist/embedders/index.mjs",
		"dist/embedders/voyage.mjs",
		"dist/embedders/cohere.mjs",
		"dist/embedders/google.mjs",
		"dist/store.mjs",
		"dist/store-test.mjs",
	])("keeps ai out of the static import graph of %s", async (entry) => {
		for (const file of await staticImportGraph(resolve(entry))) {
			const source = await readFile(file, "utf8");
			expect(source, file).not.toMatch(
				/^import\s+(?:[^"']+\s+from\s+)?["']ai(?:\/[^"']*)?["'];?\s*$/m,
			);
		}
	});

	test.each(
		Object.entries(
			JSON.parse(readFileSync(resolve("package.json"), "utf8"))
				.exports as Record<string, string | { default: string }>,
		)
			.filter(([key]) => key !== "./store/test" && key !== "./package.json")
			.map(([, target]) =>
				typeof target === "string" ? target : target.default,
			),
	)("keeps vitest out of the static import graph of %s", async (entry) => {
		for (const file of await staticImportGraph(resolve(entry))) {
			const source = await readFile(file, "utf8");
			expect(source, file).not.toMatch(
				/^import\s+(?:[^"']+\s+from\s+)?["']vitest(?:\/[^"']*)?["'];?\s*$/m,
			);
		}
	});

	test("imports vitest statically from the store/test entry only", async () => {
		const source = await readFile(resolve("dist/store-test.mjs"), "utf8");
		expect(source).toMatch(/^import\s+[^"']+\s+from\s+["']vitest["'];?\s*$/m);
	});

	test("imports ai statically from the ai-sdk entry only", async () => {
		const source = await readFile(resolve("dist/ai-sdk.mjs"), "utf8");
		expect(source).toMatch(/^import\s+[^"']+\s+from\s+["']ai["'];?\s*$/m);
	});

	test("keeps the Postgres backend out of the root entry's static imports", async () => {
		// Follow every relative static import from dist/index.mjs. The backend
		// (queries, migration runner, driver adapters) must only be reachable
		// through the dynamic import() that createMemory({ store: client })
		// runs on first use. That import() sits in whichever chunk holds
		// resolveStore: the root entry itself, or a chunk it shares with the
		// bin.
		const reached = await staticImportGraph(resolve("dist/index.mjs"));
		const sources = await Promise.all(
			[...reached].map((file) => readFile(file, "utf8")),
		);
		expect(
			sources.filter((source) =>
				/\bimport\(["']\.\/postgres-backend-[^"']+\.mjs["']\)/.test(source),
			),
		).toHaveLength(1);
		expect(
			[...reached].filter((file) =>
				basename(file).startsWith("postgres-backend-"),
			),
		).toEqual([]);
		// The libSQL backend loads the same way.
		expect(
			sources.filter((source) =>
				/\bimport\(["']\.\/libsql-backend-[^"']+\.mjs["']\)/.test(source),
			),
		).toHaveLength(1);
		expect(
			[...reached].filter((file) =>
				basename(file).startsWith("libsql-backend-"),
			),
		).toEqual([]);
		for (const file of reached) {
			const source = await readFile(file, "utf8");
			expect(source, file).not.toMatch(
				/\bCREATE TABLE\b|\bfunction createPostgresStore\b|\bfunction createLibsqlStore\b/,
			);
		}
	});

	test("runs an in-memory client from the packed package with database packages absent", async () => {
		const packed = await createPackedConsumer();
		try {
			const consumer = packed.dir;
			const nodeModules = packed.nodeModules;
			const [packedFreshInstall, sourceFreshInstall] = await Promise.all([
				readFile(
					join(nodeModules, "mnemocyte", "migrations", "fresh-install.sql"),
				),
				readFile(resolve("migrations", "fresh-install.sql")),
			]);
			expect(packedFreshInstall).toEqual(sourceFreshInstall);
			// Only the SQL ships from migrations/; the template, the journal
			// and the old renderer stay in the repository.
			const packedRoot = packed.packageDir;
			expect((await readdir(join(packedRoot, "migrations"))).sort()).toEqual(
				(await readdir(resolve("migrations")))
					.filter((name) => name.endsWith(".sql"))
					.sort(),
			);
			await Promise.all([
				expectPathMissing(join(packedRoot, "dist", "cli.d.mts")),
				expectPathMissing(join(packedRoot, "dist", "stores")),
			]);

			const drivers = [
				"drizzle-orm",
				"postgres",
				"pg",
				"@electric-sql",
				"@libsql",
				"libsql",
				"ai",
			];
			await Promise.all(
				drivers.flatMap((driver) => [
					expectPathMissing(join(nodeModules, driver)),
					expectPathMissing(
						join(nodeModules, "mnemocyte", "node_modules", driver),
					),
				]),
			);

			const script = join(consumer, "in-memory.mjs");
			await writeFile(
				script,
				`
						import { createMemory } from "mnemocyte";

						const client = createMemory({
							embedder: {
								model: "packed-in-memory",
								dimensions: 2,
								async embed(texts) {
									return texts.map((text) => [text.length, 1]);
								},
							},
						});
						const memory = await client.add({
							scope: { namespace: "packed", entityId: "packed-consumer" },
							content: "Database packages are absent.",
						});
						const recalled = await client.search({
							scope: { namespace: "packed", entityId: "packed-consumer" },
							query: "absent database packages",
							minScore: 0,
						});
						if (memory.scope.entityId !== "packed-consumer" || recalled.length !== 1) {
							throw new Error("Packed in-memory client returned unexpected data.");
						}
						process.stdout.write("packed-in-memory-ok");
					`,
				"utf8",
			);

			const { stdout } = await packed.run(script);
			expect(stdout).toBe("packed-in-memory-ok");

			// CommonJS: require(esm) fails with ERR_REQUIRE_ASYNC_MODULE if any
			// module in the graph uses top-level await. A client passed as store
			// loads the Postgres chunk on first use, from require() as well.
			const cjsScript = join(consumer, "client-store.cjs");
			await writeFile(
				cjsScript,
				`
						const { createMemory } = require("mnemocyte");

						const statements = [];
						const executor = {
							async query(sql) {
								statements.push(sql);
								return [];
							},
							async transaction(fn) {
								return fn(executor);
							},
						};
						const memory = createMemory({
							store: executor,
							embedder: {
								model: "packed-client-store",
								dimensions: 2,
								async embed(texts) {
									return texts.map((text) => [text.length, 1]);
								},
							},
						});
						if (statements.length !== 0) {
							throw new Error("createMemory queried the database.");
						}
						memory
							.get({ scope: { namespace: "packed", entityId: "cjs" }, key: "missing" })
							.then((found) => {
								if (found !== null || !statements.some((sql) => sql.includes("mnemocyte_memories"))) {
									throw new Error("The lazily loaded Postgres store did not run.");
								}
								process.stdout.write("packed-client-store-ok");
							})
							.catch((error) => {
								process.stderr.write(String(error && error.stack));
								process.exitCode = 1;
							});
					`,
				"utf8",
			);
			const cjs = await packed.run(cjsScript);
			expect(cjs.stdout).toBe("packed-client-store-ok");

			// The manifest is exported, so tools can read the installed version
			// with require() and with a JSON import.
			const { name, version } = JSON.parse(
				await readFile(resolve("package.json"), "utf8"),
			);
			const manifestCjs = join(consumer, "manifest.cjs");
			await writeFile(
				manifestCjs,
				`const { name, version } = require("mnemocyte/package.json");
process.stdout.write(name + "@" + version);`,
				"utf8",
			);
			const manifestMjs = join(consumer, "manifest.mjs");
			await writeFile(
				manifestMjs,
				`import manifest from "mnemocyte/package.json" with { type: "json" };
process.stdout.write(manifest.name + "@" + manifest.version);`,
				"utf8",
			);
			for (const script of [manifestCjs, manifestMjs]) {
				const manifest = await packed.run(script);
				expect(manifest.stdout).toBe(`${name}@${version}`);
			}

			// With the ai peer installed, the subpath embeds through an AI SDK
			// model and throws the root entry's error classes.
			await packed.linkAi();
			const aiSdkScript = join(consumer, "ai-sdk.mjs");
			await writeFile(
				aiSdkScript,
				`
						import { APICallError } from "ai";
						import { generateText } from "ai";
						import { MockEmbeddingModelV4, MockLanguageModelV4 } from "ai/test";
						import { createMemory, ProviderError } from "mnemocyte";
						import { aiSdkEmbedder, extractMemories, memoryTools, withMemory } from "mnemocyte/ai-sdk";

						const model = new MockEmbeddingModelV4({
							modelId: "packed-model",
							maxEmbeddingsPerCall: null,
							doEmbed: async ({ values }) => ({
								embeddings: values.map((value) => [value.length, 1]),
								warnings: [],
							}),
						});
						const memory = createMemory({
							embedder: aiSdkEmbedder({ model, dimensions: 2 }),
						});
						await memory.add({
							scope: { namespace: "packed", entityId: "ai-sdk" },
							content: "Embedded through the AI SDK.",
						});
						const tools = memoryTools({
							memory: memory.for({ namespace: "packed", entityId: "ai-sdk" }),
						});
						const found = await tools.searchMemories.execute(
							{ query: "AI SDK" },
							{ toolCallId: "call", messages: [] },
						);
						if (found.memories[0]?.content !== "Embedded through the AI SDK.") {
							throw new Error("searchMemories did not find the memory.");
						}
						const languageModel = new MockLanguageModelV4({
							doGenerate: {
								content: [{ type: "text", text: "ok" }],
								finishReason: { unified: "stop", raw: undefined },
								usage: {
									inputTokens: { total: 1, noCache: 1 },
									outputTokens: { total: 1, text: 1 },
								},
								warnings: [],
							},
						});
						await generateText({
							model: withMemory({
								model: languageModel,
								memory: memory.for({ namespace: "packed", entityId: "ai-sdk" }),
							}),
							prompt: "What about the AI SDK?",
						});
						const sent = JSON.stringify(languageModel.doGenerateCalls[0]?.prompt);
						if (!sent.includes("Embedded through the AI SDK.")) {
							throw new Error("withMemory did not add the memory context.");
						}
						const extracted = await extractMemories({
							model: new MockLanguageModelV4({
								doGenerate: {
									content: [
										{
											type: "text",
											text: JSON.stringify({
												memories: [
													{
														key: "sdk",
														content: "Uses the AI SDK.",
														kind: "fact",
														importance: "normal",
													},
												],
											}),
										},
									],
									finishReason: { unified: "stop", raw: undefined },
									usage: {
										inputTokens: { total: 1, noCache: 1 },
										outputTokens: { total: 1, text: 1 },
									},
									warnings: [],
								},
							}),
							memory: memory.for({ namespace: "packed", entityId: "ai-sdk" }),
							prompt: [{ role: "user", content: [{ type: "text", text: "I use the AI SDK." }] }],
							text: "Nice.",
						});
						if (extracted[0]?.key !== "extracted:sdk") {
							throw new Error("extractMemories did not store the memory.");
						}
						const failing = aiSdkEmbedder({
							model: new MockEmbeddingModelV4({
								modelId: "packed-model",
								doEmbed: async () => {
									throw new APICallError({
										message: "busy",
										url: "https://provider.test",
										requestBodyValues: {},
										statusCode: 503,
									});
								},
							}),
							dimensions: 2,
						});
						const error = await failing
							.embed(["x"], { purpose: "query" })
							.catch((caught) => caught);
						if (!(error instanceof ProviderError) || error.status !== 503) {
							throw new Error("The AI SDK error did not become the root ProviderError.");
						}
						process.stdout.write("packed-ai-sdk-ok");
					`,
				"utf8",
			);
			const aiSdk = await packed.run(aiSdkScript);
			expect(aiSdk.stdout).toBe("packed-ai-sdk-ok");
		} finally {
			await packed.remove();
		}
	}, 30_000);
});
