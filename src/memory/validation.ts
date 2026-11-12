import { MnemocyteError } from "../errors.js";
import { DEFAULT_BOOSTS, DEFAULT_FUSION } from "../retrieval/scorer.js";
import type {
	AuditLogCursor,
	ConsolidateInput,
	ContextInput,
	Embedder,
	FindDuplicatesInput,
	ImportanceLevel,
	ListAuditLogInput,
	MemoryKind,
	MigrateInput,
	NewMemory,
	ProviderResilienceConfig,
	PruneInput,
	RetrievalConfig,
	ScopedReadOptions,
	SearchInput,
} from "../types.js";
import type { OwnedJsonObject } from "./json.js";
import {
	MAX_CONTENT_LENGTH,
	MAX_KEY_BYTES,
	MAX_LIMIT,
	MAX_SCOPE_FIELD_BYTES,
	MAX_TAG_LENGTH,
	MAX_TAGS,
	utf8Length,
} from "./limits.js";
import {
	assertPruneFilterHasSelector,
	type StoreEntitySelector,
	type StoreScope,
	type StoreSelector,
	type StoreVisibility,
	type ValidatedPruneFilter,
} from "./store.js";

const MEMORY_KINDS = [
	"fact",
	"preference",
	"instruction",
	"backstory",
	"episode",
	"session",
] as const satisfies readonly MemoryKind[];

const IMPORTANCE_LEVELS = [
	"low",
	"normal",
	"high",
	"critical",
] as const satisfies readonly ImportanceLevel[];

/** A {@link NewMemory} snapshot whose metadata is an owned deep copy. */
export interface PreparedNewMemory extends Omit<NewMemory, "metadata"> {
	metadata: OwnedJsonObject;
}

function isMemoryKind(value: unknown): value is MemoryKind {
	return (
		typeof value === "string" &&
		(MEMORY_KINDS as readonly string[]).includes(value)
	);
}

function isImportanceLevel(value: unknown): value is ImportanceLevel {
	return (
		typeof value === "string" &&
		(IMPORTANCE_LEVELS as readonly string[]).includes(value)
	);
}

