import type {
	CallToolResult,
	StandardSchemaWithJSON,
	ToolAnnotations,
} from "@modelcontextprotocol/server";
import type {
	BoundMemoryClient,
	ImportanceLevel,
	MemoryKind,
	MemoryWithScore,
} from "mnemocyte";
import { isMnemocyteError } from "mnemocyte";

// The tools mirror `memoryTools` from `mnemocyte/ai-sdk`: the same names,
// inputs, outputs and checks, written again here because that entry needs
// the `ai` package. Keep the two in step.

/** Input of the `searchMemories` tool. */
export interface SearchMemoriesInput {
	query: string;
	limit?: number;
	kinds?: MemoryKind[];
}

/** A memory as the `searchMemories` tool returns it. */
export interface FoundMemory {
	id: string;
	content: string;
	kind: MemoryKind;
	importance: ImportanceLevel;
	tags: string[];
	/** ISO 8601 creation time. */
	createdAt: string;
	/** Relevance in `[0, 1]`, rounded to three decimals. */
	score: number;
}

/** Input of the `saveMemory` tool. */
export interface SaveMemoryInput {
	content: string;
	kind?: MemoryKind;
	importance?: ImportanceLevel;
}

/** Input of the `forgetMemory` tool. */
export interface ForgetMemoryInput {
	id: string;
}

/** The names of the tools the server can list. */
export type MemoryToolName = "searchMemories" | "saveMemory" | "forgetMemory";

/** One tool, ready for `McpServer.registerTool`. */
export interface MemoryToolDefinition<Input> {
	readonly name: MemoryToolName;
	readonly title: string;
	readonly description: string;
	readonly inputSchema: StandardSchemaWithJSON<Input, Input>;
	readonly outputSchema: StandardSchemaWithJSON;
	readonly annotations: ToolAnnotations;
	readonly run: (input: Input, signal: AbortSignal) => Promise<CallToolResult>;
}

/** The value that tells the app's memories from the ones a model saved. */
export const SAVE_SOURCE = "saveMemory";

const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 20;

const MEMORY_KINDS: readonly MemoryKind[] = [
	"fact",
	"preference",
	"instruction",
	"backstory",
	"episode",
	"session",
];
const IMPORTANCE_LEVELS: readonly ImportanceLevel[] = [
	"low",
	"normal",
	"high",
	"critical",
];
const SCOPE_FIELDS: ReadonlySet<string> = new Set([
	"scope",
	"namespace",
	"entityId",
	"agentId",
	"sessionId",
	"allNamespaces",
]);

const KIND_DESCRIPTION =
	"fact: a stable statement about the user; preference: how they like things done; instruction: a standing request for how to respond; backstory: long-lived background; episode: something that happened; session: context for this conversation only.";

type JsonObject = Record<string, unknown>;
type Validation<T> =
	| { readonly value: T; readonly issues?: undefined }
	| { readonly issues: readonly { readonly message: string }[] };

function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): Validation<never> {
	return { issues: [{ message }] };
}

