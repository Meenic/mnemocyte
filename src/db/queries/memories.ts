import {
	and,
	count,
	countDistinct,
	eq,
	inArray,
	isNotNull,
	isNull,
	lt,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import type { ImportanceLevel, MemoryType } from "../../types.js";
import { executeCancelableSql } from "../cancellation.js";
import type { MnemocyteDatabase } from "../index.js";
import { type MemoryRow, memoriesTable, type NewMemoryRow } from "../schema.js";
import { formatVectorComponent } from "../vector.js";

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
	minVectorScore?: number;
}

export interface LexicalSearchInput extends MemoryFilter {
	query: string;
	limit: number;
}

export interface MemoryStatsCounts {
	memoryCount: number;
	activeMemoryCount: number;
	expiredMemoryCount: number;
	supersededMemoryCount: number;
}

export interface GuardedDeleteResult {
	matchedCount: number;
	deletedCount: number;
	hasDependents: boolean;
	deletedByEntity: Array<{ entityId: string; deletedCount: number }>;
}

export interface GlobalMemoryStatsCounts extends MemoryStatsCounts {
	entityCount: number;
}

function vectorLiteral(embedding: readonly number[]): string {
	return `[${embedding.map(formatVectorComponent).join(",")}]`;
}

function clampedVectorScore(embedding: string) {
	const rawScore = sql`1 - (embedding <=> ${embedding}::vector)`;
	return sql<number>`
		CASE
			WHEN ${rawScore} = 'NaN'::double precision
				OR ${rawScore} = 'Infinity'::double precision
				OR ${rawScore} = '-Infinity'::double precision
				THEN 0::double precision
			ELSE GREATEST(
				0::double precision,
				LEAST(1::double precision, ${rawScore})
			)
		END
	`;
}

type RawTimestamp = Date | string;

export type RecallMemoryRow = Omit<
	MemoryRow,
	| "embedding"
	| "supersededAt"
	| "expiresAt"
	| "lastAccessedAt"
	| "createdAt"
	| "updatedAt"
> & {
	supersededAt: RawTimestamp | null;
	expiresAt: RawTimestamp | null;
	lastAccessedAt: RawTimestamp | null;
	createdAt: RawTimestamp;
	updatedAt: RawTimestamp;
};

export type VectorSearchRow = RecallMemoryRow & { vectorScore: number };

export type LexicalSearchRow = RecallMemoryRow & { lexicalScore: number };

function timestampParam(value: Date) {
	return sql`${value.toISOString()}::timestamptz`;
}

function textArrayLiteral(values: readonly string[]) {
	return sql`ARRAY[${sql.join(
		values.map((value) => sql`${value}`),
		sql`, `,
	)}]::text[]`;
}

function tagsContainAll(tags: readonly string[] | undefined) {
	return tags && tags.length > 0
		? sql`${memoriesTable.tags} @> ${textArrayLiteral(tags)}`
		: undefined;
}

function rawTagsFilter(tags: readonly string[] | undefined) {
	return tags && tags.length > 0
		? sql`AND tags @> ${textArrayLiteral(tags)}`
		: sql``;
}

function duplicateTagsFilter(tags: readonly string[] | undefined) {
	return tags && tags.length > 0
		? sql`AND a.tags @> ${textArrayLiteral(tags)} AND b.tags @> ${textArrayLiteral(tags)}`
		: sql``;
}

function memoryStatsCountFields(now: Date) {
	return {
		memoryCount: count(),
		activeMemoryCount: sql<number>`
			(count(*) FILTER (
				WHERE ${memoriesTable.supersededBy} IS NULL
					AND (${memoriesTable.expiresAt} IS NULL OR ${memoriesTable.expiresAt} > ${timestampParam(now)})
			))::int
		`.mapWith(Number),
		expiredMemoryCount: sql<number>`
			(count(*) FILTER (
				WHERE ${memoriesTable.expiresAt} IS NOT NULL
					AND ${memoriesTable.expiresAt} <= ${timestampParam(now)}
			))::int
		`.mapWith(Number),
		supersededMemoryCount:
			sql<number>`(count(*) FILTER (WHERE ${memoriesTable.supersededBy} IS NOT NULL))::int`.mapWith(
				Number,
			),
	};
}

