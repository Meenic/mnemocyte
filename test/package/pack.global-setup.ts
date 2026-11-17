import { exec, execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { TestProject } from "vitest/node";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

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

/**
 * Packs the built package once for the `package` project and extracts it.
 * Tests copy the extracted folder into consumers of their own (see
 * `packed-consumer.ts`), so parallel files never share a `node_modules`.
 */
export default async function setup(
	project: TestProject,
): Promise<() => Promise<void>> {
	const root = await mkdtemp(join(tmpdir(), "mnemocyte-packed-"));
	const tarball = join(root, "mnemocyte.tgz");
	const extracted = join(root, "extracted");
	await mkdir(extracted, { recursive: true });

	await packPackage(tarball);
	// Relative paths: GNU tar reads "C:\..." as a remote host, while bsdtar
	// and Windows' tar.exe reject GNU's --force-local.
	await execFileAsync(
		"tar",
		["-xzf", basename(tarball), "-C", basename(extracted)],
		{ cwd: root, windowsHide: true },
	);
	project.provide("packedPackage", join(extracted, "package"));

	return async () => {
		await rm(root, { recursive: true, force: true });
	};
}
