import { and, eq, isNull } from "drizzle-orm";
import type { MnemocyteDatabase } from "../index.js";
import { type MetaRow, memoriesTable, metaTable } from "../schema.js";

export const INSTALLATION_META_KEY = "installation";

export async function getInstallationMeta(
	db: MnemocyteDatabase,
): Promise<MetaRow | null> {
	const rows = await db
		.select()
		.from(metaTable)
		.where(eq(metaTable.key, INSTALLATION_META_KEY))
		.limit(1);
	return rows[0] ?? null;
}

export async function getStoredEmbeddingModels(
	db: MnemocyteDatabase,
): Promise<string[]> {
	const rows = await db
		.selectDistinct({ embeddingModel: memoriesTable.embeddingModel })
		.from(memoriesTable)
		.limit(2);
	return rows.map((row) => row.embeddingModel);
}

export async function recordInstallationEmbeddingModel(
	db: MnemocyteDatabase,
	embeddingModel: string,
): Promise<MetaRow | null> {
	const rows = await db
		.update(metaTable)
		.set({ embeddingModel })
		.where(
			and(
				eq(metaTable.key, INSTALLATION_META_KEY),
				isNull(metaTable.embeddingModel),
			),
		)
		.returning();
	return rows[0] ?? null;
}
