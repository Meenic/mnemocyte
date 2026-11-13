import { type JSONSchema7, jsonSchema, type Tool, tool } from "ai";
import { isMnemocyteError, MnemocyteError } from "./errors.js";
import type {
	BoundMemoryClient,
	ImportanceLevel,
	MemoryKind,
	MemoryWithScore,
} from "./types.js";

export interface MemoryToolsOptions {
	/**
	 * A client bound to one scope, from `memory.for(scope)`. Every tool reads
	 * and writes that scope only; the model cannot name another.
	 */
	readonly memory: BoundMemoryClient;
}

/** Input of the `searchMemories` tool. */
export interface SearchMemoriesInput {
	/** What to look for, in natural language. */
	query: string;
	/** Most memories to return, 1–20. @defaultValue `5` */
	limit?: number;
	/** Only memories of these kinds. */
	kinds?: MemoryKind[];
}

/** A memory as the `searchMemories` tool returns it to the model. */
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

/** Output of the `searchMemories` tool. */
export interface SearchMemoriesOutput {
	/** Best match first. */
	memories: FoundMemory[];
}

/** Input of the `saveMemory` tool. */
export interface SaveMemoryInput {
	/** The memory, as a short standalone sentence. */
	content: string;
	/** @defaultValue `"fact"` */
	kind?: MemoryKind;
	/** @defaultValue `"normal"` */
	importance?: ImportanceLevel;
}

/** Output of the `saveMemory` tool. */
export interface SaveMemoryOutput {
	/** Id of the new memory. */
	id: string;
}

/** Input of the `forgetMemory` tool. */
export interface ForgetMemoryInput {
	/** Id of the memory, from `searchMemories`. */
	id: string;
}

/** Output of the `forgetMemory` tool. */
export interface ForgetMemoryOutput {
	/** `false` when no memory with that id is visible at the bound scope. */
	forgotten: boolean;
}

/**
 * The tools {@link memoryTools} returns, keyed by tool name. A type alias,
 * not an interface: only an object type is assignable to the AI SDK's
 * `ToolSet`, whose string index signature an interface does not satisfy.
 */
export type MemoryTools = {
	searchMemories: Tool<SearchMemoriesInput, SearchMemoriesOutput>;
	saveMemory: Tool<SaveMemoryInput, SaveMemoryOutput>;
	forgetMemory: Tool<ForgetMemoryInput, ForgetMemoryOutput>;
};

/** `source` of every memory `saveMemory` writes. */
const SAVE_SOURCE = "saveMemory";
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
/** Fields a model might send to reach another scope. */
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

type Validation<T> =
	| { success: true; value: T }
	| { success: false; error: Error };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): { success: false; error: Error } {
	return { success: false, error: new TypeError(message) };
}

/**
 * The input as an object with only `allowed` fields, or an error naming the
 * first field that is not allowed. A scope field gets its own message, so a
 * model that tries one learns the scope is fixed.
 */