function checkFields(
	value: unknown,
	allowed: readonly string[],
): JsonObject | string {
	if (!isRecord(value)) {
		return "Input must be an object.";
	}
	for (const field of Object.keys(value)) {
		if (allowed.includes(field)) {
			continue;
		}
		return SCOPE_FIELDS.has(field)
			? `${field} is not accepted: the memory scope is fixed by the server.`
			: `Unknown field ${field}.`;
	}
	return value;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isOneOf<T extends string>(
	value: unknown,
	options: readonly T[],
): value is T {
	return (
		typeof value === "string" && (options as readonly string[]).includes(value)
	);
}

/** @internal Exported for tests. */
export function validateSearchInput(
	value: unknown,
): Validation<SearchMemoriesInput> {
	const input = checkFields(value, ["query", "limit", "kinds"]);
	if (typeof input === "string") {
		return invalid(input);
	}
	const { query, limit, kinds } = input;
	if (!isNonEmptyString(query)) {
		return invalid("query must be a non-empty string.");
	}
	if (
		limit !== undefined &&
		(typeof limit !== "number" ||
			!Number.isInteger(limit) ||
			limit < 1 ||
			limit > MAX_SEARCH_LIMIT)
	) {
		return invalid(`limit must be an integer from 1 to ${MAX_SEARCH_LIMIT}.`);
	}
	if (
		kinds !== undefined &&
		(!Array.isArray(kinds) ||
			!kinds.every((kind) => isOneOf(kind, MEMORY_KINDS)))
	) {
		return invalid(`kinds must be an array of ${MEMORY_KINDS.join(", ")}.`);
	}
	return {
		value: {
			query,
			...(limit === undefined ? {} : { limit }),
			...(kinds === undefined ? {} : { kinds: [...kinds] }),
		},
	};
}

/** @internal Exported for tests. */
export function validateSaveInput(value: unknown): Validation<SaveMemoryInput> {
	const input = checkFields(value, ["content", "kind", "importance"]);
	if (typeof input === "string") {
		return invalid(input);
	}
	const { content, kind, importance } = input;
	if (!isNonEmptyString(content)) {
		return invalid("content must be a non-empty string.");
	}
	if (kind !== undefined && !isOneOf(kind, MEMORY_KINDS)) {
		return invalid(`kind must be one of ${MEMORY_KINDS.join(", ")}.`);
	}
	if (importance !== undefined && !isOneOf(importance, IMPORTANCE_LEVELS)) {
		return invalid(
			`importance must be one of ${IMPORTANCE_LEVELS.join(", ")}.`,
		);
	}
	return {
		value: {
			content,
			...(kind === undefined ? {} : { kind }),
			...(importance === undefined ? {} : { importance }),
		},
	};
}

/** @internal Exported for tests. */
export function validateForgetInput(
	value: unknown,
): Validation<ForgetMemoryInput> {
	const input = checkFields(value, ["id"]);
	if (typeof input === "string") {
		return invalid(input);
	}
	if (!isNonEmptyString(input.id)) {
		return invalid("id must be a non-empty string.");
	}
	return { value: { id: input.id } };
}

/**
 * A Standard Schema over a fixed JSON Schema and a validator of our own, so
 * the error messages match `memoryTools` and no schema library is needed.
 */
function schema<T>(
	json: JsonObject,
	validate: (value: unknown) => Validation<T>,
): StandardSchemaWithJSON<T, T> {
	return {
		"~standard": {
			version: 1,
			vendor: "mnemocyte",
			validate,
			jsonSchema: {
				input: () => structuredClone(json),
				output: () => structuredClone(json),
			},
		},
	};
}

/** An output schema: the server builds the value, so it is not checked again. */
function outputSchema(json: JsonObject): StandardSchemaWithJSON {
	return schema<unknown>(json, (value) => ({ value }));
}

const SEARCH_INPUT: JsonObject = {
	type: "object",
	properties: {
		query: {
			type: "string",
			description: "What to look for, in natural language.",
		},
		limit: {
			type: "integer",
			minimum: 1,
			maximum: MAX_SEARCH_LIMIT,
			description: `Most memories to return. Defaults to ${DEFAULT_SEARCH_LIMIT}.`,
		},
		kinds: {
			type: "array",
			items: { type: "string", enum: [...MEMORY_KINDS] },
			description: `Only memories of these kinds. ${KIND_DESCRIPTION}`,
		},
	},
	required: ["query"],
	additionalProperties: false,
};

const SEARCH_OUTPUT: JsonObject = {
	type: "object",
	properties: {
		memories: {
			type: "array",
			description: "Best match first.",
			items: {
				type: "object",
				properties: {
					id: { type: "string" },
					content: { type: "string" },
					kind: { type: "string", enum: [...MEMORY_KINDS] },
					importance: { type: "string", enum: [...IMPORTANCE_LEVELS] },
					tags: { type: "array", items: { type: "string" } },
					createdAt: { type: "string", format: "date-time" },
					score: { type: "number", minimum: 0, maximum: 1 },
				},
				required: [
					"id",
					"content",
					"kind",
					"importance",
					"tags",
					"createdAt",
					"score",
				],
				additionalProperties: false,
			},
		},
	},
	required: ["memories"],
	additionalProperties: false,
};

const SAVE_INPUT: JsonObject = {
	type: "object",
	properties: {
		content: {
			type: "string",
			description:
				"The memory as a short standalone sentence, for example: Prefers metric units.",
		},
		kind: {
			type: "string",
			enum: [...MEMORY_KINDS],
			description: `Defaults to fact. ${KIND_DESCRIPTION}`,
		},
		importance: {
			type: "string",
			enum: [...IMPORTANCE_LEVELS],
			description: "Defaults to normal.",
		},
	},
	required: ["content"],
	additionalProperties: false,
};

const SAVE_OUTPUT: JsonObject = {
	type: "object",
	properties: { id: { type: "string", description: "Id of the new memory." } },
	required: ["id"],
	additionalProperties: false,
};

const FORGET_INPUT: JsonObject = {
	type: "object",
	properties: {
		id: {
			type: "string",
			description: "Id of the memory, from searchMemories.",
		},
	},
	required: ["id"],
	additionalProperties: false,
};

/** What `forgetMemory` tells the model when no memory has the id. */
const FORGET_NOT_FOUND =
	"Nothing was deleted: no memory has this id. Call searchMemories, then forgetMemory with an id from its results.";

const FORGET_OUTPUT: JsonObject = {
	type: "object",
	properties: {
		forgotten: {
			type: "boolean",
			description:
				"false when no memory with that id is visible; nothing was deleted.",
		},
		content: {
			type: "string",
			description: "The deleted memory's content, when forgotten is true.",
		},
		message: {
			type: "string",
			description: "What to do next, when forgotten is false.",
		},
	},
	required: ["forgotten"],
	additionalProperties: false,
};

function result(value: JsonObject): CallToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify(value) }],
		structuredContent: value,
	};
}

