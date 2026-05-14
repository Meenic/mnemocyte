import type { ContextFormat, MemoryWithScore } from "../types.js";

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function formatMetadata(memory: MemoryWithScore): string {
	const parts = [
		`type=${memory.type}`,
		`importance=${memory.importance}`,
		`score=${memory.score.toFixed(3)}`,
	];
	if (memory.source) {
		parts.push(`source=${memory.source}`);
	}
	if (memory.tags.length > 0) {
		parts.push(`tags=${memory.tags.join(",")}`);
	}
	return parts.join("; ");
}

function markdownFence(value: string): string {
	const longestBacktickRun = Math.max(
		0,
		...Array.from(value.matchAll(/`+/g), (match) => match[0].length),
	);
	return "`".repeat(Math.max(3, longestBacktickRun + 1));
}

function formatMarkdown(
	memories: readonly MemoryWithScore[],
	query: string,
	omittedCount: number,
): string {
	const lines = [
		"# Memory Context",
		"",
		`Query: ${query}`,
		"",
		"## Relevant Memories",
	];
	for (const memory of memories) {
		const fence = markdownFence(memory.content);
		lines.push(
			"",
			`- ${formatMetadata(memory)}`,
			`  ${fence}text`,
			...memory.content.split("\n").map((line) => `  ${line}`),
			`  ${fence}`,
		);
	}
	if (omittedCount > 0) {
		lines.push("", `[${omittedCount} memories omitted to fit token budget]`);
	}
	return lines.join("\n");
}

function formatPlain(
	memories: readonly MemoryWithScore[],
	query: string,
	omittedCount: number,
): string {
	const lines = [
		"MEMORY CONTEXT",
		"",
		`QUERY: ${query}`,
		"",
		"RELEVANT MEMORIES",
	];
	for (const [index, memory] of memories.entries()) {
		lines.push(
			"",
			`--- MEMORY ${index + 1} START ---`,
			formatMetadata(memory),
			memory.content,
			`--- MEMORY ${index + 1} END ---`,
		);
	}
	if (omittedCount > 0) {
		lines.push("", `[${omittedCount} memories omitted to fit token budget]`);
	}
	return lines.join("\n");
}

function formatXml(
	memories: readonly MemoryWithScore[],
	query: string,
	omittedCount: number,
): string {
	const lines = [`<memory_context query="${escapeXml(query)}">`];
	for (const memory of memories) {
		lines.push(
			`  <memory id="${escapeXml(memory.id)}" type="${escapeXml(memory.type)}" importance="${escapeXml(memory.importance)}" score="${memory.score.toFixed(3)}">`,
			`    <content>${escapeXml(memory.content)}</content>`,
			`    <metadata>${escapeXml(formatMetadata(memory))}</metadata>`,
			"  </memory>",
		);
	}
	if (omittedCount > 0) {
		lines.push(`  <omitted count="${omittedCount}" reason="token_budget" />`);
	}
	lines.push("</memory_context>");
	return lines.join("\n");
}

export function formatContext(
	memories: readonly MemoryWithScore[],
	query: string,
	format: ContextFormat,
	omittedCount = 0,
): string {
	switch (format) {
		case "markdown":
			return formatMarkdown(memories, query, omittedCount);
		case "plain":
			return formatPlain(memories, query, omittedCount);
		case "xml":
			return formatXml(memories, query, omittedCount);
	}
}
