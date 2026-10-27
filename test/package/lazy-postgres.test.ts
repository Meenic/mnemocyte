import { exec, execFile } from "node:child_process";
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

describe("lazy Postgres package loading", () => {
	test("declares no runtime dependencies and marks database packages as optional peers", async () => {
		const manifest = JSON.parse(
			await readFile(resolve("package.json"), "utf8"),
		);

		expect(manifest.dependencies).toBeUndefined();
		expect(Object.keys(manifest.peerDependencies).sort()).toEqual([
			"drizzle-orm",
			"postgres",
		]);
		expect(manifest.peerDependenciesMeta["drizzle-orm"].optional).toBe(true);
		expect(manifest.peerDependenciesMeta.postgres.optional).toBe(true);
	});

	test.each(["dist/index.mjs", "dist/postgres.mjs", "dist/stores/drizzle.mjs"])(
		"keeps database packages out of the static imports of %s",
		async (entry) => {
			const source = await readFile(resolve(entry), "utf8");

			expect(source).not.toMatch(
				/^import\s+(?:[^"']+\s+from\s+)?["'](?:drizzle-orm(?:\/[^"']*)?|postgres)["'];?\s*$/m,
			);
		},
	);

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
