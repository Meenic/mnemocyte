import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type postgres from "postgres";

/**
 * Apply `0003_schema_v2.sql` unless it already ran. A multi-statement
 * `unsafe` call runs as one implicit transaction, so a second run fails on
 * its first statement (`42701`, the `namespace` column exists) and changes
 * nothing.
 */
export async function applySchemaV2Migration(
	sql: ReturnType<typeof postgres>,
): Promise<void> {
	try {
		await sql.unsafe(
			await readFile(resolve("migrations", "0003_schema_v2.sql"), "utf8"),
		);
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error
				? error.code
				: undefined;
		if (code !== "42701") {
			throw error;
		}
	}
}