function assertMemoryKind(
	value: unknown,
	field: string,
): asserts value is MemoryKind {
	if (!isMemoryKind(value)) {
		throw new MnemocyteError(
			`${field} must be a known memory kind.`,
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

function assertMemoryKindArray(
	value: unknown,
	field: string,
): asserts value is readonly MemoryKind[] {
	if (!Array.isArray(value)) {
		throw new MnemocyteError(`${field} must be an array.`, "VALIDATION");
	}
	for (const item of value) {
		if (!isMemoryKind(item)) {
			throw new MnemocyteError(
				`${field} must contain only known memory kinds.`,
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

export function assertOptionalSignal(signal: AbortSignal | undefined): void {
	if (
		signal !== undefined &&
		(typeof signal !== "object" ||
			signal === null ||
			typeof signal.aborted !== "boolean" ||
			typeof signal.addEventListener !== "function" ||
			typeof signal.removeEventListener !== "function")
	) {
		throw new MnemocyteError("signal must be an AbortSignal.", "VALIDATION");
	}
}

export function assertLimit(value: number): void {
	if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
		throw new MnemocyteError(
			`limit must be an integer from 1 to ${MAX_LIMIT}.`,
			"VALIDATION",
		);
	}
}

/** A non-empty string of at most {@link MAX_CONTENT_LENGTH} characters. */
export function assertContent(
	value: unknown,
	field: string,
): asserts value is string {
	assertNonEmptyString(value, field);
	if (value.length > MAX_CONTENT_LENGTH) {
		throw new MnemocyteError(
			`${field} must be at most ${MAX_CONTENT_LENGTH} characters.`,
			"VALIDATION",
		);
	}
}

function assertMaxBytes(
	value: string,
	field: string,
	max: number,
	code: "CONFIG" | "VALIDATION" = "VALIDATION",
): void {
	// Each UTF-16 code unit takes at most 3 UTF-8 bytes, so short strings
	// skip the encoding.
	if (value.length * 3 > max && utf8Length(value) > max) {
		throw new MnemocyteError(
			`${field} must be at most ${max} bytes in UTF-8.`,
			code,
		);
	}
}

/** A non-empty key of at most {@link MAX_KEY_BYTES} UTF-8 bytes. */
export function assertKey(
	value: unknown,
	field = "key",
): asserts value is string {
	assertNonEmptyString(value, field);
	assertMaxBytes(value, field, MAX_KEY_BYTES);
}

/** A non-empty scope field of at most {@link MAX_SCOPE_FIELD_BYTES} bytes. */
function assertScopeField(
	value: unknown,
	field: string,
	code: "CONFIG" | "VALIDATION" = "VALIDATION",
): asserts value is string {
	assertNonEmptyString(value, field, code);
	assertMaxBytes(value, field, MAX_SCOPE_FIELD_BYTES, code);
}

/**
 * Check `createMemory({ namespace })`: absent, or a scope field. Throws
 * `"CONFIG"`, since it is configuration rather than a call input.
 */
export function validateDefaultNamespace(value: unknown): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	assertScopeField(value, "namespace", "CONFIG");
	return value;
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

function assertPositiveFiniteConfigValue(value: number, field: string): void {
	if (!Number.isFinite(value) || value <= 0) {
		throw new MnemocyteError(
			`${field} must be a positive finite number.`,
			"CONFIG",
		);
	}
}

function assertNonNegativeFiniteConfigValue(
	value: number,
	field: string,
): void {
	if (!Number.isFinite(value) || value < 0) {
		throw new MnemocyteError(
			`${field} must be a non-negative finite number.`,
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

	const fusion = { ...DEFAULT_FUSION, ...config.fusion };
	for (const key of ["k", "vector", "lexical"] as const) {
		assertNonNegativeFiniteConfigValue(fusion[key], `retrieval.fusion.${key}`);
	}
	if (fusion.vector + fusion.lexical === 0) {
		throw new MnemocyteError(
			"retrieval.fusion.vector and retrieval.fusion.lexical must not both be zero.",
			"CONFIG",
		);
	}
	const boosts = { ...DEFAULT_BOOSTS, ...config.boosts };
	for (const key of ["recency", "importance"] as const) {
		assertNonNegativeFiniteConfigValue(boosts[key], `retrieval.boosts.${key}`);
	}

	if (config.recencyHalfLifeDays !== undefined) {
		assertPositiveFiniteConfigValue(
			config.recencyHalfLifeDays,
			"retrieval.recencyHalfLifeDays",
		);
	}
	if (
		config.trackAccess !== undefined &&
		typeof config.trackAccess !== "boolean"
	) {
		throw new MnemocyteError(
			"retrieval.trackAccess must be a boolean.",
			"CONFIG",
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

function assertObject(value: unknown, field: string): void {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new MnemocyteError(`${field} must be an object.`, "VALIDATION");
	}
}

function optionalScopeField(value: unknown, field: string): string | null {
	if (value === undefined) {
		return null;
	}
	assertScopeField(value, field);
	return value;
}

/**
 * Validate a {@link MemoryScope} and return a detached copy, with `null` for
 * an omitted agent or session.
 */
export function validateScope(value: unknown, field = "scope"): StoreScope {
	assertObject(value, field);
	const scope = value as Record<string, unknown>;
	assertScopeField(scope.namespace, `${field}.namespace`);
	assertScopeField(scope.entityId, `${field}.entityId`);
	return {
		namespace: scope.namespace,
		entityId: scope.entityId,
		agentId: optionalScopeField(scope.agentId, `${field}.agentId`),
		sessionId: optionalScopeField(scope.sessionId, `${field}.sessionId`),
	};
}

function assertOptionalBoolean(value: unknown, field: string): void {
	if (value !== undefined && typeof value !== "boolean") {
		throw new MnemocyteError(`${field} must be a boolean.`, "VALIDATION");
	}
}

/** What a read at `scope` sees; see {@link StoreVisibility}. */
export function validateVisibility(
	input: ScopedReadOptions & { scope: unknown },
): StoreVisibility {
	const scope = validateScope(input.scope);
	assertOptionalBoolean(input.exactAgent, "exactAgent");
	assertOptionalBoolean(input.exactSession, "exactSession");
	return {
		scope,
		exactAgent: input.exactAgent === true,
		exactSession: input.exactSession === true,
	};
}

/** Visibility for a write by id: shared rows included. */
export function writeVisibility(scope: StoreScope): StoreVisibility {
	return { scope, exactAgent: false, exactSession: false };
}

function selectorFromScope(
	value: unknown,
	field: string,
	requireEntity: boolean,
): StoreSelector {
	assertObject(value, field);
	const scope = value as Record<string, unknown>;
	assertScopeField(scope.namespace, `${field}.namespace`);
	if (requireEntity || scope.entityId !== undefined) {
		assertScopeField(scope.entityId, `${field}.entityId`);
	}
	const agentId = optionalScopeField(scope.agentId, `${field}.agentId`);
	const sessionId = optionalScopeField(scope.sessionId, `${field}.sessionId`);
	return {
		namespace: scope.namespace,
		...(scope.entityId === undefined
			? {}
			: { entityId: scope.entityId as string }),
		...(agentId === null ? {} : { agentId }),
		...(sessionId === null ? {} : { sessionId }),
	};
}

/** Validate a scope used as a selector for one entity (`deleteScope`, audit). */
export function validateEntitySelector(value: unknown): StoreEntitySelector {
	// selectorFromScope checked namespace and entityId as non-empty strings.
	return selectorFromScope(value, "scope", true) as StoreEntitySelector;
}

/**
 * Validate `{ scope }` or `{ allNamespaces: true }`: exactly one of them.
 * `allNamespaces` selects every namespace (a null namespace).
 */
export function validateSelectorInput(input: {
	scope?: unknown;
	allNamespaces?: unknown;
}): StoreSelector {
	assertObject(input, "input");
	if (input.allNamespaces !== undefined && input.allNamespaces !== true) {
		throw new MnemocyteError("allNamespaces must be true.", "VALIDATION");
	}
	if (input.allNamespaces === true) {
		if (input.scope !== undefined) {
			throw new MnemocyteError(
				"Pass either scope or allNamespaces: true, not both.",
				"VALIDATION",
			);
		}
		return { namespace: null };
	}
	if (input.scope === undefined) {
		throw new MnemocyteError(
			"A scope (at least a namespace) or allNamespaces: true is required.",
			"VALIDATION",
		);
	}
	return selectorFromScope(input.scope, "scope", false);
}

function assertTags(value: unknown, field = "tags"): void {
	if (!Array.isArray(value)) {
		throw new MnemocyteError(`${field} must be an array.`, "VALIDATION");
	}
	if (value.length > MAX_TAGS) {
		throw new MnemocyteError(
			`${field} must contain at most ${MAX_TAGS} tags.`,
			"VALIDATION",
		);
	}
	for (const tag of value as readonly unknown[]) {
		if (typeof tag !== "string") {
			throw new MnemocyteError(
				`${field} must contain only strings.`,
				"VALIDATION",
			);
		}
		if (tag.length > MAX_TAG_LENGTH) {
			throw new MnemocyteError(
				`${field} must contain tags of at most ${MAX_TAG_LENGTH} characters.`,
				"VALIDATION",
			);
		}
	}
}

function assertConfidence(value: unknown): void {
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < 0 ||
		value > 1
	) {
		throw new MnemocyteError(
			"confidence must be a number between 0 and 1.",
			"VALIDATION",
		);
	}
}

export function validateNewMemory(input: PreparedNewMemory): void {
	assertContent(input.content, "content");
	if (input.key !== undefined) {
		assertKey(input.key);
	}
	if (input.kind !== undefined) {
		assertMemoryKind(input.kind, "kind");
	}
	if (input.importance !== undefined) {
		assertImportanceLevel(input.importance, "importance");
	}
	if (input.tags !== undefined) {
		assertTags(input.tags);
	}
	if (input.source !== undefined && typeof input.source !== "string") {
		throw new MnemocyteError("source must be a string.", "VALIDATION");
	}
	if (input.confidence !== undefined) {
		assertConfidence(input.confidence);
	}
	if (input.expiresAt !== undefined) {
		assertValidDate(input.expiresAt, "expiresAt");
	}
}

/** Keys must be distinct in one batch: one statement cannot update a row twice. */
export function assertDistinctKeys(memories: readonly NewMemory[]): void {
	const seen = new Set<string>();
	for (const memory of memories) {
		if (memory.key === undefined) {
			continue;
		}
		if (seen.has(memory.key)) {
			throw new MnemocyteError(
				"memories must not repeat a key within one addMany call.",
				"VALIDATION",
			);
		}
		seen.add(memory.key);
	}
}

/** Shared filter fields of search, list, context and duplicate scans. */
function validateMemoryFilterFields(input: {
	kinds?: unknown;
	tags?: unknown;
	includeSuperseded?: unknown;
	includeExpired?: unknown;
}): void {
	if (input.kinds !== undefined) {
		assertMemoryKindArray(input.kinds, "kinds");
	}
	if (input.tags !== undefined) {
		assertTags(input.tags);
	}
	assertOptionalBoolean(input.includeSuperseded, "includeSuperseded");
	assertOptionalBoolean(input.includeExpired, "includeExpired");
}

export function validateSearchInput(input: SearchInput): StoreVisibility {
	const visibility = validateVisibility(input);
	assertContent(input.query, "query");
	if (input.limit !== undefined) {
		assertLimit(input.limit);
	}
	if (input.minScore !== undefined) {
		assertMinScore(input.minScore);
	}
	validateMemoryFilterFields(input);
	if (input.before !== undefined) {
		assertValidDate(input.before, "before");
	}
	if (input.after !== undefined) {
		assertValidDate(input.after, "after");
	}
	assertOptionalBoolean(input.explain, "explain");
	assertOptionalTrackAccess(input.trackAccess);
	assertOptionalSignal(input.signal);
	return visibility;
}

export function validateListFilter(input: {
	limit?: number;
	kinds?: unknown;
	tags?: unknown;
	includeSuperseded?: unknown;
	includeExpired?: unknown;
	signal?: AbortSignal;
}): void {
	if (input.limit !== undefined) {
		assertLimit(input.limit);
	}
	validateMemoryFilterFields(input);
	assertOptionalSignal(input.signal);
}

export function validateContextInput(input: ContextInput): void {
	assertOptionalTrackAccess(input.trackAccess);
	if (
		input.format !== undefined &&
		input.format !== "markdown" &&
		input.format !== "plain" &&
		input.format !== "xml"
	) {
		throw new MnemocyteError(
			'format must be "markdown", "plain" or "xml".',
			"VALIDATION",
		);
	}
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

function assertOptionalTrackAccess(value: unknown): void {
	if (value !== undefined && typeof value !== "boolean") {
		throw new MnemocyteError("trackAccess must be a boolean.", "VALIDATION");
	}
}

export function contextInputToSearchInput(input: ContextInput): SearchInput {
	return {
		scope: input.scope,
		query: input.query,
		...(input.exactAgent === undefined ? {} : { exactAgent: input.exactAgent }),
		...(input.exactSession === undefined
			? {}
			: { exactSession: input.exactSession }),
		...(input.limit === undefined ? {} : { limit: input.limit }),
		...(input.minScore === undefined ? {} : { minScore: input.minScore }),
		...(input.kinds === undefined ? {} : { kinds: input.kinds }),
		...(input.tags === undefined ? {} : { tags: input.tags }),
		...(input.includeSuperseded === undefined
			? {}
			: { includeSuperseded: input.includeSuperseded }),
		...(input.includeExpired === undefined
			? {}
			: { includeExpired: input.includeExpired }),
		...(input.trackAccess === undefined
			? {}
			: { trackAccess: input.trackAccess }),
		...(input.signal === undefined ? {} : { signal: input.signal }),
	};
}

/** The fields of an `update` call, snapshotted. */
export interface PreparedUpdateFields {
	content?: string;
	key?: string | null;
	kind?: MemoryKind;
	importance?: ImportanceLevel;
	tags?: readonly string[];
	source?: string | null;
	metadata?: OwnedJsonObject;
	confidence?: number;
	expiresAt?: Date | null;
}

export function validateUpdateFields(input: PreparedUpdateFields): void {
	if (input.content !== undefined) {
		assertContent(input.content, "content");
	}
	if (input.key !== undefined && input.key !== null) {
		assertKey(input.key);
	}
	if (input.kind !== undefined) {
		assertMemoryKind(input.kind, "kind");
	}
	if (input.importance !== undefined) {
		assertImportanceLevel(input.importance, "importance");
	}
	if (input.tags !== undefined) {
		assertTags(input.tags);
	}
	if (
		input.source !== undefined &&
		input.source !== null &&
		typeof input.source !== "string"
	) {
		throw new MnemocyteError("source must be a string or null.", "VALIDATION");
	}
	if (input.confidence !== undefined) {
		assertConfidence(input.confidence);
	}
	if (input.expiresAt !== undefined && input.expiresAt !== null) {
		assertValidDate(input.expiresAt, "expiresAt");
	}
	if (Object.values(input).every((value) => value === undefined)) {
		throw new MnemocyteError(
			"update requires at least one field to change.",
			"VALIDATION",
		);
	}
}

/**
 * Validate and normalize a {@link PruneInput}. Throws a `"VALIDATION"`
 * {@link MnemocyteError} for malformed fields, a missing scope, or when
 * normalization leaves no selector besides the scope.
 */
export function validatePruneInput(input: PruneInput): ValidatedPruneFilter {
	const selector = validateSelectorInput(input);
	for (const [field, value] of [
		["expired", input.expired],
		["superseded", input.superseded],
		["dryRun", input.dryRun],
	] as const) {
		assertOptionalBoolean(value, field);
	}
	for (const [field, value] of [
		["createdBefore", input.createdBefore],
		["notAccessedSince", input.notAccessedSince],
	] as const) {
		if (value !== undefined) {
			assertValidDate(value, field);
		}
	}
	let kinds: readonly MemoryKind[] | undefined;
	if (input.kinds !== undefined) {
		assertMemoryKindArray(input.kinds, "kinds");
		const normalized = new Set<MemoryKind>(input.kinds);
		if (normalized.size > 0) {
			kinds = [...normalized];
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
	assertOptionalSignal(input.signal);
	const filter: ValidatedPruneFilter = {
		selector,
		...(input.expired === true ? { expired: true as const } : {}),
		...(input.superseded === true ? { superseded: true as const } : {}),
		...(input.createdBefore === undefined
			? {}
			: { createdBefore: new Date(input.createdBefore) }),
		...(input.notAccessedSince === undefined
			? {}
			: { notAccessedSince: new Date(input.notAccessedSince) }),
		...(kinds === undefined ? {} : { kinds }),
		...(tags === undefined ? {} : { tags }),
		...(input.maxImportance === undefined
			? {}
			: { maxImportance: input.maxImportance }),
		dryRun: input.dryRun === true,
	};
	assertPruneFilterHasSelector(filter);
	return filter;
}

/** Validate a {@link FindDuplicatesInput} and return its visibility. */
export function validateFindDuplicatesInput(
	input: FindDuplicatesInput,
): StoreVisibility {
	const visibility = validateVisibility(input);
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
	validateMemoryFilterFields(input);
	assertOptionalSignal(input.signal);
	return visibility;
}

/**
 * Validate a {@link ConsolidateInput} (non-empty, distinct `supersededIds`
 * without the survivor) and return its scope.
 */
export function validateConsolidateInput(input: ConsolidateInput): StoreScope {
	const scope = validateScope(input.scope);
	assertNonEmptyString(input.survivorId, "survivorId");
	if (!Array.isArray(input.supersededIds)) {
		throw new MnemocyteError("supersededIds must be an array.", "VALIDATION");
	}
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
	assertOptionalBoolean(input.mergeTags, "mergeTags");
	assertOptionalSignal(input.signal);
	return scope;
}

/** Validate a {@link ListAuditLogInput} and return its selector. */
export function validateListAuditLogInput(
	input: ListAuditLogInput,
): StoreEntitySelector {
	const selector = validateEntitySelector(input.scope);
	if (input.limit !== undefined) {
		assertLimit(input.limit);
	}
	if (input.before !== undefined) {
		assertValidDate(input.before, "before");
	}
	if (input.after !== undefined) {
		assertValidDate(input.after, "after");
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
	assertOptionalSignal(input.signal);
	return selector;
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

// pgvector's HNSW index holds `halfvec` up to 4,000 dimensions, the largest
// column a migration can create.
const MAX_MIGRATE_DIMENSIONS = 4000;

/**
 * Validate a {@link MigrateInput} and throw a `"VALIDATION"`
 * {@link MnemocyteError} when malformed.
 */
export function validateMigrateInput(input: MigrateInput): void {
	if (typeof input !== "object" || input === null) {
		throw new MnemocyteError("migrate requires an input object.", "VALIDATION");
	}
	const hasMemory = input.memory !== undefined;
	const hasStore = input.store !== undefined;
	if (hasMemory === hasStore) {
		throw new MnemocyteError(
			"migrate takes either memory (a client from createMemory()) or store, not both and not neither.",
			"VALIDATION",
		);
	}
	assertOptionalBoolean(input.createExtension, "createExtension");
	assertOptionalBoolean(input.dryRun, "dryRun");
	if (input.dimensions !== undefined) {
		assertMigrateDimensions(input.dimensions, "dimensions");
	}
	assertOptionalSignal(input.signal);
}

/**
 * Throw `"VALIDATION"` unless `dimensions` fits a column a migration can
 * create. `field` names where the value came from.
 */
export function assertMigrateDimensions(
	dimensions: number,
	field: string,
): void {
	if (
		!Number.isInteger(dimensions) ||
		dimensions < 1 ||
		dimensions > MAX_MIGRATE_DIMENSIONS
	) {
		throw new MnemocyteError(
			`${field} must be an integer from 1 to ${MAX_MIGRATE_DIMENSIONS}, the largest halfvec an HNSW index holds.`,
			"VALIDATION",
		);
	}
}
