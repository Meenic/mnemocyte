import { exec, execFile } from "node:child_process";
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

async function expectPathMissing(path: string): Promise<void> {
	await expect(access(path)).rejects.toThrow();
}

async function packPackage(tarball: string): Promise<void> {
	const options = {
		cwd: resolve("."),
		windowsHide: true,
	};
	if (process.platform === "win32") {
		const pnpmCli = join(
			dirname(process.execPath),
			"node_modules",
			"corepack",
			"dist",
			"pnpm.js",
		);
		try {
			await access(pnpmCli);
			await execFileAsync(
				process.execPath,
				[pnpmCli, "pack", "--out", tarball],
				options,
			);
		} catch {
			await execAsync(`pnpm pack --out "${tarball}"`, options);
		}
		return;
	}
	await execFileAsync("pnpm", ["pack", "--out", tarball], options);
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
			"ai",
			"drizzle-orm",
			"pg",
			"postgres",
		];
		expect(Object.keys(manifest.peerDependencies).sort()).toEqual(peers);
		for (const peer of peers) {
			expect(manifest.peerDependenciesMeta[peer].optional).toBe(true);
		}
	});

	test.each(["dist/index.mjs", "dist/postgres.mjs", "dist/stores/drizzle.mjs"])(
		"keeps database packages out of the static imports of %s",
		async (entry) => {
			const source = await readFile(resolve(entry), "utf8");

			expect(source).not.toMatch(
				/^import\s+(?:[^"']+\s+from\s+)?["'](?:drizzle-orm(?:\/[^"']*)?|postgres|pg|@electric-sql\/pglite(?:\/[^"']*)?)["'];?\s*$/m,
			);
		},
	);

	test.each([
		"dist/index.mjs",
		"dist/postgres.mjs",
		"dist/embedders/index.mjs",
		"dist/stores/drizzle.mjs",
	])("keeps ai out of the static import graph of %s", async (entry) => {
		for (const file of await staticImportGraph(resolve(entry))) {
			const source = await readFile(file, "utf8");
			expect(source, file).not.toMatch(
				/^import\s+(?:[^"']+\s+from\s+)?["']ai(?:\/[^"']*)?["'];?\s*$/m,
			);
		}
	});

	test("imports ai statically from the ai-sdk entry only", async () => {
		const source = await readFile(resolve("dist/ai-sdk.mjs"), "utf8");
		expect(source).toMatch(/^import\s+[^"']+\s+from\s+["']ai["'];?\s*$/m);
	});

	test("keeps the Postgres backend out of the root entry's static imports", async () => {
		// Follow every relative static import from dist/index.mjs. The backend
		// (queries, migration runner, driver adapters) must only be reachable
		// through the dynamic import() that createMemory({ store: client })
		// runs on first use.
		const reached = await staticImportGraph(resolve("dist/index.mjs"));
		const root = await readFile(resolve("dist/index.mjs"), "utf8");
		expect(root).toMatch(
			/\bimport\(["']\.\/postgres-backend-[^"']+\.mjs["']\)/,
		);
		for (const file of reached) {
			const source = await readFile(file, "utf8");
			expect(source, file).not.toMatch(
				/\bCREATE TABLE\b|\bfunction createPostgresStore\b/,
			);
		}
	});

	test("runs an in-memory client from the packed package with database packages absent", async () => {
		const temporaryRoot = await mkdtemp(
			join(tmpdir(), "mnemocyte-packed-consumer-"),
		);
		try {
			const tarball = join(temporaryRoot, "mnemocyte.tgz");
			const extracted = join(temporaryRoot, "extracted");
			const consumer = join(temporaryRoot, "consumer");
			const nodeModules = join(consumer, "node_modules");
			await Promise.all([
				mkdir(extracted, { recursive: true }),
				mkdir(nodeModules, { recursive: true }),
			]);

			await packPackage(tarball);
			// Relative paths: GNU tar reads "C:\..." as a remote host, while
			// bsdtar and Windows' tar.exe reject GNU's --force-local.
			await execFileAsync(
				"tar",
				["-xzf", basename(tarball), "-C", basename(extracted)],
				{ cwd: temporaryRoot, windowsHide: true },
			);
			await rename(join(extracted, "package"), join(nodeModules, "mnemocyte"));
			const [packedFreshInstall, sourceFreshInstall] = await Promise.all([
				readFile(
					join(nodeModules, "mnemocyte", "migrations", "fresh-install.sql"),
				),
				readFile(resolve("migrations", "fresh-install.sql")),
			]);
			expect(packedFreshInstall).toEqual(sourceFreshInstall);

			const drivers = ["drizzle-orm", "postgres", "pg", "@electric-sql", "ai"];
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

			const { stdout } = await execFileAsync(process.execPath, [script], {
				cwd: consumer,
				env: { ...process.env, NODE_PATH: "" },
				windowsHide: true,
			});
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
			const cjs = await execFileAsync(process.execPath, [cjsScript], {
				cwd: consumer,
				env: { ...process.env, NODE_PATH: "" },
				windowsHide: true,
			});
			expect(cjs.stdout).toBe("packed-client-store-ok");

			// With the ai peer installed, the subpath embeds through an AI SDK
			// model and throws the root entry's error classes. A junction needs
			// no symlink rights on Windows; ai resolves its own dependencies
			// from its real path.
			await symlink(
				await realpath(resolve("node_modules", "ai")),
				join(nodeModules, "ai"),
				"junction",
			);
			const aiSdkScript = join(consumer, "ai-sdk.mjs");
			await writeFile(
				aiSdkScript,
				`
						import { APICallError } from "ai";
						import { MockEmbeddingModelV4 } from "ai/test";
						import { createMemory, ProviderError } from "mnemocyte";
						import { aiSdkEmbedder, memoryTools } from "mnemocyte/ai-sdk";

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
			const aiSdk = await execFileAsync(process.execPath, [aiSdkScript], {
				cwd: consumer,
				env: { ...process.env, NODE_PATH: "" },
				windowsHide: true,
			});
			expect(aiSdk.stdout).toBe("packed-ai-sdk-ok");
		} finally {
			await rm(temporaryRoot, { recursive: true, force: true });
		}
	}, 30_000);
});
