import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type postgres from "postgres";

/**
 * Apply `0003_schema_v2.sql`, then `0004_audit_memory_id.sql`, each unless
 * it already ran. A multi-statement `unsafe` call runs as one implicit
 * transaction, so a second run fails on its first statement (`42701`, the
 * column it adds exists) and changes nothing.
 */
export async function applySchemaV2Migration(
	sql: ReturnType<typeof postgres>,
): Promise<void> {
	for (const file of ["0003_schema_v2.sql", "0004_audit_memory_id.sql"]) {
		try {
			await sql.unsafe(await readFile(resolve("migrations", file), "utf8"));
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
}
