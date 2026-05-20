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

export type RecallMemoryRow = Omit<MemoryRow, "embedding">;

export type VectorSearchRow = RecallMemoryRow & { vectorScore: number };

export type LexicalSearchRow = RecallMemoryRow & { lexicalScore: number };

function vectorLiteral(embedding: readonly number[]): string {
	return `[${embedding.map(formatVectorComponent).join(",")}]`;
}

function formatVectorComponent(value: number): string {
	if (!Number.isFinite(value)) {
		throw new Error("Vector values must be finite numbers.");
	}
	return Object.is(value, -0) ? "0" : value.toFixed(17);
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
			? sql`${memoriesTable.tags} @> ${filter.tags}`
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

export async function insertMemories(
	db: MnemocyteDatabase,
	rows: NewMemoryRow[],
): Promise<MemoryRow[]> {
	if (rows.length === 0) {
		return [];
	}
	return db.insert(memoriesTable).values(rows).returning();
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

export interface DuplicateSearchInput {
	entityId: string;
	threshold: number;
	limit: number;
	types?: readonly string[];
	tags?: readonly string[];
	includeSuperseded?: boolean;
	includeExpired?: boolean;
}

export async function findDuplicatePairs(
	db: MnemocyteDatabase,
	input: DuplicateSearchInput,
): Promise<Array<{ a: MemoryRow; b: MemoryRow; similarity: number }>> {
	const rows = await db.execute(sql`
		SELECT
			a.id AS "aId",
			a.entity_id AS "aEntityId",
			a.content AS "aContent",
			a.type AS "aType",
			a.importance AS "aImportance",
			a.tags AS "aTags",
			a.source AS "aSource",
			a.metadata AS "aMetadata",
			a.confidence AS "aConfidence",
			a.embedding AS "aEmbedding",
			a.embedding_model AS "aEmbeddingModel",
			a.embedding_dimensions AS "aEmbeddingDimensions",
			a.superseded_by AS "aSupersededBy",
			a.superseded_at AS "aSupersededAt",
			a.expires_at AS "aExpiresAt",
			a.last_accessed_at AS "aLastAccessedAt",
			a.access_count AS "aAccessCount",
			a.created_at AS "aCreatedAt",
			a.updated_at AS "aUpdatedAt",
			b.id AS "bId",
			b.entity_id AS "bEntityId",
			b.content AS "bContent",
			b.type AS "bType",
			b.importance AS "bImportance",
			b.tags AS "bTags",
			b.source AS "bSource",
			b.metadata AS "bMetadata",
			b.confidence AS "bConfidence",
			b.embedding AS "bEmbedding",
			b.embedding_model AS "bEmbeddingModel",
			b.embedding_dimensions AS "bEmbeddingDimensions",
			b.superseded_by AS "bSupersededBy",
			b.superseded_at AS "bSupersededAt",
			b.expires_at AS "bExpiresAt",
			b.last_accessed_at AS "bLastAccessedAt",
			b.access_count AS "bAccessCount",
			b.created_at AS "bCreatedAt",
			b.updated_at AS "bUpdatedAt",
			1 - (a.embedding <=> b.embedding) AS "similarity"
		FROM mnemocyte_memories a
		JOIN mnemocyte_memories b
			ON b.entity_id = a.entity_id
			AND a.id < b.id
			AND a.embedding IS NOT NULL
			AND b.embedding IS NOT NULL
		WHERE
			a.entity_id = ${input.entityId}
			${input.includeSuperseded ? sql`` : sql`AND a.superseded_by IS NULL AND b.superseded_by IS NULL`}
			${input.includeExpired ? sql`` : sql`AND (a.expires_at IS NULL OR a.expires_at > now()) AND (b.expires_at IS NULL OR b.expires_at > now())`}
			${
				input.types && input.types.length > 0
					? sql`AND a.type IN (${sql.join(
							input.types.map((type) => sql`${type}`),
							sql`, `,
						)}) AND b.type IN (${sql.join(
							input.types.map((type) => sql`${type}`),
							sql`, `,
						)})`
					: sql``
			}
			${
				input.tags && input.tags.length > 0
					? sql`AND a.tags @> ${input.tags} AND b.tags @> ${input.tags}`
					: sql``
			}
			AND 1 - (a.embedding <=> b.embedding) >= ${input.threshold}
		ORDER BY "similarity" DESC
		LIMIT ${input.limit}
	`);
	const records = rows as unknown as Array<Record<string, unknown>>;
	return records.map((row) => {
		const a = {
			id: row.aId,
			entityId: row.aEntityId,
			content: row.aContent,
			type: row.aType,
			importance: row.aImportance,
			tags: row.aTags,
			source: row.aSource,
			metadata: row.aMetadata,
			confidence: row.aConfidence,
			embedding: row.aEmbedding,
			embeddingModel: row.aEmbeddingModel,
			embeddingDimensions: row.aEmbeddingDimensions,
			supersededBy: row.aSupersededBy,
			supersededAt: row.aSupersededAt,
			expiresAt: row.aExpiresAt,
			lastAccessedAt: row.aLastAccessedAt,
			accessCount: row.aAccessCount,
			createdAt: row.aCreatedAt,
			updatedAt: row.aUpdatedAt,
		} as unknown as MemoryRow;
		const b = {
			id: row.bId,
			entityId: row.bEntityId,
			content: row.bContent,
			type: row.bType,
			importance: row.bImportance,
			tags: row.bTags,
			source: row.bSource,
			metadata: row.bMetadata,
			confidence: row.bConfidence,
			embedding: row.bEmbedding,
			embeddingModel: row.bEmbeddingModel,
			embeddingDimensions: row.bEmbeddingDimensions,
			supersededBy: row.bSupersededBy,
			supersededAt: row.bSupersededAt,
			expiresAt: row.bExpiresAt,
			lastAccessedAt: row.bLastAccessedAt,
			accessCount: row.bAccessCount,
			createdAt: row.bCreatedAt,
			updatedAt: row.bUpdatedAt,
		} as unknown as MemoryRow;
		return {
			a,
			b,
			similarity: Number(row.similarity) || 0,
		};
	});
}

export interface SupersedeRow {
	id: string;
	tags: string[];
}

export async function loadConsolidationTargets(
	db: MnemocyteDatabase,
	entityId: string,
	ids: readonly string[],
): Promise<Array<{ id: string; tags: string[]; supersededBy: string | null }>> {
	if (ids.length === 0) {
		return [];
	}
	const rows = await db
		.select({
			id: memoriesTable.id,
			tags: memoriesTable.tags,
			supersededBy: memoriesTable.supersededBy,
		})
		.from(memoriesTable)
		.where(
			and(
				eq(memoriesTable.entityId, entityId),
				inArray(memoriesTable.id, [...ids]),
			),
		);
	return rows;
}

export async function markMemoriesSuperseded(
	db: MnemocyteDatabase,
	params: {
		survivorId: string;
		entityId: string;
		ids: readonly string[];
		now: Date;
	},
): Promise<SupersedeRow[]> {
	if (params.ids.length === 0) {
		return [];
	}
	const result = await db
		.update(memoriesTable)
		.set({
			supersededBy: params.survivorId,
			supersededAt: params.now,
			updatedAt: params.now,
		})
		.where(
			and(
				eq(memoriesTable.entityId, params.entityId),
				inArray(memoriesTable.id, [...params.ids]),
				isNull(memoriesTable.supersededBy),
			),
		)
		.returning({ id: memoriesTable.id, tags: memoriesTable.tags });
	return result;
}

export async function setMemoryTags(
	db: MnemocyteDatabase,
	params: {
		entityId: string;
		memoryId: string;
		tags: readonly string[];
		now: Date;
	},
): Promise<void> {
	await db
		.update(memoriesTable)
		.set({ tags: [...params.tags], updatedAt: params.now })
		.where(
			and(
				eq(memoriesTable.entityId, params.entityId),
				eq(memoriesTable.id, params.memoryId),
			),
		);
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

export async function getMemoryEmbeddings(
	db: MnemocyteDatabase,
	memoryIds: readonly string[],
): Promise<Map<string, number[]>> {
	if (memoryIds.length === 0) {
		return new Map();
	}
	const rows = await db
		.select({
			id: memoriesTable.id,
			embedding: memoriesTable.embedding,
		})
		.from(memoriesTable)
		.where(inArray(memoriesTable.id, [...memoryIds]));
	return new Map(
		rows.flatMap((row) => (row.embedding ? [[row.id, row.embedding]] : [])),
	);
}

export async function vectorSearch(
	db: MnemocyteDatabase,
	input: VectorSearchInput,
): Promise<VectorSearchRow[]> {
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
			${input.tags && input.tags.length > 0 ? sql`AND tags @> ${input.tags}` : sql``}
			${input.before ? sql`AND created_at < ${input.before}` : sql``}
			${input.after ? sql`AND created_at > ${input.after}` : sql``}
			AND 1 - (embedding <=> ${embedding}::vector) >= ${minScore}
		ORDER BY embedding <=> ${embedding}::vector
		LIMIT ${input.limit}
	`);
	return rows as unknown as VectorSearchRow[];
}

export async function lexicalSearch(
	db: MnemocyteDatabase,
	input: LexicalSearchInput,
): Promise<LexicalSearchRow[]> {
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
			${input.tags && input.tags.length > 0 ? sql`AND tags @> ${input.tags}` : sql``}
			${input.before ? sql`AND created_at < ${input.before}` : sql``}
			${input.after ? sql`AND created_at > ${input.after}` : sql``}
			AND to_tsvector('english', content) @@ websearch_to_tsquery('english', ${input.query})
		ORDER BY "lexicalScore" DESC
		LIMIT ${input.limit}
	`);
	return rows as unknown as LexicalSearchRow[];
}
