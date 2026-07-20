import { MnemocyteError } from "../errors.js";
import { DEFAULT_RETRIEVAL_WEIGHTS } from "../retrieval/scorer.js";
import type {
	AuditLogCursor,
	BuildContextInput,
	ConsolidateInput,
	Embedder,
	FindDuplicatesInput,
	ImportanceLevel,
	ListAuditLogInput,
	MemoryType,
	ProviderResilienceConfig,
	PruneInput,
	RecallInput,
	RememberInput,
	RetrievalConfig,
	RetrievalScoreWeights,
} from "../types.js";
import type { OwnedJsonObject } from "./json.js";
import {
	assertPruneFilterHasSelector,
	type ValidatedPruneFilter,
} from "./store.js";

const MEMORY_TYPES = [
	"fact",
	"preference",
	"instruction",
	"backstory",
	"episode",
	"session",
] as const satisfies readonly MemoryType[];

const IMPORTANCE_LEVELS = [
	"low",
	"normal",
	"high",
	"critical",
] as const satisfies readonly ImportanceLevel[];

export interface PreparedRememberInput extends Omit<RememberInput, "metadata"> {
	metadata: OwnedJsonObject;
}

function isMemoryType(value: unknown): value is MemoryType {
	return (
		typeof value === "string" &&
		(MEMORY_TYPES as readonly string[]).includes(value)
	);
}

function isImportanceLevel(value: unknown): value is ImportanceLevel {
	return (
		typeof value === "string" &&
		(IMPORTANCE_LEVELS as readonly string[]).includes(value)
	);
}

function assertMemoryType(
	value: unknown,
	field: string,
): asserts value is MemoryType {
	if (!isMemoryType(value)) {
		throw new MnemocyteError(
			`${field} must be a known memory type.`,
			"VALIDATION",
		);
	}
}

function assertImportanceLevel(
	value: unknown,
	field: string,
): asserts value is ImportanceLevel {
	if (!isImportanceLevel(value)) {
		throw new MnemocyteError(
			`${field} must be a known importance level.`,
			"VALIDATION",
		);
	}
}

function assertMemoryTypeArray(
	value: unknown,
	field: string,
): asserts value is readonly MemoryType[] {
	if (!Array.isArray(value)) {
		throw new MnemocyteError(`${field} must be an array.`, "VALIDATION");
	}
	for (const item of value) {
		if (!isMemoryType(item)) {
			throw new MnemocyteError(
				`${field} must contain only known memory types.`,
				"VALIDATION",
			);
		}
	}
}

function assertValidDate(value: unknown, field: string): asserts value is Date {
	if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
		throw new MnemocyteError(`${field} must be a valid Date.`, "VALIDATION");
	}
}

export function assertNonEmptyString(
	value: unknown,
	field: string,
	code: "CONFIG" | "VALIDATION" = "VALIDATION",
): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new MnemocyteError(`${field} must be a non-empty string.`, code);
	}
}

export function assertLimit(value: number): void {
	if (!Number.isInteger(value) || value < 1) {
		throw new MnemocyteError("limit must be a positive integer.", "VALIDATION");
	}
}

export function assertMinScore(value: number): void {
	if (!Number.isFinite(value) || value < 0 || value > 1) {
		throw new MnemocyteError(
			"minScore must be a number between 0 and 1.",
			"VALIDATION",
		);
	}
}

export function assertEmbedder(embedder: Embedder): void {
	if (!embedder || typeof embedder.embed !== "function") {
		throw new MnemocyteError(
			"embedder with an embed function is required.",
			"CONFIG",
		);
	}
	assertNonEmptyString(embedder.model, "embedder.model", "CONFIG");
	if (!Number.isInteger(embedder.dimensions) || embedder.dimensions < 1) {
		throw new MnemocyteError(
			"embedder.dimensions must be a positive integer.",
			"CONFIG",
		);
	}
}

