import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { inject } from "vitest";

declare module "vitest" {
	export interface ProvidedContext {
		/** The extracted tarball from `pack.global-setup.ts`. */
		packedPackage: string;
	}
}

const execFileAsync = promisify(execFile);

export interface PackedConsumer {
	/** The consumer project folder. */
	dir: string;
	nodeModules: string;
	/** `node_modules/mnemocyte`, copied from the packed tarball. */
	packageDir: string;
	/** Runs a script in the consumer with a Node process of its own. */
	run(script: string): Promise<{ stdout: string; stderr: string }>;
	/** Links the dev `ai` into the consumer's `node_modules`. */
	linkAi(): Promise<void>;
	remove(): Promise<void>;
}

/**
 * A temporary project with the packed package installed and no other
 * dependencies, so `drizzle-orm`, `postgres`, `pg`, PGlite and `ai` are
 * absent until a test links one in.
 */
export async function createPackedConsumer(): Promise<PackedConsumer> {
	const dir = await mkdtemp(join(tmpdir(), "mnemocyte-packed-consumer-"));
	const nodeModules = join(dir, "node_modules");
	const packageDir = join(nodeModules, "mnemocyte");
	await mkdir(nodeModules, { recursive: true });
	await cp(inject("packedPackage"), packageDir, { recursive: true });

	return {
		dir,
		nodeModules,
		packageDir,
		run(script) {
			return execFileAsync(process.execPath, [script], {
				cwd: dir,
				env: { ...process.env, NODE_PATH: "" },
				windowsHide: true,
			});
		},
		async linkAi() {
			// A junction needs no symlink rights on Windows; ai resolves its own
			// dependencies from its real path.
			await symlink(
				await realpath(resolve("node_modules", "ai")),
				join(nodeModules, "ai"),
				"junction",
			);
		},
		async remove() {
			await rm(dir, { recursive: true, force: true });
		},
	};
}
