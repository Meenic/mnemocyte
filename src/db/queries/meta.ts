import type { SqlExecutor } from "../../sql/executor.js";
import { META_COLUMNS, type MetaRow, type VectorType } from "../rows.js";
import type { PostgresTables } from "../tables.js";

export const INSTALLATION_META_KEY = "installation";

export async function getInstallationMeta(
	db: SqlExecutor,
	tables: PostgresTables,
): Promise<MetaRow | null> {
	const rows = await db.query<MetaRow>(
		`SELECT ${META_COLUMNS}
		FROM ${tables.meta}
		WHERE key = $1
		LIMIT 1`,
		[INSTALLATION_META_KEY],
	);
	return rows[0] ?? null;
}

export async function getStoredEmbeddingModels(
	db: SqlExecutor,
	tables: PostgresTables,
): Promise<string[]> {
	const rows = await db.query<{ embeddingModel: string }>(
		`SELECT DISTINCT embedding_model AS "embeddingModel"
		FROM ${tables.memories}
		LIMIT 2`,
		[],
	);
	return rows.map((row) => row.embeddingModel);
}

export async function recordInstallationEmbeddingModel(
	db: SqlExecutor,
	tables: PostgresTables,
	embeddingModel: string,
): Promise<MetaRow | null> {
	const rows = await db.query<MetaRow>(
		`UPDATE ${tables.meta}
		SET embedding_model = $1
		WHERE key = $2 AND embedding_model IS NULL
		RETURNING ${META_COLUMNS}`,
		[embeddingModel, INSTALLATION_META_KEY],
	);
	return rows[0] ?? null;
}

/** The installed pgvector version (`pg_extension.extversion`), or null. */
export async function getPgvectorVersion(
	db: SqlExecutor,
): Promise<string | null> {
	const rows = await db.query<{ version: string }>(
		`SELECT extversion AS "version"
		FROM pg_extension
		WHERE extname = 'vector'`,
		[],
	);
	return rows[0]?.version ?? null;
}

export async function getInstallationVectorType(
	db: SqlExecutor,
	tables: PostgresTables,
): Promise<VectorType | null> {
	const rows = await db.query<{ vectorType: VectorType }>(
		`SELECT vector_type AS "vectorType"
		FROM ${tables.meta}
		WHERE key = $1
		LIMIT 1`,
		[INSTALLATION_META_KEY],
	);
	return rows[0]?.vectorType ?? null;
}
