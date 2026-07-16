import { buildContext } from "../context/builder.js";
import { MnemocyteError } from "../errors.js";
import { observe } from "../observability.js";
import { throwIfAborted } from "../resilience.js";
import {
	cosineSimilarity,
	createLexicalScorer,
	createScoringConfig,
	DEFAULT_CANDIDATE_MULTIPLIER,
	toScoredMemoryWithConfig,
	toVectorScore,
} from "../retrieval/scorer.js";
import type {
	AuditEvent,
	ConsolidateInput,
	ConsolidateResult,
	DuplicatePair,
	JsonObject,
	Memory,
	MemoryWithScore,
	MnemocyteClient,
	MnemocyteConfig,
	MnemocyteOperation,
	RecallInput,
	RememberInput,
	RememberManyInput,
} from "../types.js";
import {
	DEFAULT_IMPORTANCE,
	DEFAULT_LIMIT,
	DEFAULT_MIN_SCORE,
	DEFAULT_TYPE,
} from "./defaults.js";
import { embedMany, embedOne } from "./embeddings.js";
import { cloneJsonObject } from "./json.js";
import {
	cloneMemory,
	createEventId,
	createId,
	normalizeTags,
} from "./records.js";
import type { MemoryStore } from "./store.js";
import {
	assertLimit,
	assertMinScore,
	assertNonEmptyString,
	contextInputToRecallInput,
	validateBuildContextInput,
	validateConsolidateInput,
	validateFindDuplicatesInput,
	validateListAuditLogInput,
	validatePruneInput,
	validateRecallInput,
	validateRememberInput,
} from "./validation.js";

interface ScoredCandidate {
	memory: Memory;
	vectorScore: number;
	lexicalScore: number;
}

interface OperationMetadata {
	entityId?: string;
	memoryId?: string;
	count?: number;
}

function isPositionalRememberManyInput(
	input: RememberManyInput | readonly RememberInput[],
): input is readonly RememberInput[] {
	return Array.isArray(input);
}

function providerOptions(
	config: MnemocyteConfig,
	signal: AbortSignal | undefined,
) {
	return {
		...(signal === undefined ? {} : { signal }),
		...(config.provider === undefined ? {} : { resilience: config.provider }),
	};
}

function storeOptions(signal: AbortSignal | undefined) {
	return signal === undefined ? undefined : { signal };
}

function snapshotRememberInput(input: RememberInput): RememberInput {
	return {
		...input,
		...(input.tags === undefined
			? {}
			: { tags: Array.isArray(input.tags) ? [...input.tags] : input.tags }),
		metadata: cloneJsonObject(input.metadata ?? {}),
		...(input.expiresAt === undefined
			? {}
			: {
					expiresAt:
						input.expiresAt instanceof Date
							? new Date(input.expiresAt)
							: input.expiresAt,
				}),
	};
}

