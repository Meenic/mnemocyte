import { buildContext } from "../context/builder.js";
import { MnemocyteError } from "../errors.js";
import { observe } from "../observability.js";
import {
	cosineSimilarity,
	lexicalScore,
	toScoredMemory,
} from "../retrieval/scorer.js";
import type {
	AuditEvent,
	ConsolidateInput,
	ConsolidateResult,
	DuplicatePair,
	EntityStats,
	ExperimentalMnemocyteClient,
	FindDuplicatesInput,
	GlobalStats,
	ListAuditLogInput,
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
	cloneMemory,
	contextInputToRecallInput,
	createEventId,
	createId,
	DEFAULT_DUPLICATE_LIMIT,
	DEFAULT_DUPLICATE_THRESHOLD,
	DEFAULT_IMPORTANCE,
	DEFAULT_LIMIT,
	DEFAULT_MIN_SCORE,
	DEFAULT_TYPE,
	embedMany,
	embedOne,
	isExpired,
	matchesDuplicateFilter,
	matchesPruneFilter,
	matchesRecallFilter,
	normalizeTags,
	type StoredMemory,
	validateConsolidateInput,
	validateFindDuplicatesInput,
	validateListAuditLogInput,
	validatePruneInput,
	validateRecallInput,
	validateRememberInput,
} from "./shared.js";

