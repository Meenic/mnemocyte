import { MnemocyteError } from "../errors.js";
import type {
	BuildContextInput,
	ConsolidateInput,
	Embedder,
	FindDuplicatesInput,
	ListAuditLogInput,
	PruneInput,
	RecallInput,
	RememberInput,
} from "../types.js";
import { validateJsonObject } from "./json.js";

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

export function validateRememberInput(input: RememberInput): void {
	assertNonEmptyString(input.entityId, "entityId");
	assertNonEmptyString(input.content, "content");
	if (input.metadata !== undefined) {
		validateJsonObject(input.metadata);
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
 * Validate a {@link PruneInput} and throw a `"VALIDATION"`
 * {@link MnemocyteError} when no selector is supplied. Mnemocyte
 * deliberately rejects `prune({})` to avoid surprise full-table deletes.
 */
export function validatePruneInput(input: PruneInput): void {
	if (input.entityId !== undefined) {
		assertNonEmptyString(input.entityId, "entityId");
	}
	const hasSelector =
		input.entityId !== undefined ||
		input.expired === true ||
		input.superseded === true ||
		input.createdBefore !== undefined ||
		input.notAccessedSince !== undefined ||
		(input.types !== undefined && input.types.length > 0) ||
		(input.tags !== undefined && input.tags.length > 0) ||
		input.maxImportance !== undefined;
	if (!hasSelector) {
		throw new MnemocyteError(
			"prune requires at least one selector (entityId, expired, superseded, createdBefore, notAccessedSince, types, tags, or maxImportance).",
			"VALIDATION",
		);
	}
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
}

/**
 * Validate a {@link ConsolidateInput} and throw a `"VALIDATION"`
 * {@link MnemocyteError} for malformed inputs (empty `supersededIds`
 * or a `survivorId` appearing in `supersededIds`).
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
	for (const id of input.supersededIds) {
		assertNonEmptyString(id, "supersededIds[*]");
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
}