const RETRIEVAL_WEIGHT_KEYS = [
	"vector",
	"lexical",
	"recency",
	"confidence",
	"access",
	"importance",
] as const satisfies readonly (keyof RetrievalScoreWeights)[];

function assertPositiveFiniteConfigValue(value: number, field: string): void {
	if (!Number.isFinite(value) || value <= 0) {
		throw new MnemocyteError(
			`${field} must be a positive finite number.`,
			"CONFIG",
		);
	}
}

export function validateRetrievalConfig(
	config: RetrievalConfig | undefined,
): void {
	if (config === undefined) {
		return;
	}

	let weightTotal = 0;
	for (const key of RETRIEVAL_WEIGHT_KEYS) {
		const weight = config.weights?.[key] ?? DEFAULT_RETRIEVAL_WEIGHTS[key];
		if (!Number.isFinite(weight) || weight < 0) {
			throw new MnemocyteError(
				`retrieval.weights.${key} must be a non-negative finite number.`,
				"CONFIG",
			);
		}
		weightTotal += weight;
	}
	if (weightTotal === 0) {
		throw new MnemocyteError(
			"retrieval.weights must have an effective total greater than zero.",
			"CONFIG",
		);
	}

	if (config.recencyHalfLifeDays !== undefined) {
		assertPositiveFiniteConfigValue(
			config.recencyHalfLifeDays,
			"retrieval.recencyHalfLifeDays",
		);
	}
	if (config.accessSaturation !== undefined) {
		assertPositiveFiniteConfigValue(
			config.accessSaturation,
			"retrieval.accessSaturation",
		);
	}
	if (
		config.candidateMultiplier !== undefined &&
		(!Number.isInteger(config.candidateMultiplier) ||
			config.candidateMultiplier < 1)
	) {
		throw new MnemocyteError(
			"retrieval.candidateMultiplier must be an integer greater than or equal to 1.",
			"CONFIG",
		);
	}
}

export function validateProviderResilienceConfig(
	config: ProviderResilienceConfig | undefined,
): void {
	if (config === undefined) {
		return;
	}
	if (typeof config !== "object" || config === null || Array.isArray(config)) {
		throw new MnemocyteError("provider must be an object.", "CONFIG");
	}

	for (const [field, value] of [
		["provider.timeoutMs", config.timeoutMs],
		["provider.baseDelayMs", config.baseDelayMs],
		["provider.maxDelayMs", config.maxDelayMs],
	] as const) {
		if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
			throw new MnemocyteError(
				`${field} must be a non-negative finite number.`,
				"CONFIG",
			);
		}
	}
	if (
		config.retries !== undefined &&
		(!Number.isInteger(config.retries) || config.retries < 0)
	) {
		throw new MnemocyteError(
			"provider.retries must be a non-negative integer.",
			"CONFIG",
		);
	}
	if (
		config.shouldRetry !== undefined &&
		typeof config.shouldRetry !== "function"
	) {
		throw new MnemocyteError(
			"provider.shouldRetry must be a function.",
			"CONFIG",
		);
	}
}

export function validateBuildContextInput(input: BuildContextInput): void {
	if (
		input.maxTokens !== undefined &&
		(!Number.isInteger(input.maxTokens) || input.maxTokens < 1)
	) {
		throw new MnemocyteError(
			"maxTokens must be a positive integer when supplied.",
			"VALIDATION",
		);
	}
}