function checkFields(
	value: unknown,
	allowed: readonly string[],
): Record<string, unknown> | Error {
	if (!isRecord(value)) {
		return new TypeError("Input must be an object.");
	}
	for (const field of Object.keys(value)) {
		if (allowed.includes(field)) {
			continue;
		}
		return new TypeError(
			SCOPE_FIELDS.has(field)
				? `${field} is not accepted: the memory scope is fixed by the application.`
				: `Unknown field ${field}.`,
		);
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

function validateSearchInput(value: unknown): Validation<SearchMemoriesInput> {
	const input = checkFields(value, ["query", "limit", "kinds"]);
	if (input instanceof Error) {
		return { success: false, error: input };
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
		success: true,
		value: {
			query,
			...(limit === undefined ? {} : { limit }),
			...(kinds === undefined ? {} : { kinds: [...kinds] }),
		},
	};
}

function validateSaveInput(value: unknown): Validation<SaveMemoryInput> {
	const input = checkFields(value, ["content", "kind", "importance"]);
	if (input instanceof Error) {
		return { success: false, error: input };
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
		success: true,
		value: {
			content,
			...(kind === undefined ? {} : { kind }),
			...(importance === undefined ? {} : { importance }),
		},
	};
}

function validateForgetInput(value: unknown): Validation<ForgetMemoryInput> {
	const input = checkFields(value, ["id"]);
	if (input instanceof Error) {
		return { success: false, error: input };
	}
	if (!isNonEmptyString(input.id)) {
		return invalid("id must be a non-empty string.");
	}
	return { success: true, value: { id: input.id } };
}

const SEARCH_SCHEMA: JSONSchema7 = {
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

const SAVE_SCHEMA: JSONSchema7 = {
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

const FORGET_SCHEMA: JSONSchema7 = {
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

function isBoundClient(value: unknown): value is BoundMemoryClient {
	return (
		isRecord(value) &&
		isRecord(value.scope) &&
		typeof value.search === "function" &&
		typeof value.add === "function" &&
		typeof value.delete === "function"
	);
}

/** The call's abort signal, read defensively for callers outside the AI SDK. */
function signalOf(options: unknown): { signal?: AbortSignal } {
	const signal = isRecord(options) ? options.abortSignal : undefined;
	return signal instanceof AbortSignal ? { signal } : {};
}

function toFoundMemory(memory: MemoryWithScore): FoundMemory {
	return {
		id: memory.id,
		content: memory.content,
		kind: memory.kind,
		importance: memory.importance,
		tags: memory.tags,
		createdAt: memory.createdAt.toISOString(),
		score: Math.round(memory.score * 1000) / 1000,
	};
}

/**
 * AI SDK tools over a bound client: `searchMemories`, `saveMemory` and
 * `forgetMemory`. The scope comes from `memory.for(scope)` on the server;
 * no tool takes a scope field, so a prompt injection cannot reach another
 * user's memories. Each tool forwards the call's `abortSignal`. Requires
 * the `ai` package.
 *
 * Errors other than a missing memory in `forgetMemory` are thrown, which
 * the AI SDK reports to the model as a tool error.
 *
 * @example
 * ```ts
 * import { generateText } from "ai";
 * import { memoryTools } from "mnemocyte/ai-sdk";
 *
 * const { text } = await generateText({
 *   model,
 *   tools: memoryTools({ memory: memory.for({ entityId: userId }) }),
 *   prompt,
 * });
 * ```
 */
export function memoryTools(options: MemoryToolsOptions): MemoryTools {
	if (!isRecord(options)) {
		throw new MnemocyteError(
			"memoryTools requires an options object.",
			"CONFIG",
		);
	}
	const { memory } = options;
	if (!isBoundClient(memory)) {
		throw new MnemocyteError(
			"memoryTools requires a bound client: pass memory.for(scope), not the client itself.",
			"CONFIG",
		);
	}

	return {
		searchMemories: tool({
			description:
				"Search long-term memory about the user for facts, preferences and past events relevant to the conversation. Use it before answering anything that depends on what you know about them. Returns the best matches first, each with an id.",
			inputSchema: jsonSchema<SearchMemoriesInput>(SEARCH_SCHEMA, {
				validate: validateSearchInput,
			}),
			async execute(input, callOptions) {
				const results = await memory.search({
					query: input.query,
					limit: input.limit ?? DEFAULT_SEARCH_LIMIT,
					...(input.kinds === undefined || input.kinds.length === 0
						? {}
						: { kinds: input.kinds }),
					...signalOf(callOptions),
				});
				return { memories: results.map(toFoundMemory) };
			},
		}),
		saveMemory: tool({
			description:
				"Save one durable fact about the user, such as a preference, a goal or a personal detail they shared, so later conversations can recall it. Save each fact once, as a short standalone sentence. Never save passwords, keys, payment details or other secrets.",
			inputSchema: jsonSchema<SaveMemoryInput>(SAVE_SCHEMA, {
				validate: validateSaveInput,
			}),
			async execute(input, callOptions) {
				const saved = await memory.add({
					content: input.content,
					...(input.kind === undefined ? {} : { kind: input.kind }),
					...(input.importance === undefined
						? {}
						: { importance: input.importance }),
					source: SAVE_SOURCE,
					...signalOf(callOptions),
				});
				return { id: saved.id };
			},
		}),
		forgetMemory: tool({
			description:
				"Delete one memory about the user by its id from searchMemories, for example when they ask you to forget something or a memory is wrong. Returns forgotten: false when no memory has that id.",
			inputSchema: jsonSchema<ForgetMemoryInput>(FORGET_SCHEMA, {
				validate: validateForgetInput,
			}),
			async execute(input, callOptions) {
				try {
					await memory.delete({ id: input.id, ...signalOf(callOptions) });
					return { forgotten: true };
				} catch (error) {
					if (isMnemocyteError(error) && error.code === "NOT_FOUND") {
						return { forgotten: false };
					}
					throw error;
				}
			},
		}),
	};
}
