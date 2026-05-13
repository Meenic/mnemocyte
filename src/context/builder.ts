import type { BuildContextInput, MemoryWithScore } from "../types.js";
import { formatContext } from "./formatter.js";
import { heuristicTokenCounter, trimToTokenBudget } from "./tokens.js";

export interface BuildContextOptions {
	input: BuildContextInput;
	recall(input: BuildContextInput): Promise<MemoryWithScore[]>;
}

export async function buildContext(
	options: BuildContextOptions,
): Promise<string> {
	const format = options.input.format ?? "markdown";
	const maxTokens = options.input.maxTokens ?? 1200;
	const tokenCounter = options.input.tokenCounter ?? heuristicTokenCounter;
	const memories = await options.recall(options.input);
	const context = formatContext(memories, options.input.query, format);
	return trimToTokenBudget(context, maxTokens, tokenCounter);
}
