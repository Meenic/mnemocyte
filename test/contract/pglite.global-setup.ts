import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import type { TestProject } from "vitest/node";

/**
 * Starts one PGlite for the `contract` project and saves its data folder,
 * an initialized cluster with no extension or tables, to a file. Tests open
 * copies of it with `openPGlite` (`pglite.ts`): loading a data folder skips
 * initdb, which PGlite otherwise runs on every start (about 0.75 s against
 * 0.2 s for a load).
 */
export default async function setup(
	project: TestProject,
): Promise<() => Promise<void>> {
	const root = await mkdtemp(join(tmpdir(), "mnemocyte-pglite-"));
	const db = await PGlite.create({ extensions: { vector } });
	try {
		// Uncompressed: about 40 MB, and loads faster than the 5 MB gzip.
		const dump = await db.dumpDataDir("none");
		const file = join(root, "template.tar");
		await writeFile(file, new Uint8Array(await dump.arrayBuffer()));
		project.provide("pgliteTemplate", file);
	} finally {
		await db.close();
	}

	return async () => {
		await rm(root, { recursive: true, force: true });
	};
}
