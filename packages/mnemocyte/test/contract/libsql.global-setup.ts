import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

/**
 * One temporary folder for every libSQL database of the `contract` project
 * (`openLibsql` in `libsql.ts`), removed when the run ends. On Windows the
 * driver keeps a database file locked for a while after `client.close()`,
 * so a test removing its own file waited up to 16 s; by teardown the
 * workers have exited and released them.
 */
export default async function setup(
	project: TestProject,
): Promise<() => Promise<void>> {
	const root = await mkdtemp(join(tmpdir(), "mnemocyte-libsql-"));
	project.provide("libsqlRoot", root);
	return async () => {
		await rm(root, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 200,
		});
	};
}
