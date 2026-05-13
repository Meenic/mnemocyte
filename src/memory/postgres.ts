import { buildContext } from "../context/builder.js";
import type { DatabaseHandle } from "../db/index.js";
import { deleteEventsForEntity } from "../db/queries/events.js";
import {
	countPruneMatches,
	deleteMemoriesForEntity,
	deleteMemory,
	insertMemory,
	listMemories,
	type PruneFilter,
	pruneMemories,
} from "../db/queries/memories.js";
import { memoriesTable } from "../db/schema.js";
import { MnemocyteError } from "../errors.js";
import { observe } from "../observability.js";
import { hybridRecall } from "../retrieval/index.js";
import type {
	EntityStats,
	GlobalStats,
	ImportanceLevel,
	Memory,
	MnemocyteClient,
	MnemocyteConfig,
	PruneInput,
	PruneResult,
	RememberInput,
} from "../types.js";
import {
	assertLimit,
	assertMinScore,
	assertNonEmptyString,
	contextInputToRecallInput,
	createId,
	DEFAULT_IMPORTANCE,
	DEFAULT_LIMIT,
	DEFAULT_MIN_SCORE,
	DEFAULT_TYPE,
	embedOne,
	IMPORTANCE_RANK,
	isExpired,
	normalizeTags,
	rowToMemory,
	validatePruneInput,
	validateRecallInput,
	validateRememberInput,
} from "./shared.js";

const IMPORTANCE_LEVELS: readonly ImportanceLevel[] = [
	"low",
	"normal",
	"high",
	"critical",
];

function importanceCeilingLevels(
	max: ImportanceLevel,
): readonly ImportanceLevel[] {
	return IMPORTANCE_LEVELS.filter(
		(level) => IMPORTANCE_RANK[level] <= IMPORTANCE_RANK[max],
	);
}

function toPruneFilter(input: PruneInput): PruneFilter {
	const filter: PruneFilter = {};
	if (input.entityId !== undefined) {
		filter.entityId = input.entityId;
	}
	if (input.expired === true) {
		filter.expired = true;
	}
	if (input.superseded === true) {
		filter.superseded = true;
	}
	if (input.createdBefore !== undefined) {
		filter.createdBefore = input.createdBefore;
	}
	if (input.notAccessedSince !== undefined) {
		filter.notAccessedSince = input.notAccessedSince;
	}
	if (input.types !== undefined && input.types.length > 0) {
		filter.types = input.types;
	}
	if (input.tags !== undefined && input.tags.length > 0) {
		filter.tags = input.tags;
	}
	if (input.maxImportance !== undefined) {
		filter.maxImportanceLevels = importanceCeilingLevels(input.maxImportance);
	}
	return filter;
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
		return observe(
			config,
			"postgres",
			"remember",
			{ entityId: input.entityId },
			async () => {
				assertOpen();
				validateRememberInput(input);
				const embedding = await embedOne(config.embedder, input.content, {
					...(input.signal === undefined ? {} : { signal: input.signal }),
					...(config.provider === undefined
						? {}
						: { resilience: config.provider }),
				});
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
			},
			(memory) => ({ memoryId: memory.id, count: 1 }),
		);
	}

	return {
		remember,
		async rememberMany(inputs) {
			return observe(
				config,
				"postgres",
				"rememberMany",
				{ count: inputs.length },
				async () => {
					assertOpen();
					const result: Memory[] = [];
					for (const input of inputs) {
						result.push(await remember(input));
					}
					return result;
				},
				(result) => ({ count: result.length }),
			);
		},
		async recall(input) {
			return observe(
				config,
				"postgres",
				"recall",
				{ entityId: input.entityId },
				async () => {
					assertOpen();
					validateRecallInput(input);
					const limit = input.limit ?? config.defaults?.limit ?? DEFAULT_LIMIT;
					const minScore =
						input.minScore ?? config.defaults?.minScore ?? DEFAULT_MIN_SCORE;
					assertLimit(limit);
					assertMinScore(minScore);
					return hybridRecall({
						db: handle.db,
						embedder: config.embedder,
						input,
						limit,
						minScore,
						retrieval: config.retrieval,
						...(input.signal === undefined ? {} : { signal: input.signal }),
						...(config.provider === undefined
							? {}
							: { resilience: config.provider }),
					});
				},
				(result) => ({ count: result.length }),
			);
		},
		async buildContext(input) {
			return observe(
				config,
				"postgres",
				"buildContext",
				{ entityId: input.entityId },
				async () => {
					assertOpen();
					return buildContext({
						input,
						recall: (contextInput) => {
							const recallInput = contextInputToRecallInput(contextInput);
							return this.recall(
								input.signal === undefined
									? recallInput
									: { ...recallInput, signal: input.signal },
							);
						},
					});
				},
			);
		},
		async forget(input) {
			return observe(
				config,
				"postgres",
				"forget",
				{ entityId: input.entityId, memoryId: input.memoryId },
				async () => {
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
			);
		},
		async forgetAll(input) {
			return observe(
				config,
				"postgres",
				"forgetAll",
				{ entityId: input.entityId },
				async () => {
					assertOpen();
					assertNonEmptyString(input.entityId, "entityId");
					await Promise.all([
						deleteMemoriesForEntity(handle.db, input.entityId),
						deleteEventsForEntity(handle.db, input.entityId),
					]);
				},
			);
		},
		async prune(input: PruneInput): Promise<PruneResult> {
			return observe(
				config,
				"postgres",
				"prune",
				input.entityId === undefined ? {} : { entityId: input.entityId },
				async () => {
					assertOpen();
					validatePruneInput(input);
					const filter = toPruneFilter(input);
					const dryRun = input.dryRun === true;
					if (dryRun) {
						const matchedCount = await countPruneMatches(handle.db, filter);
						return { matchedCount, deletedCount: 0, dryRun: true };
					}
					const deletedCount = await pruneMemories(handle.db, filter);
					return {
						matchedCount: deletedCount,
						deletedCount,
						dryRun: false,
					};
				},
				(result) => ({ count: result.deletedCount }),
			);
		},
		async stats(input) {
			return observe(
				config,
				"postgres",
				"stats",
				input?.entityId ? { entityId: input.entityId } : {},
				async () => {
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
						entityCount: new Set(allMemories.map((memory) => memory.entityId))
							.size,
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
			);
		},
		async close() {
			return observe(config, "postgres", "close", {}, async () => {
				closed = true;
				await handle.close();
			});
		},
	};
}
