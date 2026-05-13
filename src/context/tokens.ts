import type { TokenCounter } from "../types.js";

export const heuristicTokenCounter: TokenCounter = {
	count(text) {
		return Math.ceil(text.length / 4);
	},
};

export function trimToTokenBudget(
	text: string,
	maxTokens: number,
	tokenCounter: TokenCounter,
): string {
	if (maxTokens < 1 || tokenCounter.count(text) <= maxTokens) {
		return text;
	}
	let low = 0;
	let high = text.length;
	let best = "";
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const candidate = text.slice(0, mid).trimEnd();
		const output = `${candidate}\n[truncated to fit token budget]`;
		if (tokenCounter.count(output) <= maxTokens) {
			best = output;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	return best || "[truncated to fit token budget]";
}
