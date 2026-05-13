import type { DatabaseHandle } from "../db/index.js";
import { deleteEventsForEntity } from "../db/queries/events.js";
import {
	deleteMemoriesForEntity,
	deleteMemory,
	insertMemory,
	lexicalSearch,
	listMemories,
	markMemoryAccessed,
	vectorSearch,
} from "../db/queries/memories.js";
import { type MemoryRow, memoriesTable } from "../db/schema.js";
import { MnemocyteError } from "../errors.js";
import { toScoredMemory } from "../retrieval/scorer.js";
import type {
	EntityStats,
	GlobalStats,
	Memory,
	MnemocyteClient,
	MnemocyteConfig,
	RememberInput,
} from "../types.js";
import {
	assertLimit,
	assertMinScore,
	assertNonEmptyString,
	createId,
	DEFAULT_IMPORTANCE,
	DEFAULT_LIMIT,
	DEFAULT_MIN_SCORE,
	DEFAULT_TYPE,
	embedOne,
	isExpired,
	normalizeTags,
	rowToMemory,
	validateRecallInput,
	validateRememberInput,
} from "./shared.js";

interface ScoredRow {
	row: MemoryRow;
	vectorScore: number;
	lexicalScore: number;
}

export function createPostgresClient(
	config: MnemocyteConfig,
	handle: DatabaseHandle,
): MnemocyteClient {
	let closed = false;

	function assertOpen(): void {
		if (closed) {
			throw new MnemocyteError("Mnemocyte client is closed.", "DB");
		}
	}

	async function remember(input: RememberInput): Promise<Memory> {
		assertOpen();
		validateRememberInput(input);
		const embedding = await embedOne(config.embedder, input.content);
		const now = new Date();
		const row = await insertMemory(handle.db, {
			id: createId(),
			entityId: input.entityId,
			content: input.content,
			type: input.type ?? DEFAULT_TYPE,
			importance: input.importance ?? DEFAULT_IMPORTANCE,
			tags: normalizeTags(input.tags),
			source: input.source ?? null,
			metadata: input.metadata ?? {},
			confidence: input.confidence ?? 1,
			embedding,
			embeddingModel: config.embedder.model,
			embeddingDimensions: config.embedder.dimensions,
			supersededBy: null,
			supersededAt: null,
			expiresAt: input.expiresAt ?? null,
			lastAccessedAt: null,
			accessCount: 0,
			createdAt: now,
			updatedAt: now,
		});
		return rowToMemory(row);
	}

	return {
		remember,
		async rememberMany(inputs) {
			assertOpen();
			const result: Memory[] = [];
			for (const input of inputs) {
				result.push(await remember(input));
			}
			return result;
		},
		async recall(input) {
			assertOpen();
			validateRecallInput(input);
			const limit = input.limit ?? config.defaults?.limit ?? DEFAULT_LIMIT;
			const minScore =
				input.minScore ?? config.defaults?.minScore ?? DEFAULT_MIN_SCORE;
			assertLimit(limit);
			assertMinScore(minScore);
			const queryEmbedding = await embedOne(config.embedder, input.query);
			const [vectorRows, lexicalRows] = await Promise.all([
				vectorSearch(handle.db, {
					...input,
					embedding: queryEmbedding,
					limit: limit * 2,
					minScore: 0,
				}),
				lexicalSearch(handle.db, { ...input, limit: limit * 2 }),
			]);
			const merged = new Map<string, ScoredRow>();
			for (const row of vectorRows) {
				merged.set(row.id, {
					row,
					vectorScore: row.vectorScore,
					lexicalScore: 0,
				});
			}
			for (const row of lexicalRows) {
				const existing = merged.get(row.id);
				if (existing) {
					existing.lexicalScore = row.lexicalScore;
				} else {
					merged.set(row.id, {
						row,
						vectorScore: 0,
						lexicalScore: row.lexicalScore,
					});
				}
			}
			const scored = Array.from(merged.values())
				.map((entry) =>
					toScoredMemory(
						rowToMemory(entry.row),
						Math.max(0, entry.vectorScore),
						Math.max(0, entry.lexicalScore),
						input,
					),
				)
				.filter((memory) => memory.score >= minScore)
				.sort((a, b) => b.score - a.score)
				.slice(0, limit);
			await markMemoryAccessed(
				handle.db,
				scored.map((memory) => memory.id),
			);
			return scored;
		},
		async forget(input) {
			assertOpen();
			assertNonEmptyString(input.entityId, "entityId");
			assertNonEmptyString(input.memoryId, "memoryId");
			const deleted = await deleteMemory(
				handle.db,
				input.entityId,
				input.memoryId,
			);
			if (!deleted) {
				throw new MnemocyteError("Memory was not found.", "NOT_FOUND");
			}
		},
		async forgetAll(input) {
			assertOpen();
			assertNonEmptyString(input.entityId, "entityId");
			await Promise.all([
				deleteMemoriesForEntity(handle.db, input.entityId),
				deleteEventsForEntity(handle.db, input.entityId),
			]);
		},
		async stats(input) {
			assertOpen();
			const now = new Date();
			if (input?.entityId) {
				const selected = await listMemories(handle.db, {
					entityId: input.entityId,
					includeExpired: true,
					includeSuperseded: true,
				});
				return {
					entityId: input.entityId,
					memoryCount: selected.length,
					activeMemoryCount: selected.filter(
						(memory) =>
							!isExpired(rowToMemory(memory), now) &&
							memory.supersededBy === null,
					).length,
					expiredMemoryCount: selected.filter((memory) =>
						isExpired(rowToMemory(memory), now),
					).length,
					supersededMemoryCount: selected.filter(
						(memory) => memory.supersededBy !== null,
					).length,
				} satisfies EntityStats;
			}
			const allMemories = await handle.db.select().from(memoriesTable);
			return {
				entityCount: new Set(allMemories.map((memory) => memory.entityId)).size,
				memoryCount: allMemories.length,
				activeMemoryCount: allMemories.filter(
					(memory) =>
						!isExpired(rowToMemory(memory), now) &&
						memory.supersededBy === null,
				).length,
				expiredMemoryCount: allMemories.filter((memory) =>
					isExpired(rowToMemory(memory), now),
				).length,
				supersededMemoryCount: allMemories.filter(
					(memory) => memory.supersededBy !== null,
				).length,
			} satisfies GlobalStats;
		},
		async close() {
			closed = true;
			await handle.close();
		},
	};
}
