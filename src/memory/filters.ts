import type { FindDuplicatesInput, Memory, RecallInput } from "../types.js";
import { IMPORTANCE_RANK } from "./defaults.js";
import type { ValidatedPruneFilter } from "./store.js";

export function isExpired(memory: Memory, now: Date): boolean {
	return (
		memory.expiresAt !== null && memory.expiresAt.getTime() <= now.getTime()
	);
}

/**
 * Test whether `memory` matches a validated prune filter. All specified
 * selectors are AND-combined; unspecified selectors do not restrict.
 *
 * `now` is supplied by the caller so callers can share a consistent
 * timestamp across a batch.
 */
export function matchesPruneFilter(
	memory: Memory,
	input: ValidatedPruneFilter,
	now: Date,
): boolean {
	if (input.entityId !== undefined && memory.entityId !== input.entityId) {
		return false;
	}
	if (input.expired === true && !isExpired(memory, now)) {
		return false;
	}
	if (input.superseded === true && memory.supersededBy === null) {
		return false;
	}
	if (
		input.createdBefore !== undefined &&
		memory.createdAt.getTime() >= input.createdBefore.getTime()
	) {
		return false;
	}
	if (input.notAccessedSince !== undefined) {
		const last = memory.lastAccessedAt;
		if (last !== null && last.getTime() >= input.notAccessedSince.getTime()) {
			return false;
		}
	}
	if (input.types !== undefined && !input.types.includes(memory.type)) {
		return false;
	}
	if (
		input.tags !== undefined &&
		input.tags.length > 0 &&
		!input.tags.every((tag) => memory.tags.includes(tag))
	) {
		return false;
	}
	if (
		input.maxImportance !== undefined &&
		IMPORTANCE_RANK[memory.importance] > IMPORTANCE_RANK[input.maxImportance]
	) {
		return false;
	}
	return true;
}

/**
 * Return `true` when a memory should participate in a duplicate scan,
 * given the filters on `input` and a shared `now` timestamp.
 */
export function matchesDuplicateFilter(
	memory: Memory,
	input: FindDuplicatesInput,
	now: Date,
): boolean {
	if (memory.entityId !== input.entityId) {
		return false;
	}
	if (input.includeSuperseded !== true && memory.supersededBy !== null) {
		return false;
	}
	if (input.includeExpired !== true && isExpired(memory, now)) {
		return false;
	}
	if (input.types !== undefined && !input.types.includes(memory.type)) {
		return false;
	}
	if (
		input.tags !== undefined &&
		input.tags.length > 0 &&
		!input.tags.every((tag) => memory.tags.includes(tag))
	) {
		return false;
	}
	return true;
}

export function matchesRecallFilter(
	memory: Memory,
	input: RecallInput,
	now: Date,
): boolean {
	if (memory.entityId !== input.entityId) {
		return false;
	}
	if (!input.includeSuperseded && memory.supersededBy !== null) {
		return false;
	}
	if (!input.includeExpired && isExpired(memory, now)) {
		return false;
	}
	if (input.types && !input.types.includes(memory.type)) {
		return false;
	}
	if (input.tags && !input.tags.every((tag) => memory.tags.includes(tag))) {
		return false;
	}
	if (input.before && memory.createdAt >= input.before) {
		return false;
	}
	if (input.after && memory.createdAt <= input.after) {
		return false;
	}
	return true;
}