export function validateRememberInput(input: PreparedRememberInput): void {
	assertNonEmptyString(input.entityId, "entityId");
	assertNonEmptyString(input.content, "content");
	if (input.type !== undefined) {
		assertMemoryType(input.type, "type");
	}
	if (input.importance !== undefined) {
		assertImportanceLevel(input.importance, "importance");
	}
	if (input.tags !== undefined) {
		if (!Array.isArray(input.tags)) {
			throw new MnemocyteError("tags must be an array.", "VALIDATION");
		}
		for (const tag of input.tags as readonly unknown[]) {
			if (typeof tag !== "string") {
				throw new MnemocyteError(
					"tags must contain only strings.",
					"VALIDATION",
				);
			}
		}
	}
	if (input.source !== undefined && typeof input.source !== "string") {
		throw new MnemocyteError("source must be a string.", "VALIDATION");
	}
	if (
		input.confidence !== undefined &&
		(!Number.isFinite(input.confidence) ||
			input.confidence < 0 ||
			input.confidence > 1)
	) {
		throw new MnemocyteError(
			"confidence must be a number between 0 and 1.",
			"VALIDATION",
		);
	}
	if (input.expiresAt !== undefined) {
		assertValidDate(input.expiresAt, "expiresAt");
	}
}

export function validateRecallInput(input: RecallInput): void {
	assertNonEmptyString(input.entityId, "entityId");
	assertNonEmptyString(input.query, "query");
	if (input.limit !== undefined) {
		assertLimit(input.limit);
	}
	if (input.minScore !== undefined) {
		assertMinScore(input.minScore);
	}
	if (input.types !== undefined) {
		assertMemoryTypeArray(input.types, "types");
	}
}

export function contextInputToRecallInput(
	input: BuildContextInput,
): RecallInput {
	return {
		entityId: input.entityId,
		query: input.query,
		...(input.limit === undefined ? {} : { limit: input.limit }),
		...(input.minScore === undefined ? {} : { minScore: input.minScore }),
		...(input.types === undefined ? {} : { types: input.types }),
		...(input.tags === undefined ? {} : { tags: input.tags }),
		...(input.includeSuperseded === undefined
			? {}
			: { includeSuperseded: input.includeSuperseded }),
		...(input.includeExpired === undefined
			? {}
			: { includeExpired: input.includeExpired }),
	};
}

/**
 * Validate and normalize a {@link PruneInput}. Throws a `"VALIDATION"`
 * {@link MnemocyteError} for malformed fields or when normalization leaves no
 * effective selector, preventing surprise full-table deletes.
 */
export function validatePruneInput(input: PruneInput): ValidatedPruneFilter {
	if (input.entityId !== undefined) {
		assertNonEmptyString(input.entityId, "entityId");
	}
	for (const [field, value] of [
		["expired", input.expired],
		["superseded", input.superseded],
		["dryRun", input.dryRun],
	] as const) {
		if (value !== undefined && typeof value !== "boolean") {
			throw new MnemocyteError(`${field} must be a boolean.`, "VALIDATION");
		}
	}
	for (const [field, value] of [
		["createdBefore", input.createdBefore],
		["notAccessedSince", input.notAccessedSince],
	] as const) {
		if (value !== undefined) {
			assertValidDate(value, field);
		}
	}
	let types: readonly MemoryType[] | undefined;
	if (input.types !== undefined) {
		assertMemoryTypeArray(input.types, "types");
		const normalized = new Set<MemoryType>(input.types);
		if (normalized.size > 0) {
			types = [...normalized];
		}
	}
	let tags: readonly string[] | undefined;
	if (input.tags !== undefined) {
		if (!Array.isArray(input.tags)) {
			throw new MnemocyteError("tags must be an array.", "VALIDATION");
		}
		const normalized = new Set<string>();
		for (const value of input.tags as readonly unknown[]) {
			if (typeof value !== "string" || value.trim().length === 0) {
				throw new MnemocyteError(
					"tags must contain only non-empty strings.",
					"VALIDATION",
				);
			}
			normalized.add(value.trim());
		}
		if (normalized.size > 0) {
			tags = [...normalized];
		}
	}
	if (input.maxImportance !== undefined) {
		assertImportanceLevel(input.maxImportance, "maxImportance");
	}
	if (
		input.signal !== undefined &&
		(typeof input.signal !== "object" ||
			input.signal === null ||
			typeof input.signal.aborted !== "boolean" ||
			typeof input.signal.addEventListener !== "function" ||
			typeof input.signal.removeEventListener !== "function")
	) {
		throw new MnemocyteError("signal must be an AbortSignal.", "VALIDATION");
	}
	const filter: ValidatedPruneFilter = {
		...(input.entityId === undefined ? {} : { entityId: input.entityId }),
		...(input.expired === true ? { expired: true as const } : {}),
		...(input.superseded === true ? { superseded: true as const } : {}),
		...(input.createdBefore === undefined
			? {}
			: { createdBefore: new Date(input.createdBefore) }),
		...(input.notAccessedSince === undefined
			? {}
			: { notAccessedSince: new Date(input.notAccessedSince) }),
		...(types === undefined ? {} : { types }),
		...(tags === undefined ? {} : { tags }),
		...(input.maxImportance === undefined
			? {}
			: { maxImportance: input.maxImportance }),
		dryRun: input.dryRun === true,
	};
	assertPruneFilterHasSelector(filter);
	return filter;
}

