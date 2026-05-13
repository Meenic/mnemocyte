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

function formatMarkdown(
	memories: readonly MemoryWithScore[],
	query: string,
): string {
	const lines = [
		"# Memory Context",
		"",
		`Query: ${query}`,
		"",
		"## Relevant Memories",
	];
	for (const memory of memories) {
		lines.push("", `- ${memory.content}`, `  - ${formatMetadata(memory)}`);
	}
	return lines.join("\n");
}

function formatPlain(
	memories: readonly MemoryWithScore[],
	query: string,
): string {
	const lines = [
		"MEMORY CONTEXT",
		"",
		`QUERY: ${query}`,
		"",
		"RELEVANT MEMORIES",
	];
	for (const memory of memories) {
		lines.push("", memory.content, formatMetadata(memory));
	}
	return lines.join("\n");
}

function formatXml(
	memories: readonly MemoryWithScore[],
	query: string,
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
	lines.push("</memory_context>");
	return lines.join("\n");
}

export function formatContext(
	memories: readonly MemoryWithScore[],
	query: string,
	format: ContextFormat,
): string {
	switch (format) {
		case "markdown":
			return formatMarkdown(memories, query);
		case "plain":
			return formatPlain(memories, query);
		case "xml":
			return formatXml(memories, query);
	}
}
