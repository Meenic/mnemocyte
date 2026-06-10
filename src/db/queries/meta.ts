import { eq } from "drizzle-orm";
import type { MnemocyteDatabase } from "../index.js";
import { type MetaRow, metaTable } from "../schema.js";

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
