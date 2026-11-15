import type {
	ContextInput,
	ContextWithMemoriesResult,
	MemoryWithScore,
} from "../types.js";
import { formatContext } from "./formatter.js";
import { heuristicTokenCounter, trimToTokenBudget } from "./tokens.js";

export interface BuildContextOptions {
	input: ContextInput;
	search(input: ContextInput): Promise<MemoryWithScore[]>;
}

/**
 * Render the best-ranked memories that fit `maxTokens`: a binary search on the
 * number of memories, so the result always fits the budget. The rendered
 * memories are always a prefix of the search results. No matching memory
 * renders as `""`, so callers can tell there is nothing to add.
 */
export async function buildContext(
	options: BuildContextOptions,
): Promise<ContextWithMemoriesResult> {
	const format = options.input.format ?? "markdown";
	const maxTokens = options.input.maxTokens ?? 1200;
	const tokenCounter = options.input.tokenCounter ?? heuristicTokenCounter;
	const results = await options.search(options.input);
	if (results.length === 0) {
		return { context: "", memories: [], omitted: [] };
	}
	let low = 0;
	let high = results.length;
	let bestCount = 0;
	let bestContext = "";
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const omittedCount = results.length - mid;
		const context = formatContext(results.slice(0, mid), format, omittedCount);
		if (tokenCounter.count(context) <= maxTokens) {
			bestCount = mid;
			bestContext = context;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	if (bestContext) {
		return {
			context: bestContext,
			memories: results.slice(0, bestCount),
			omitted: results.slice(bestCount),
		};
	}
	return {
		context: trimToTokenBudget(
			formatContext([], format, results.length),
			maxTokens,
			tokenCounter,
		),
		memories: [],
		omitted: results,
	};
}
