import type { SqlExecutor } from "../../sql/executor.js";
import { META_COLUMNS, type MetaRow } from "../rows.js";

export const INSTALLATION_META_KEY = "installation";

export async function getInstallationMeta(
	db: SqlExecutor,
): Promise<MetaRow | null> {
	const rows = await db.query<MetaRow>(
		`SELECT ${META_COLUMNS}
		FROM mnemocyte_meta
		WHERE key = $1
		LIMIT 1`,
		[INSTALLATION_META_KEY],
	);
	return rows[0] ?? null;
}

export async function getStoredEmbeddingModels(
	db: SqlExecutor,
): Promise<string[]> {
	const rows = await db.query<{ embeddingModel: string }>(
		`SELECT DISTINCT embedding_model AS "embeddingModel"
		FROM mnemocyte_memories
		LIMIT 2`,
		[],
	);
	return rows.map((row) => row.embeddingModel);
}

export async function recordInstallationEmbeddingModel(
	db: SqlExecutor,
	embeddingModel: string,
): Promise<MetaRow | null> {
	const rows = await db.query<MetaRow>(
		`UPDATE mnemocyte_meta
		SET embedding_model = $1
		WHERE key = $2 AND embedding_model IS NULL
		RETURNING ${META_COLUMNS}`,
		[embeddingModel, INSTALLATION_META_KEY],
	);
	return rows[0] ?? null;
}
