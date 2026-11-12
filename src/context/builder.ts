import type { ContextInput, MemoryWithScore } from "../types.js";
import { formatContext } from "./formatter.js";
import { heuristicTokenCounter, trimToTokenBudget } from "./tokens.js";

export interface BuildContextOptions {
	input: ContextInput;
	search(input: ContextInput): Promise<MemoryWithScore[]>;
}

/**
 * Render the best-ranked memories that fit `maxTokens`: a binary search on the
 * number of memories, so the result always fits the budget.
 */
export async function buildContext(
	options: BuildContextOptions,
): Promise<string> {
	const format = options.input.format ?? "markdown";
	const maxTokens = options.input.maxTokens ?? 1200;
	const tokenCounter = options.input.tokenCounter ?? heuristicTokenCounter;
	const memories = await options.search(options.input);
	let low = 0;
	let high = memories.length;
	let bestContext = "";
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const omittedCount = memories.length - mid;
		const context = formatContext(memories.slice(0, mid), format, omittedCount);
		if (tokenCounter.count(context) <= maxTokens) {
			bestContext = context;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	if (bestContext || memories.length === 0) {
		return bestContext;
	}
	return trimToTokenBudget(
		formatContext([], format, memories.length),
		maxTokens,
		tokenCounter,
	);
}