function emptyMemoryStatsCounts(): MemoryStatsCounts {
	return {
		memoryCount: 0,
		activeMemoryCount: 0,
		expiredMemoryCount: 0,
		supersededMemoryCount: 0,
	};
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

export async function getEntityMemoryStatsCounts(
	db: MnemocyteDatabase,
	entityId: string,
	now: Date,
): Promise<MemoryStatsCounts> {
	const rows = await db
		.select(memoryStatsCountFields(now))
		.from(memoriesTable)
		.where(eq(memoriesTable.entityId, entityId));
	return rows[0] ?? emptyMemoryStatsCounts();
}

export async function getGlobalMemoryStatsCounts(
	db: MnemocyteDatabase,
	now: Date,
): Promise<GlobalMemoryStatsCounts> {
	const rows = await db
		.select({
			entityCount: countDistinct(memoriesTable.entityId),
			...memoryStatsCountFields(now),
		})
		.from(memoriesTable);
	return rows[0] ?? { entityCount: 0, ...emptyMemoryStatsCounts() };
}

export async function deleteMemory(
	db: MnemocyteDatabase,
	entityId: string,
	memoryId: string,
): Promise<GuardedDeleteResult> {
	return deleteMemoriesWithDependentGuard(
		db,
		and(eq(memoriesTable.entityId, entityId), eq(memoriesTable.id, memoryId)),
	);
}

export async function deleteMemoriesForEntity(
	db: MnemocyteDatabase,
	entityId: string,
): Promise<GuardedDeleteResult> {
	return deleteMemoriesWithDependentGuard(
		db,
		eq(memoriesTable.entityId, entityId),
	);
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
		tagsContainAll(filter.tags),
		filter.maxImportanceLevels && filter.maxImportanceLevels.length > 0
			? inArray(memoriesTable.importance, [...filter.maxImportanceLevels])
			: undefined,
	);
}

export async function countPruneMatches(
	db: MnemocyteDatabase,
	filter: PruneFilter,
	signal?: AbortSignal,
): Promise<number> {
	const conditions = pruneConditions(filter);
	const rows = await executeCancelableSql<Array<{ count: number | string }>>(
		db,
		sql`
			SELECT count(*)::int AS count
			FROM ${memoriesTable}
			${conditions ? sql`WHERE ${conditions}` : sql``}
		`,
		signal,
	);
	return Number(rows[0]?.count ?? 0);
}

export async function pruneMemories(
	db: MnemocyteDatabase,
	filter: PruneFilter,
	signal?: AbortSignal,
): Promise<GuardedDeleteResult> {
	const conditions = pruneConditions(filter);
	return deleteMemoriesWithDependentGuard(db, conditions, signal);
}