export function createInMemoryClient(config: MnemocyteConfig): MnemocyteClient {
	const memories = new Map<string, StoredMemory>();
	const auditLog: AuditEvent[] = [];
	let closed = false;

	function assertOpen(): void {
		if (closed) {
			throw new MnemocyteError("Mnemocyte client is closed.", "DB");
		}
	}

	function recordAudit(
		entityId: string,
		description: string,
		metadata: Record<string, unknown>,
	): void {
		if (config.audit?.enabled !== true) {
			return;
		}
		auditLog.push({
			id: createEventId(),
			entityId,
			description,
			metadata,
			timestamp: new Date(),
		});
	}

	function cloneAuditEvent(event: AuditEvent): AuditEvent {
		return {
			id: event.id,
			entityId: event.entityId,
			description: event.description,
			metadata: { ...event.metadata },
			timestamp: new Date(event.timestamp),
		};
	}

	async function remember(input: RememberInput): Promise<Memory> {
		return observe(
			config,
			"in-memory",
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
				const memory: StoredMemory = {
					id: createId(),
					entityId: input.entityId,
					content: input.content,
					type: input.type ?? DEFAULT_TYPE,
					importance: input.importance ?? DEFAULT_IMPORTANCE,
					tags: normalizeTags(input.tags),
					source: input.source ?? null,
					metadata: input.metadata ?? {},
					confidence: input.confidence ?? 1,
					embeddingModel: config.embedder.model,
					embeddingDimensions: config.embedder.dimensions,
					supersededBy: null,
					supersededAt: null,
					expiresAt: input.expiresAt ?? null,
					lastAccessedAt: null,
					accessCount: 0,
					createdAt: now,
					updatedAt: now,
					embedding,
				};
				memories.set(memory.id, memory);
				recordAudit(memory.entityId, "memory.created", {
					memoryId: memory.id,
					type: memory.type,
					importance: memory.importance,
				});
				return cloneMemory(memory);
			},
			(memory) => ({ memoryId: memory.id, count: 1 }),
		);
	}

	const client: MnemocyteClient = {
		remember,
		async rememberMany(inputs) {
			return observe(
				config,
				"in-memory",
				"rememberMany",
				{ count: inputs.length },
				async () => {
					assertOpen();
					if (inputs.length === 0) {
						return [];
					}
					for (const input of inputs) {
						validateRememberInput(input);
					}
					const embeddings = await embedMany(
						config.embedder,
						inputs.map((i) => i.content),
						{
							...(inputs[0]?.signal === undefined
								? {}
								: { signal: inputs[0].signal }),
							...(config.provider === undefined
								? {}
								: { resilience: config.provider }),
						},
					);
					const now = new Date();
					const result: Memory[] = [];
					for (let i = 0; i < inputs.length; i++) {
						const input = inputs[i] as RememberInput;
						const memory: StoredMemory = {
							id: createId(),
							entityId: input.entityId,
							content: input.content,
							type: input.type ?? DEFAULT_TYPE,
							importance: input.importance ?? DEFAULT_IMPORTANCE,
							tags: normalizeTags(input.tags),
							source: input.source ?? null,
							metadata: input.metadata ?? {},
							confidence: input.confidence ?? 1,
							embeddingModel: config.embedder.model,
							embeddingDimensions: config.embedder.dimensions,
							supersededBy: null,
							supersededAt: null,
							expiresAt: input.expiresAt ?? null,
							lastAccessedAt: null,
							accessCount: 0,
							createdAt: now,
							updatedAt: now,
							embedding: embeddings[i] as number[],
						};
						memories.set(memory.id, memory);
						recordAudit(memory.entityId, "memory.created", {
							memoryId: memory.id,
							type: memory.type,
							importance: memory.importance,
						});
						result.push(cloneMemory(memory));
					}
					return result;
				},
				(result) => ({ count: result.length }),
			);
		},
		async recall(input) {
			return observe(
				config,
				"in-memory",
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
					const queryEmbedding = await embedOne(config.embedder, input.query, {
						...(input.signal === undefined ? {} : { signal: input.signal }),
						...(config.provider === undefined
							? {}
							: { resilience: config.provider }),
					});
					const now = new Date();
					const scored = Array.from(memories.values())
						.filter((memory) => matchesRecallFilter(memory, input, now))
						.map((memory) =>
							toScoredMemory(
								memory,
								Math.max(0, cosineSimilarity(memory.embedding, queryEmbedding)),
								lexicalScore(memory.content, input.query),
								input,
								config.retrieval,
							),
						)
						.filter((memory) => memory.score >= minScore)
						.sort((a, b) => b.score - a.score)
						.slice(0, limit);
					for (const memory of scored) {
						const stored = memories.get(memory.id);
						if (stored) {
							stored.lastAccessedAt = now;
							stored.accessCount += 1;
							stored.updatedAt = now;
						}
					}
					return scored;
				},
				(result) => ({ count: result.length }),
			);
		},
		async buildContext(input) {
			return observe(
				config,
				"in-memory",
				"buildContext",
				{ entityId: input.entityId },
				async () => {
					assertOpen();
					return buildContext({
						input,
						recall: (contextInput) => {
							const recallInput = contextInputToRecallInput(contextInput);
							return client.recall(
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
				"in-memory",
				"forget",
				{ entityId: input.entityId, memoryId: input.memoryId },
				async () => {
					assertOpen();
					assertNonEmptyString(input.entityId, "entityId");
					assertNonEmptyString(input.memoryId, "memoryId");
					const memory = memories.get(input.memoryId);
					if (!memory || memory.entityId !== input.entityId) {
						throw new MnemocyteError("Memory was not found.", "NOT_FOUND");
					}
					memories.delete(input.memoryId);
					recordAudit(memory.entityId, "memory.deleted", {
						memoryId: memory.id,
					});
				},
			);
		},
		async forgetAll(input) {
			return observe(
				config,
				"in-memory",
				"forgetAll",
				{ entityId: input.entityId },
				async () => {
					assertOpen();
					assertNonEmptyString(input.entityId, "entityId");
					let deleted = 0;
					for (const [id, memory] of memories) {
						if (memory.entityId === input.entityId) {
							memories.delete(id);
							deleted += 1;
						}
					}
					recordAudit(input.entityId, "entity.cleared", { count: deleted });
					return deleted;
				},
				(count) => ({ count }),
			).then(() => undefined);
		},
		async prune(input: PruneInput): Promise<PruneResult> {
			return observe(
				config,
				"in-memory",
				"prune",
				input.entityId === undefined ? {} : { entityId: input.entityId },
				async () => {
					assertOpen();
					validatePruneInput(input);
					const now = new Date();
					const matched: string[] = [];
					for (const memory of memories.values()) {
						if (matchesPruneFilter(memory, input, now)) {
							matched.push(memory.id);
						}
					}
					const dryRun = input.dryRun === true;
					if (!dryRun) {
						for (const id of matched) {
							memories.delete(id);
						}
						if (matched.length > 0 && input.entityId !== undefined) {
							recordAudit(input.entityId, "memory.pruned", {
								count: matched.length,
							});
						}
					}
					return {
						matchedCount: matched.length,
						deletedCount: dryRun ? 0 : matched.length,
						dryRun,
					};
				},
				(result) => ({ count: result.deletedCount }),
			);
		},
		async findDuplicates(input: FindDuplicatesInput): Promise<DuplicatePair[]> {
			return observe(
				config,
				"in-memory",
				"findDuplicates",
				{ entityId: input.entityId },
				async () => {
					assertOpen();
					validateFindDuplicatesInput(input);
					const threshold = input.threshold ?? DEFAULT_DUPLICATE_THRESHOLD;
					const limit = input.limit ?? DEFAULT_DUPLICATE_LIMIT;
					const now = new Date();
					const candidates = Array.from(memories.values()).filter((memory) =>
						matchesDuplicateFilter(memory, input, now),
					);
					const pairs: DuplicatePair[] = [];
					for (let i = 0; i < candidates.length; i += 1) {
						const a = candidates[i];
						if (a === undefined) {
							continue;
						}
						for (let j = i + 1; j < candidates.length; j += 1) {
							const b = candidates[j];
							if (b === undefined) {
								continue;
							}
							const similarity = Math.max(
								0,
								Math.min(1, cosineSimilarity(a.embedding, b.embedding)),
							);
							if (similarity >= threshold) {
								pairs.push({
									a: cloneMemory(a),
									b: cloneMemory(b),
									similarity,
								});
							}
						}
					}
					pairs.sort((x, y) => y.similarity - x.similarity);
					return pairs.slice(0, limit);
				},
				(result) => ({ count: result.length }),
			);
		},
		async listAuditLog(input: ListAuditLogInput): Promise<AuditEvent[]> {
			return observe(
				config,
				"in-memory",
				"listAuditLog",
				{ entityId: input.entityId },
				async () => {
					assertOpen();
					validateListAuditLogInput(input);
					const limit = input.limit ?? 50;
					// Tag with the insertion index so events sharing a millisecond
					// timestamp still sort in causal (insertion) order.
					const indexed = auditLog.map((event, idx) => ({ event, idx }));
					const filtered = indexed
						.filter(({ event }) => {
							if (event.entityId !== input.entityId) {
								return false;
							}
							if (
								input.before !== undefined &&
								event.timestamp.getTime() >= input.before.getTime()
							) {
								return false;
							}
							if (
								input.after !== undefined &&
								event.timestamp.getTime() <= input.after.getTime()
							) {
								return false;
							}
							return true;
						})
						.sort((a, b) => {
							const dt =
								b.event.timestamp.getTime() - a.event.timestamp.getTime();
							if (dt !== 0) {
								return dt;
							}
							return b.idx - a.idx;
						})
						.slice(0, limit)
						.map(({ event }) => cloneAuditEvent(event));
					return filtered;
				},
				(result) => ({ count: result.length }),
			);
		},
		async stats(input) {
			return observe(
				config,
				"in-memory",
				"stats",
				input?.entityId ? { entityId: input.entityId } : {},
				async () => {
					assertOpen();
					const now = new Date();
					const allMemories = Array.from(memories.values());
					const selected = input?.entityId
						? allMemories.filter((memory) => memory.entityId === input.entityId)
						: allMemories;
					const activeMemoryCount = selected.filter(
						(memory) => !isExpired(memory, now) && memory.supersededBy === null,
					).length;
					const expiredMemoryCount = selected.filter((memory) =>
						isExpired(memory, now),
					).length;
					const supersededMemoryCount = selected.filter(
						(memory) => memory.supersededBy !== null,
					).length;
					if (input?.entityId) {
						return {
							entityId: input.entityId,
							memoryCount: selected.length,
							activeMemoryCount,
							expiredMemoryCount,
							supersededMemoryCount,
						} satisfies EntityStats;
					}
					return {
						entityCount: new Set(allMemories.map((memory) => memory.entityId))
							.size,
						memoryCount: selected.length,
						activeMemoryCount,
						expiredMemoryCount,
						supersededMemoryCount,
					} satisfies GlobalStats;
				},
			);
		},
		experimental: createExperimental(),
		async close() {
			return observe(config, "in-memory", "close", {}, async () => {
				closed = true;
				memories.clear();
			});
		},
	};
	return client;

	function createExperimental(): ExperimentalMnemocyteClient {
		return {
			async consolidate(input: ConsolidateInput): Promise<ConsolidateResult> {
				return observe(
					config,
					"in-memory",
					"consolidate",
					{ entityId: input.entityId, memoryId: input.survivorId },
					async () => {
						assertOpen();
						validateConsolidateInput(input);
						const survivor = memories.get(input.survivorId);
						if (!survivor || survivor.entityId !== input.entityId) {
							throw new MnemocyteError(
								"Survivor memory was not found.",
								"NOT_FOUND",
							);
						}
						if (survivor.supersededBy !== null) {
							throw new MnemocyteError(
								"Survivor memory is itself superseded.",
								"VALIDATION",
							);
						}
						const losers: StoredMemory[] = [];
						for (const id of input.supersededIds) {
							const memory = memories.get(id);
							if (!memory || memory.entityId !== input.entityId) {
								throw new MnemocyteError(
									"Superseded memory was not found.",
									"NOT_FOUND",
								);
							}
							if (memory.supersededBy !== null) {
								// Idempotent skip: already superseded.
								continue;
							}
							losers.push(memory);
						}
						const now = new Date();
						const newSupersededIds: string[] = [];
						for (const loser of losers) {
							loser.supersededBy = survivor.id;
							loser.supersededAt = now;
							loser.updatedAt = now;
							newSupersededIds.push(loser.id);
							recordAudit(input.entityId, "memory.superseded", {
								memoryId: loser.id,
								supersededBy: survivor.id,
							});
						}
						const shouldMergeTags =
							input.mergeTags !== false && losers.length > 0;
						if (shouldMergeTags) {
							const mergedTags = new Set(survivor.tags);
							for (const loser of losers) {
								for (const tag of loser.tags) {
									mergedTags.add(tag);
								}
							}
							if (mergedTags.size !== survivor.tags.length) {
								survivor.tags = [...mergedTags];
								survivor.updatedAt = now;
							}
						}
						return {
							survivorId: survivor.id,
							supersededCount: newSupersededIds.length,
							supersededIds: newSupersededIds,
						} satisfies ConsolidateResult;
					},
					(result) => ({ count: result.supersededCount }),
				);
			},
		};
	}
}
