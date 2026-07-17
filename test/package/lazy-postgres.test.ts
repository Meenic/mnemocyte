import { execFile } from "node:child_process";
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

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
		await execFileAsync(
			process.execPath,
			[pnpmCli, "pack", "--out", tarball],
			options,
		);
		return;
	}
	await execFileAsync("pnpm", ["pack", "--out", tarball], options);
}

describe("lazy Postgres package loading", () => {
	test("keeps database packages out of the root entry's static imports", async () => {
		const rootEntry = await readFile(resolve("dist/index.mjs"), "utf8");

		expect(rootEntry).not.toMatch(
			/^import\s+(?:[^"']+\s+from\s+)?["'](?:drizzle-orm(?:\/[^"']*)?|postgres)["'];?\s*$/m,
		);
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
			await execFileAsync("tar", ["-xzf", tarball, "-C", extracted], {
				windowsHide: true,
			});
			await rename(join(extracted, "package"), join(nodeModules, "mnemocyte"));

			await Promise.all([
				expectPathMissing(join(nodeModules, "drizzle-orm")),
				expectPathMissing(join(nodeModules, "postgres")),
				expectPathMissing(
					join(nodeModules, "mnemocyte", "node_modules", "drizzle-orm"),
				),
				expectPathMissing(
					join(nodeModules, "mnemocyte", "node_modules", "postgres"),
				),
			]);

			const script = join(consumer, "in-memory.mjs");
			await writeFile(
				script,
				`
						import { createMnemocyte } from "mnemocyte";

						let configError;
						try {
							createMnemocyte({
								databaseUrl: "https://example.com/not-postgres",
								embedder: {
									model: "packed-invalid-config",
									dimensions: 2,
									async embed() {
										return [];
									},
								},
							});
						} catch (error) {
							configError = error;
						}
						if (configError?.code !== "CONFIG") {
							throw new Error("Invalid databaseUrl did not fail synchronously.");
						}

						const client = createMnemocyte({
							embedder: {
								model: "packed-in-memory",
								dimensions: 2,
								async embed(texts) {
									return texts.map((text) => [text.length, 1]);
								},
							},
						});
						const memory = await client.remember({
							entityId: "packed-consumer",
							content: "Database packages are absent.",
						});
						const recalled = await client.recall({
							entityId: "packed-consumer",
							query: "absent database packages",
							minScore: 0,
						});
						if (memory.entityId !== "packed-consumer" || recalled.length !== 1) {
							throw new Error("Packed in-memory client returned unexpected data.");
						}
						await client.close();
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
		} finally {
			await rm(temporaryRoot, { recursive: true, force: true });
		}
	}, 30_000);
});
