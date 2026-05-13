import {
	and,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	lt,
	or,
	sql,
} from "drizzle-orm";
import type { ImportanceLevel, MemoryType } from "../../types.js";
import type { MnemocyteDatabase } from "../index.js";
import { type MemoryRow, memoriesTable, type NewMemoryRow } from "../schema.js";

export interface MemoryFilter {
	entityId: string;
	types?: readonly MemoryType[];
	tags?: readonly string[];
	before?: Date;
	after?: Date;
	includeSuperseded?: boolean;
	includeExpired?: boolean;
}

export interface VectorSearchInput extends MemoryFilter {
	embedding: readonly number[];
	limit: number;
	minScore?: number;
}

export interface LexicalSearchInput extends MemoryFilter {
	query: string;
	limit: number;
}

function vectorLiteral(embedding: readonly number[]): string {
	return `[${embedding.join(",")}]`;
}

function filterConditions(filter: MemoryFilter) {
	return and(
		eq(memoriesTable.entityId, filter.entityId),
		filter.includeSuperseded ? undefined : isNull(memoriesTable.supersededBy),
		filter.includeExpired
			? undefined
			: sql`(${memoriesTable.expiresAt} IS NULL OR ${memoriesTable.expiresAt} > now())`,
		filter.types && filter.types.length > 0
			? inArray(memoriesTable.type, [...filter.types])
			: undefined,
		filter.tags && filter.tags.length > 0
			? sql`${memoriesTable.tags} && ${filter.tags}`
			: undefined,
		filter.before ? lt(memoriesTable.createdAt, filter.before) : undefined,
		filter.after ? gt(memoriesTable.createdAt, filter.after) : undefined,
	);
}

export async function insertMemory(
	db: MnemocyteDatabase,
	row: NewMemoryRow,
): Promise<MemoryRow> {
	const result = await db.insert(memoriesTable).values(row).returning();
	const inserted = result[0];
	if (!inserted) {
		throw new Error("Memory insert returned no rows.");
	}
	return inserted;
}

export async function getMemoryById(
	db: MnemocyteDatabase,
	entityId: string,
	memoryId: string,
): Promise<MemoryRow | null> {
	const result = await db
		.select()
		.from(memoriesTable)
		.where(
			and(eq(memoriesTable.entityId, entityId), eq(memoriesTable.id, memoryId)),
		)
		.limit(1);
	return result[0] ?? null;
}

export async function listMemories(
	db: MnemocyteDatabase,
	filter: MemoryFilter,
): Promise<MemoryRow[]> {
	return db.select().from(memoriesTable).where(filterConditions(filter));
}

export async function deleteMemory(
	db: MnemocyteDatabase,
	entityId: string,
	memoryId: string,
): Promise<boolean> {
	const result = await db
		.delete(memoriesTable)
		.where(
			and(eq(memoriesTable.entityId, entityId), eq(memoriesTable.id, memoryId)),
		)
		.returning({ id: memoriesTable.id });
	return result.length > 0;
}

export async function deleteMemoriesForEntity(
	db: MnemocyteDatabase,
	entityId: string,
): Promise<number> {
	const result = await db
		.delete(memoriesTable)
		.where(eq(memoriesTable.entityId, entityId))
		.returning({ id: memoriesTable.id });
	return result.length;
}

export interface PruneFilter {
	entityId?: string;
	expired?: boolean;
	superseded?: boolean;
	createdBefore?: Date;
	notAccessedSince?: Date;
	types?: readonly MemoryType[];
	tags?: readonly string[];
	maxImportanceLevels?: readonly ImportanceLevel[];
}

function pruneConditions(filter: PruneFilter) {
	return and(
		filter.entityId !== undefined
			? eq(memoriesTable.entityId, filter.entityId)
			: undefined,
		filter.expired
			? and(
					isNotNull(memoriesTable.expiresAt),
					sql`${memoriesTable.expiresAt} <= now()`,
				)
			: undefined,
		filter.superseded ? isNotNull(memoriesTable.supersededBy) : undefined,
		filter.createdBefore
			? lt(memoriesTable.createdAt, filter.createdBefore)
			: undefined,
		filter.notAccessedSince
			? or(
					isNull(memoriesTable.lastAccessedAt),
					lt(memoriesTable.lastAccessedAt, filter.notAccessedSince),
				)
			: undefined,
		filter.types && filter.types.length > 0
			? inArray(memoriesTable.type, [...filter.types])
			: undefined,
		filter.tags && filter.tags.length > 0
			? sql`${memoriesTable.tags} @> ${filter.tags}`
			: undefined,
		filter.maxImportanceLevels && filter.maxImportanceLevels.length > 0
			? inArray(memoriesTable.importance, [...filter.maxImportanceLevels])
			: undefined,
	);
}

