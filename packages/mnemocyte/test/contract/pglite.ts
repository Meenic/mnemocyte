import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { inject } from "vitest";

declare module "vitest" {
	export interface ProvidedContext {
		/** The data folder tarball from `pglite.global-setup.ts`. */
		pgliteTemplate: string;
	}
}

let template: Promise<Blob> | undefined;

/** Reads the template once per test file. */
function readTemplate(): Promise<Blob> {
	template ??= readFile(inject("pgliteTemplate")).then(
		(bytes) => new Blob([bytes]),
	);
	return template;
}

/**
 * A new in-process Postgres 18 of its own, with pgvector's files loaded and
 * no Mnemocyte tables, gone when it is closed. It starts from the project's
 * template data folder instead of running initdb. With `pgvector: false`,
 * `CREATE EXTENSION vector` has not run.
 */
export async function openPGlite(options: {
	readonly pgvector: boolean;
}): Promise<PGlite> {
	const db = await PGlite.create({
		extensions: { vector },
		loadDataDir: await readTemplate(),
	});
	if (options.pgvector) {
		await db.exec("CREATE EXTENSION IF NOT EXISTS vector;");
	}
	return db;
}
