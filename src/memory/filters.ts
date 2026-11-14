import type { Memory, MemoryRecordScope } from "../types.js";
import { IMPORTANCE_RANK } from "./defaults.js";
import type {
	StoreDuplicateInput,
	StoreMemoryFilter,
	StoreScope,
	StoreSelector,
	StoreVisibility,
	ValidatedPruneFilter,
} from "./store.js";

export function isExpired(memory: Memory, now: Date): boolean {
	return (
		memory.expiresAt !== null && memory.expiresAt.getTime() <= now.getTime()
	);
}

function matchesOptionalField(
	value: string | null,
	wanted: string | null,
	exact: boolean,
): boolean {
	if (wanted === null) {
		return value === null;
	}
	return value === wanted || (!exact && value === null);
}

/** Whether a row is visible at a scope; see {@link StoreVisibility}. */
export function isVisible(
	scope: MemoryRecordScope,
	visibility: StoreVisibility,
): boolean {
	const wanted = visibility.scope;
	return (
		scope.namespace === wanted.namespace &&
		scope.entityId === wanted.entityId &&
		matchesOptionalField(
			scope.agentId,
			wanted.agentId,
			visibility.exactAgent,
		) &&
		matchesOptionalField(
			scope.sessionId,
			wanted.sessionId,
			visibility.exactSession,
		)
	);
}

/** Whether two scopes are the same exact scope (where keys are unique). */
export function isSameScope(a: StoreScope, b: StoreScope): boolean {
	return (
		a.namespace === b.namespace &&
		a.entityId === b.entityId &&
		a.agentId === b.agentId &&
		a.sessionId === b.sessionId
	);
}

/** Whether a row is selected; see {@link StoreSelector}. */
export function isSelected(
	scope: MemoryRecordScope,
	selector: StoreSelector,
): boolean {
	return (
		(selector.namespace === null || scope.namespace === selector.namespace) &&
		(selector.entityId === undefined || scope.entityId === selector.entityId) &&
		(selector.agentId === undefined || scope.agentId === selector.agentId) &&
		(selector.sessionId === undefined || scope.sessionId === selector.sessionId)
	);
}

/**
 * Test whether `memory` matches a validated prune filter. All specified
 * selectors are AND-combined; unspecified selectors do not restrict.
 */
export function matchesPruneFilter(
	memory: Memory,
	input: ValidatedPruneFilter,
	now: Date,
): boolean {
	if (!isSelected(memory.scope, input.selector)) {
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
		const last = memory.lastAccessedAt ?? memory.createdAt;
		if (last.getTime() >= input.notAccessedSince.getTime()) {
			return false;
		}
	}
	if (input.kinds !== undefined && !input.kinds.includes(memory.kind)) {
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
 * Whether a memory takes part in a duplicate scan, given the filters on
 * `input` and a shared `now`.
 */
export function matchesDuplicateFilter(
	memory: Memory,
	input: Omit<StoreDuplicateInput, "limit">,
	now: Date,
): boolean {
	return matchesMemoryFilter(memory, input, now);
}

/** The shared search and list filters. */
export function matchesMemoryFilter(
	memory: Memory,
	input: StoreMemoryFilter,
	now: Date,
): boolean {
	if (!isVisible(memory.scope, input.visibility)) {
		return false;
	}
	if (!input.includeSuperseded && memory.supersededBy !== null) {
		return false;
	}
	if (!input.includeExpired && isExpired(memory, now)) {
		return false;
	}
	if (
		input.kinds &&
		input.kinds.length > 0 &&
		!input.kinds.includes(memory.kind)
	) {
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