function toFoundMemory(memory: MemoryWithScore): FoundMemory {
	return {
		id: memory.id,
		content: memory.content,
		kind: memory.kind,
		importance: memory.importance,
		tags: [...memory.tags],
		createdAt: memory.createdAt.toISOString(),
		score: Math.round(memory.score * 1000) / 1000,
	};
}

/** The search tool over a bound client. */
export function searchTool(
	memory: BoundMemoryClient,
): MemoryToolDefinition<SearchMemoriesInput> {
	return {
		name: "searchMemories",
		title: "Search memories",
		description:
			"Search long-term memory about the user for facts, preferences and past events relevant to the conversation. Use it before answering anything that depends on what you know about them. Returns the best matches first, each with an id.",
		inputSchema: schema(SEARCH_INPUT, validateSearchInput),
		outputSchema: outputSchema(SEARCH_OUTPUT),
		annotations: { readOnlyHint: true, openWorldHint: false },
		async run(input, signal) {
			const found = await memory.search({
				query: input.query,
				limit: input.limit ?? DEFAULT_SEARCH_LIMIT,
				...(input.kinds === undefined || input.kinds.length === 0
					? {}
					: { kinds: input.kinds }),
				signal,
			});
			return result({ memories: found.map(toFoundMemory) });
		},
	};
}

/** The save tool over a bound client. */
export function saveTool(
	memory: BoundMemoryClient,
): MemoryToolDefinition<SaveMemoryInput> {
	return {
		name: "saveMemory",
		title: "Save a memory",
		description:
			"Save one durable fact about the user, such as a preference, a goal or a personal detail they shared, so later conversations can recall it. Save each fact once, as a short standalone sentence. Never save passwords, keys, payment details or other secrets.",
		inputSchema: schema(SAVE_INPUT, validateSaveInput),
		outputSchema: outputSchema(SAVE_OUTPUT),
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
		async run(input, signal) {
			const saved = await memory.add({
				content: input.content,
				...(input.kind === undefined ? {} : { kind: input.kind }),
				...(input.importance === undefined
					? {}
					: { importance: input.importance }),
				source: SAVE_SOURCE,
				signal,
			});
			return result({ id: saved.id });
		},
	};
}

/** The forget tool over a bound client. */
export function forgetTool(
	memory: BoundMemoryClient,
): MemoryToolDefinition<ForgetMemoryInput> {
	return {
		name: "forgetMemory",
		title: "Forget a memory",
		description:
			"Delete one memory about the user by its id from searchMemories, for example when they ask you to forget something or a memory is wrong. Never guess an id, even for a memory you already see in your context: call searchMemories first and use an id from its results. Duplicates that were merged into it are deleted too. Returns the content of the memory it deleted: check it is the one you meant, and if not, tell the user. Returns forgotten: false with a message when no memory has that id; then nothing was deleted, so do not tell the user it was.",
		inputSchema: schema(FORGET_INPUT, validateForgetInput),
		outputSchema: outputSchema(FORGET_OUTPUT),
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		async run(input, signal) {
			try {
				// delete returns ids only, so read the content first.
				const found = await memory.get({ id: input.id, signal });
				if (!found) {
					return result({ forgotten: false, message: FORGET_NOT_FOUND });
				}
				// Search shows only consolidation survivors, so forgetting one
				// also deletes the duplicates merged into it.
				await memory.delete({ id: input.id, dependents: "delete", signal });
				return result({ forgotten: true, content: found.content });
			} catch (error) {
				if (isMnemocyteError(error) && error.code === "NOT_FOUND") {
					return result({ forgotten: false, message: FORGET_NOT_FOUND });
				}
				throw error;
			}
		},
	};
}