async function deleteMemoriesWithDependentGuard(
	db: MnemocyteDatabase,
	conditions: SQL | undefined,
	signal?: AbortSignal,
): Promise<GuardedDeleteResult> {
	const rows = await executeCancelableSql<
		Array<{
			matchedCount: number | string;
			deletedCount: number | string;
			hasDependents: boolean;
			entityId: string | null;
			entityDeletedCount: number | string | null;
		}>
	>(
		db,
		sql`
			WITH candidates AS MATERIALIZED (
				SELECT id, entity_id
				FROM ${memoriesTable}
				${conditions ? sql`WHERE ${conditions}` : sql``}
			),
			dependents AS MATERIALIZED (
				SELECT 1
				FROM ${memoriesTable} AS dependent
				INNER JOIN candidates AS target
					ON dependent.superseded_by = target.id
				LIMIT 1
			),
			deleted AS (
				DELETE FROM ${memoriesTable}
				WHERE ${memoriesTable.id} IN (SELECT id FROM candidates)
					AND NOT EXISTS (SELECT 1 FROM dependents)
				RETURNING id, entity_id
			),
			deleted_counts AS (
				SELECT entity_id, count(*)::int AS deleted_count
				FROM deleted
				GROUP BY entity_id
			),
			summary AS (
				SELECT
					(SELECT count(*)::int FROM candidates) AS matched_count,
					(SELECT count(*)::int FROM deleted) AS deleted_count,
					EXISTS (SELECT 1 FROM dependents) AS has_dependents
			)
			SELECT
				summary.matched_count AS "matchedCount",
				summary.deleted_count AS "deletedCount",
				summary.has_dependents AS "hasDependents",
				deleted_counts.entity_id AS "entityId",
				deleted_counts.deleted_count AS "entityDeletedCount"
			FROM summary
			LEFT JOIN deleted_counts ON true
			ORDER BY deleted_counts.entity_id
		`,
		signal,
	);
	const row = rows[0];
	return {
		matchedCount: Number(row?.matchedCount ?? 0),
		deletedCount: Number(row?.deletedCount ?? 0),
		hasDependents: row?.hasDependents === true,
		deletedByEntity: rows.flatMap((detail) =>
			detail.entityId === null
				? []
				: [
						{
							entityId: detail.entityId,
							deletedCount: Number(detail.entityDeletedCount ?? 0),
						},
					],
		),
	};
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
	signal?: AbortSignal,
): Promise<Array<{ a: MemoryRow; b: MemoryRow; similarity: number }>> {
	const rows = await executeCancelableSql<Array<Record<string, unknown>>>(
		db,
		sql`
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
				${duplicateTagsFilter(input.tags)}
				AND 1 - (a.embedding <=> b.embedding) >= ${input.threshold}
			ORDER BY "similarity" DESC
			LIMIT ${input.limit}
		`,
		signal,
	);
	return rows.map((row) => {
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

export async function lockConsolidationMemories(
	db: MnemocyteDatabase,
	entityId: string,
	survivorId: string,
	supersededIds: readonly string[],
): Promise<Array<{ id: string; tags: string[]; supersededBy: string | null }>> {
	const ids = [...new Set([survivorId, ...supersededIds])].sort();
	return db
		.select({
			id: memoriesTable.id,
			tags: memoriesTable.tags,
			supersededBy: memoriesTable.supersededBy,
		})
		.from(memoriesTable)
		.where(
			and(eq(memoriesTable.entityId, entityId), inArray(memoriesTable.id, ids)),
		)
		.orderBy(memoriesTable.id)
		.for("update");
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

export async function markMemoriesAccessed(
	db: MnemocyteDatabase,
	memoryIds: readonly string[],
): Promise<
	Array<{
		id: string;
		lastAccessedAt: Date | null;
		accessCount: number;
		updatedAt: Date;
	}>
> {
	const now = new Date();
	if (memoryIds.length === 0) {
		return [];
	}
	return db
		.update(memoriesTable)
		.set({
			lastAccessedAt: now,
			accessCount: sql`${memoriesTable.accessCount} + 1`,
			updatedAt: now,
		})
		.where(inArray(memoriesTable.id, [...memoryIds]))
		.returning({
			id: memoriesTable.id,
			lastAccessedAt: memoriesTable.lastAccessedAt,
			accessCount: memoriesTable.accessCount,
			updatedAt: memoriesTable.updatedAt,
		});
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
	const vectorScore = clampedVectorScore(embedding);
	const minVectorScore = input.minVectorScore ?? 0;
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
			${vectorScore} AS "vectorScore"
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
			${rawTagsFilter(input.tags)}
			${input.before ? sql`AND created_at < ${timestampParam(input.before)}` : sql``}
			${input.after ? sql`AND created_at > ${timestampParam(input.after)}` : sql``}
			AND ${vectorScore} >= ${minVectorScore}
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
			${rawTagsFilter(input.tags)}
			${input.before ? sql`AND created_at < ${timestampParam(input.before)}` : sql``}
			${input.after ? sql`AND created_at > ${timestampParam(input.after)}` : sql``}
			AND to_tsvector('english', content) @@ websearch_to_tsquery('english', ${input.query})
		ORDER BY "lexicalScore" DESC
		LIMIT ${input.limit}
	`);
	return rows as unknown as LexicalSearchRow[];
}