export async function countPruneMatches(
	db: MnemocyteDatabase,
	filter: PruneFilter,
): Promise<number> {
	const result = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(memoriesTable)
		.where(pruneConditions(filter));
	return result[0]?.count ?? 0;
}

export async function pruneMemories(
	db: MnemocyteDatabase,
	filter: PruneFilter,
): Promise<number> {
	const result = await db
		.delete(memoriesTable)
		.where(pruneConditions(filter))
		.returning({ id: memoriesTable.id });
	return result.length;
}

export async function markMemoryAccessed(
	db: MnemocyteDatabase,
	memoryIds: readonly string[],
): Promise<void> {
	if (memoryIds.length === 0) {
		return;
	}
	await db
		.update(memoriesTable)
		.set({
			lastAccessedAt: new Date(),
			accessCount: sql`${memoriesTable.accessCount} + 1`,
			updatedAt: new Date(),
		})
		.where(inArray(memoriesTable.id, [...memoryIds]));
}

export async function vectorSearch(
	db: MnemocyteDatabase,
	input: VectorSearchInput,
): Promise<Array<MemoryRow & { vectorScore: number }>> {
	const embedding = vectorLiteral(input.embedding);
	const minScore = input.minScore ?? 0;
	const rows = await db.execute(sql`
		SELECT
			id,
			entity_id AS "entityId",
			content,
			type,
			importance,
			tags,
			source,
			metadata,
			confidence,
			embedding,
			embedding_model AS "embeddingModel",
			embedding_dimensions AS "embeddingDimensions",
			superseded_by AS "supersededBy",
			superseded_at AS "supersededAt",
			expires_at AS "expiresAt",
			last_accessed_at AS "lastAccessedAt",
			access_count AS "accessCount",
			created_at AS "createdAt",
			updated_at AS "updatedAt",
			1 - (embedding <=> ${embedding}::vector) AS "vectorScore"
		FROM mnemocyte_memories
		WHERE
			entity_id = ${input.entityId}
			AND embedding IS NOT NULL
			${input.includeSuperseded ? sql`` : sql`AND superseded_by IS NULL`}
			${input.includeExpired ? sql`` : sql`AND (expires_at IS NULL OR expires_at > now())`}
			${
				input.types && input.types.length > 0
					? sql`AND type IN (${sql.join(
							input.types.map((type) => sql`${type}`),
							sql`, `,
						)})`
					: sql``
			}
			${input.tags && input.tags.length > 0 ? sql`AND tags && ${input.tags}` : sql``}
			${input.before ? sql`AND created_at < ${input.before}` : sql``}
			${input.after ? sql`AND created_at > ${input.after}` : sql``}
			AND 1 - (embedding <=> ${embedding}::vector) >= ${minScore}
		ORDER BY embedding <=> ${embedding}::vector
		LIMIT ${input.limit}
	`);
	return rows as unknown as Array<MemoryRow & { vectorScore: number }>;
}

export async function lexicalSearch(
	db: MnemocyteDatabase,
	input: LexicalSearchInput,
): Promise<Array<MemoryRow & { lexicalScore: number }>> {
	const rows = await db.execute(sql`
		SELECT
			id,
			entity_id AS "entityId",
			content,
			type,
			importance,
			tags,
			source,
			metadata,
			confidence,
			embedding,
			embedding_model AS "embeddingModel",
			embedding_dimensions AS "embeddingDimensions",
			superseded_by AS "supersededBy",
			superseded_at AS "supersededAt",
			expires_at AS "expiresAt",
			last_accessed_at AS "lastAccessedAt",
			access_count AS "accessCount",
			created_at AS "createdAt",
			updated_at AS "updatedAt",
			ts_rank(to_tsvector('english', content), websearch_to_tsquery('english', ${input.query})) AS "lexicalScore"
		FROM mnemocyte_memories
		WHERE
			entity_id = ${input.entityId}
			${input.includeSuperseded ? sql`` : sql`AND superseded_by IS NULL`}
			${input.includeExpired ? sql`` : sql`AND (expires_at IS NULL OR expires_at > now())`}
			${
				input.types && input.types.length > 0
					? sql`AND type IN (${sql.join(
							input.types.map((type) => sql`${type}`),
							sql`, `,
						)})`
					: sql``
			}
			${input.tags && input.tags.length > 0 ? sql`AND tags && ${input.tags}` : sql``}
			${input.before ? sql`AND created_at < ${input.before}` : sql``}
			${input.after ? sql`AND created_at > ${input.after}` : sql``}
			AND to_tsvector('english', content) @@ websearch_to_tsquery('english', ${input.query})
		ORDER BY "lexicalScore" DESC
		LIMIT ${input.limit}
	`);
	return rows as unknown as Array<MemoryRow & { lexicalScore: number }>;
}