/**
 * Validate a {@link FindDuplicatesInput} and throw a `"VALIDATION"`
 * {@link MnemocyteError} for malformed `threshold` / `limit` values.
 */
export function validateFindDuplicatesInput(input: FindDuplicatesInput): void {
	assertNonEmptyString(input.entityId, "entityId");
	if (input.threshold !== undefined) {
		if (
			!Number.isFinite(input.threshold) ||
			input.threshold < 0 ||
			input.threshold > 1
		) {
			throw new MnemocyteError(
				"threshold must be a number between 0 and 1.",
				"VALIDATION",
			);
		}
	}
	if (input.limit !== undefined) {
		assertLimit(input.limit);
	}
	if (input.types !== undefined) {
		assertMemoryTypeArray(input.types, "types");
	}
}

/**
 * Validate a {@link ConsolidateInput} and throw a `"VALIDATION"`
 * {@link MnemocyteError} for malformed inputs (empty `supersededIds`
 * a `survivorId` appearing in `supersededIds`, or duplicate loser IDs).
 */
export function validateConsolidateInput(input: ConsolidateInput): void {
	assertNonEmptyString(input.entityId, "entityId");
	assertNonEmptyString(input.survivorId, "survivorId");
	if (input.supersededIds.length === 0) {
		throw new MnemocyteError(
			"supersededIds must contain at least one memory id.",
			"VALIDATION",
		);
	}
	if (input.supersededIds.includes(input.survivorId)) {
		throw new MnemocyteError(
			"survivorId must not appear in supersededIds.",
			"VALIDATION",
		);
	}
	const seenIds = new Set<string>();
	for (const id of input.supersededIds) {
		assertNonEmptyString(id, "supersededIds[*]");
		if (seenIds.has(id)) {
			throw new MnemocyteError(
				"supersededIds must not contain duplicate memory ids.",
				"VALIDATION",
			);
		}
		seenIds.add(id);
	}
}

/**
 * Validate a {@link ListAuditLogInput} and throw a `"VALIDATION"`
 * {@link MnemocyteError} when malformed.
 */
export function validateListAuditLogInput(input: ListAuditLogInput): void {
	assertNonEmptyString(input.entityId, "entityId");
	if (input.limit !== undefined) {
		assertLimit(input.limit);
	}
	for (const [field, cursor] of [
		["beforeCursor", input.beforeCursor],
		["afterCursor", input.afterCursor],
	] as const) {
		if (cursor === undefined) {
			continue;
		}
		assertAuditLogCursor(cursor, field);
	}
}

function assertAuditLogCursor(
	value: unknown,
	field: string,
): asserts value is AuditLogCursor {
	if (typeof value !== "object" || value === null) {
		throw new MnemocyteError(
			`${field} must be an audit-log cursor.`,
			"VALIDATION",
		);
	}
	const cursor = value as { id?: unknown; timestamp?: unknown };
	assertValidDate(cursor.timestamp, `${field}.timestamp`);
	assertNonEmptyString(cursor.id, `${field}.id`);
}