function createStoredMemory(
	config: MnemocyteConfig,
	input: RememberInput,
	embedding: number[],
	now: Date,
) {
	return {
		id: createId(),
		entityId: input.entityId,
		content: input.content,
		type: input.type ?? DEFAULT_TYPE,
		importance: input.importance ?? DEFAULT_IMPORTANCE,
		tags: normalizeTags(input.tags),
		source: input.source ?? null,
		metadata: cloneJsonObject(input.metadata ?? {}),
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
}

function auditEvent(
	entityId: string,
	description: string,
	metadata: JsonObject,
	timestamp = new Date(),
): AuditEvent {
	return {
		id: createEventId(),
		entityId,
		description,
		metadata: cloneJsonObject(metadata),
		timestamp,
	};
}

function toDuplicatePair(pair: {
	a: Memory;
	b: Memory;
	similarity: number;
}): DuplicatePair {
	return {
		a: cloneMemory(pair.a),
		b: cloneMemory(pair.b),
		similarity: Math.max(0, Math.min(1, pair.similarity)),
	};
}

export function createMemoryClient(
	config: MnemocyteConfig,
	store: MemoryStore,
): MnemocyteClient {
	type ClientState = "open" | "closing" | "closed";

	let state: ClientState = "open";
	let activeOperations = 0;
	let operationsDrainedPromise: Promise<void> | undefined;
	let resolveOperationsDrained: (() => void) | undefined;
	let closePromise: Promise<void> | undefined;

	function assertOpen(): void {
		if (state === "closed") {
			throw new MnemocyteError("Mnemocyte client is closed.", "DB");
		}
	}

	function beginOperation(): () => void {
		if (state !== "open") {
			throw new MnemocyteError("Mnemocyte client is closed.", "DB");
		}
		activeOperations += 1;
		let completed = false;
		return () => {
			if (completed) {
				return;
			}
			completed = true;
			activeOperations -= 1;
			if (activeOperations === 0 && resolveOperationsDrained) {
				const resolve = resolveOperationsDrained;
				resolveOperationsDrained = undefined;
				operationsDrainedPromise = undefined;
				resolve();
			}
		};
	}

	function runOperation<T>(
		operationName: MnemocyteOperation,
		metadata: OperationMetadata,
		operation: () => Promise<T>,
	): Promise<T> {
		let complete: () => void;
		try {
			complete = beginOperation();
		} catch (error) {
			return observe(
				config,
				store.backend,
				operationName,
				metadata,
				async () => {
					throw error;
				},
			);
		}
		try {
			return operation().then(
				(result) => {
					complete();
					return result;
				},
				(error: unknown) => {
					complete();
					throw error;
				},
			);
		} catch (error) {
			complete();
			return Promise.reject(error);
		}
	}

	function waitForActiveOperations(): Promise<void> {
		if (activeOperations === 0) {
			return Promise.resolve();
		}
		if (!operationsDrainedPromise) {
			operationsDrainedPromise = new Promise<void>((resolve) => {
				resolveOperationsDrained = resolve;
			});
		}
		return operationsDrainedPromise;
	}

	async function ensureSchema(): Promise<void> {
		await store.ensureSchema();
	}

	async function ensureEmbeddingCompatibility(): Promise<void> {
		await store.ensureEmbeddingCompatibility(config.embedder);
	}

	async function recordAudit(events: readonly AuditEvent[]): Promise<void> {
		if (events.length === 0 || config.audit?.enabled !== true) {
			return;
		}
		try {
			await store.addAuditEvents(events);
		} catch {
			// Audit writes must not break the primary operation.
		}
	}

	function remember(input: RememberInput): Promise<Memory> {
		return runOperation("remember", { entityId: input.entityId }, () => {
			const preparedInput = snapshotRememberInput(input);
			return observe(
				config,
				store.backend,
				"remember",
				{ entityId: preparedInput.entityId },
				async () => {
					assertOpen();
					validateRememberInput(preparedInput);
					await ensureEmbeddingCompatibility();
					const embedding = await embedOne(
						config.embedder,
						preparedInput.content,
						providerOptions(config, preparedInput.signal),
					);
					const [memory] = await store.insertMemories([
						createStoredMemory(config, preparedInput, embedding, new Date()),
					]);
					if (!memory) {
						throw new MnemocyteError("Memory insert returned no rows.", "DB");
					}
					await recordAudit([
						auditEvent(memory.entityId, "memory.created", {
							memoryId: memory.id,
							type: memory.type,
							importance: memory.importance,
						}),
					]);
					return cloneMemory(memory);
				},
				(memory) => ({ memoryId: memory.id, count: 1 }),
			);
		});
	}

	function rememberMany(
		input: RememberManyInput | readonly RememberInput[],
	): Promise<Memory[]> {
		return runOperation(
			"rememberMany",
			{
				count: isPositionalRememberManyInput(input)
					? input.length
					: input.inputs.length,
			},
			() => {
				const positional = isPositionalRememberManyInput(input);
				const inputs = positional ? input : input.inputs;
				const signal = positional ? input[0]?.signal : input.signal;
				const preparedInputs = inputs.map(snapshotRememberInput);
				return observe(
					config,
					store.backend,
					"rememberMany",
					{ count: preparedInputs.length },
					async () => {
						assertOpen();
						if (preparedInputs.length === 0) {
							return [];
						}
						for (const item of preparedInputs) {
							validateRememberInput(item);
						}
						await ensureEmbeddingCompatibility();
						const embeddings = await embedMany(
							config.embedder,
							preparedInputs.map((item) => item.content),
							providerOptions(config, signal),
						);
						const now = new Date();
						const stored = preparedInputs.map((item, idx) =>
							createStoredMemory(
								config,
								item,
								embeddings[idx] as number[],
								now,
							),
						);
						const memories = await store.insertMemories(stored);
						await recordAudit(
							memories.map((memory) =>
								auditEvent(memory.entityId, "memory.created", {
									memoryId: memory.id,
									type: memory.type,
									importance: memory.importance,
								}),
							),
						);
						return memories.map(cloneMemory);
					},
					(result) => ({ count: result.length }),
				);
			},
		);
	}

	function recall(input: RecallInput): Promise<MemoryWithScore[]> {
		return observe(
			config,
			store.backend,
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
				await ensureEmbeddingCompatibility();
				const queryEmbedding = await embedOne(
					config.embedder,
					input.query,
					providerOptions(config, input.signal),
				);
				const candidateMultiplier =
					config.retrieval?.candidateMultiplier ?? DEFAULT_CANDIDATE_MULTIPLIER;
				const candidateLimit = Math.max(limit, limit * candidateMultiplier);
				const scoreLexical = createLexicalScorer(input.query);
				const scoringConfig = createScoringConfig(config.retrieval);
				const [vectorCandidates, lexicalCandidates] = await Promise.all([
					store.vectorSearch({
						...input,
						embedding: queryEmbedding,
						limit: candidateLimit,
						minVectorScore: 0,
					}),
					store.lexicalSearch({ ...input, limit: candidateLimit }),
				]);
				const merged = new Map<string, ScoredCandidate>();
				for (const candidate of vectorCandidates) {
					merged.set(candidate.memory.id, {
						memory: candidate.memory,
						vectorScore: candidate.vectorScore,
						lexicalScore: scoreLexical(candidate.memory.content),
					});
				}
				const lexicalOnly = lexicalCandidates.filter(
					(candidate) => !merged.has(candidate.memory.id),
				);
				const lexicalOnlyEmbeddings = await store.getMemoryEmbeddings(
					lexicalOnly.map((candidate) => candidate.memory.id),
				);
				for (const candidate of lexicalCandidates) {
					const existing = merged.get(candidate.memory.id);
					if (existing) {
						existing.lexicalScore = candidate.lexicalScore;
						continue;
					}
					const embedding = lexicalOnlyEmbeddings.get(candidate.memory.id);
					const similarity = embedding
						? cosineSimilarity(embedding, queryEmbedding)
						: 0;
					merged.set(candidate.memory.id, {
						memory: candidate.memory,
						vectorScore: toVectorScore(similarity),
						lexicalScore: candidate.lexicalScore,
					});
				}
				const scored: MemoryWithScore[] = Array.from(merged.values())
					.map((entry) =>
						toScoredMemoryWithConfig(
							entry.memory,
							Math.max(0, entry.vectorScore),
							Math.max(0, entry.lexicalScore),
							input,
							scoringConfig,
						),
					)
					.filter((memory) => memory.score >= minScore)
					.sort((a, b) => b.score - a.score)
					.slice(0, limit);
				await store.markMemoriesAccessed(scored.map((memory) => memory.id));
				return scored;
			},
			(result) => ({ count: result.length }),
		);
	}

	const client: MnemocyteClient = {
		remember,
		rememberMany,
		recall(input) {
			return runOperation("recall", { entityId: input.entityId }, () =>
				recall(input),
			);
		},
		buildContext(input) {
			return runOperation("buildContext", { entityId: input.entityId }, () =>
				observe(
					config,
					store.backend,
					"buildContext",
					{ entityId: input.entityId },
					async () => {
						assertOpen();
						validateBuildContextInput(input);
						return buildContext({
							input,
							recall: (contextInput) => {
								const recallInput = contextInputToRecallInput(contextInput);
								return recall(
									input.signal === undefined
										? recallInput
										: { ...recallInput, signal: input.signal },
								);
							},
						});
					},
				),
			);
		},
		forget(input) {
			return runOperation(
				"forget",
				{ entityId: input.entityId, memoryId: input.memoryId },
				() =>
					observe(
						config,
						store.backend,
						"forget",
						{ entityId: input.entityId, memoryId: input.memoryId },
						async () => {
							assertOpen();
							assertNonEmptyString(input.entityId, "entityId");
							assertNonEmptyString(input.memoryId, "memoryId");
							await ensureSchema();
							const deleted = await store.deleteMemory(
								input.entityId,
								input.memoryId,
							);
							if (!deleted) {
								throw new MnemocyteError("Memory was not found.", "NOT_FOUND");
							}
							await recordAudit([
								auditEvent(input.entityId, "memory.deleted", {
									memoryId: input.memoryId,
								}),
							]);
						},
					),
			);
		},
		forgetAll(input) {
			return runOperation("forgetAll", { entityId: input.entityId }, () =>
				observe(
					config,
					store.backend,
					"forgetAll",
					{ entityId: input.entityId },
					async () => {
						assertOpen();
						assertNonEmptyString(input.entityId, "entityId");
						await ensureSchema();
						const deletedCount = await store.deleteMemoriesForEntity(
							input.entityId,
						);
						await recordAudit([
							auditEvent(input.entityId, "entity.cleared", {
								count: deletedCount,
							}),
						]);
						return deletedCount;
					},
					(count) => ({ count }),
				).then(() => undefined),
			);
		},
		prune(input) {
			return runOperation(
				"prune",
				input.entityId === undefined ? {} : { entityId: input.entityId },
				() =>
					observe(
						config,
						store.backend,
						"prune",
						input.entityId === undefined ? {} : { entityId: input.entityId },
						async () => {
							assertOpen();
							throwIfAborted(input.signal);
							const filter = validatePruneInput(input);
							await ensureSchema();
							const result = await store.prune(
								filter,
								storeOptions(input.signal),
							);
							if (
								result.deletedCount > 0 &&
								input.entityId !== undefined &&
								result.dryRun === false
							) {
								await recordAudit([
									auditEvent(input.entityId, "memory.pruned", {
										count: result.deletedCount,
									}),
								]);
							}
							return result;
						},
						(result) => ({ count: result.deletedCount }),
					),
			);
		},
		findDuplicates(input) {
			return runOperation("findDuplicates", { entityId: input.entityId }, () =>
				observe(
					config,
					store.backend,
					"findDuplicates",
					{ entityId: input.entityId },
					async () => {
						assertOpen();
						throwIfAborted(input.signal);
						validateFindDuplicatesInput(input);
						await ensureEmbeddingCompatibility();
						const pairs = await store.findDuplicatePairs(
							input,
							storeOptions(input.signal),
						);
						return pairs.map(toDuplicatePair);
					},
					(result) => ({ count: result.length }),
				),
			);
		},
		listAuditLog(input) {
			return runOperation("listAuditLog", { entityId: input.entityId }, () =>
				observe(
					config,
					store.backend,
					"listAuditLog",
					{ entityId: input.entityId },
					async () => {
						assertOpen();
						throwIfAborted(input.signal);
						validateListAuditLogInput(input);
						await ensureSchema();
						const events = await store.listAuditLog(
							input,
							storeOptions(input.signal),
						);
						return events.map((event) => ({
							id: event.id,
							entityId: event.entityId,
							description: event.description,
							metadata: cloneJsonObject(event.metadata),
							timestamp: new Date(event.timestamp),
						}));
					},
					(result) => ({ count: result.length }),
				),
			);
		},
		stats(input) {
			return runOperation(
				"stats",
				input?.entityId ? { entityId: input.entityId } : {},
				() =>
					observe(
						config,
						store.backend,
						"stats",
						input?.entityId ? { entityId: input.entityId } : {},
						async () => {
							assertOpen();
							await ensureSchema();
							return store.stats(input, new Date());
						},
					),
			);
		},
		experimental: {
			consolidate(input: ConsolidateInput): Promise<ConsolidateResult> {
				return runOperation(
					"consolidate",
					{ entityId: input.entityId, memoryId: input.survivorId },
					() =>
						observe(
							config,
							store.backend,
							"consolidate",
							{ entityId: input.entityId, memoryId: input.survivorId },
							async () => {
								assertOpen();
								throwIfAborted(input.signal);
								validateConsolidateInput(input);
								await ensureSchema();
								const survivor = await store.getMemory(
									input.entityId,
									input.survivorId,
									storeOptions(input.signal),
								);
								throwIfAborted(input.signal);
								if (!survivor) {
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
								const targets = await store.loadConsolidationTargets(
									input.entityId,
									input.supersededIds,
									storeOptions(input.signal),
								);
								throwIfAborted(input.signal);
								const foundIds = new Set(targets.map((target) => target.id));
								for (const id of input.supersededIds) {
									if (!foundIds.has(id)) {
										throw new MnemocyteError(
											"Superseded memory was not found.",
											"NOT_FOUND",
										);
									}
								}
								const losers = targets.filter(
									(target) => target.supersededBy === null,
								);
								if (losers.length === 0) {
									return {
										survivorId: survivor.id,
										supersededCount: 0,
										supersededIds: [],
									} satisfies ConsolidateResult;
								}
								const result = await store.consolidate(
									{
										entityId: input.entityId,
										survivorId: survivor.id,
										survivorTags: survivor.tags,
										supersededIds: losers.map((loser) => loser.id),
										mergeTags: input.mergeTags !== false,
										now: new Date(),
										auditEnabled: config.audit?.enabled === true,
									},
									storeOptions(input.signal),
								);
								return {
									survivorId: survivor.id,
									supersededCount: result.supersededIds.length,
									supersededIds: result.supersededIds,
								} satisfies ConsolidateResult;
							},
							(result) => ({ count: result.supersededCount }),
						),
				);
			},
		},
		close() {
			if (closePromise) {
				return closePromise;
			}
			state = "closing";
			closePromise = observe(config, store.backend, "close", {}, async () => {
				await waitForActiveOperations();
				try {
					await store.close();
					state = "closed";
				} catch (error) {
					state = "open";
					closePromise = undefined;
					throw error;
				}
			});
			return closePromise;
		},
	};

	return client;
}
