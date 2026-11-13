import { generateText, jsonSchema, type LanguageModel, Output } from "ai";
import type { MemoryPrompt } from "./ai-sdk-middleware.js";
import { MnemocyteError } from "./errors.js";
import type {
	BoundMemoryClient,
	ImportanceLevel,
	Memory,
	MemoryKind,
	MemoryWithScore,
} from "./types.js";

/** Settings for {@link extractMemories} and the middleware's `save` option. */
export interface ExtractMemoriesOptions {
	/**
	 * The language model that extracts memories: a model object such as
	 * `openai("gpt-6.1-mini")`, or a `"provider/model"` id, which the AI SDK
	 * resolves through its global provider (the AI Gateway by default). It
	 * must support structured output.
	 */
	readonly model: LanguageModel;
	/**
	 * Guidance added after the built-in extraction prompt, such as "Only
	 * remember dietary preferences." It cannot replace the built-in rules.
	 */
	readonly instructions?: string;
	/** Most memories stored per turn, 1–20. @defaultValue `10` */
	readonly maxMemories?: number;
	/**
	 * Milliseconds the whole extraction (search, model call and write) may
	 * take before it fails with `"TIMEOUT"`. @defaultValue `30000`
	 */
	readonly timeout?: number;
}

/** Input of {@link extractMemories}. */
export interface ExtractMemoriesInput extends ExtractMemoriesOptions {
	/** A client bound to one scope, from `memory.for(scope)`. */
	readonly memory: BoundMemoryClient;
	/** The conversation, in the AI SDK's provider format (`MemoryTurn.prompt`). */
	readonly prompt: MemoryPrompt;
	/** The response to the last user message (`MemoryTurn.text`). */
	readonly text: string;
	/** Cancels the extraction. */
	readonly signal?: AbortSignal;
}

/** The kinds extraction may set; `episode` and `session` are not lasting facts. */
type ExtractedKind = Extract<
	MemoryKind,
	"fact" | "preference" | "instruction" | "backstory"
>;
/** The importance levels extraction may set; `critical` stays the app's. */
type ExtractedImportance = Exclude<ImportanceLevel, "critical">;

interface ExtractedMemory {
	key: string;
	content: string;
	kind: ExtractedKind;
	importance: ExtractedImportance;
}

interface ExtractionOutput {
	memories: ExtractedMemory[];
}

/** Resolved, validated settings. */
export interface ResolvedExtractionOptions {
	readonly model: LanguageModel;
	readonly instructions: string | undefined;
	readonly maxMemories: number;
	readonly timeout: number;
}

/** `source` of every memory extraction writes. */
export const EXTRACTION_SOURCE = "extractMemories";
/**
 * Prefix of every key extraction writes, so it never overwrites a key the
 * application chose.
 */
export const EXTRACTED_KEY_PREFIX = "extracted:";
/**
 * Provider options that mark the extraction call. The middleware leaves a
 * call carrying them alone, so passing a model wrapped with memory as the
 * extraction model cannot recurse.
 */
export const EXTRACTION_MARKER = "mnemocyte";

const DEFAULT_MAX_MEMORIES = 10;
const MAX_MAX_MEMORIES = 20;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_INSTRUCTIONS_LENGTH = 4_000;
/** Existing memories shown to the model. */
const EXISTING_LIMIT = 20;
/** Characters of each existing memory shown to the model. */
const EXISTING_CONTENT_LENGTH = 500;
/** Characters kept from each part of the turn. */
const USER_TEXT_LENGTH = 8_000;
const PREVIOUS_TEXT_LENGTH = 2_000;
const RESPONSE_TEXT_LENGTH = 4_000;
const MAX_KEY_LENGTH = 64;

const KINDS: readonly ExtractedKind[] = [
	"fact",
	"preference",
	"instruction",
	"backstory",
];
const IMPORTANCE_LEVELS: readonly ExtractedImportance[] = [
	"low",
	"normal",
	"high",
];

const SYSTEM_PROMPT = `You extract long-term memories about the user from one turn of a conversation between the user and an AI assistant.

The input is JSON with:
- existingMemories: what is already stored about the user. Some have a key.
- conversation.previousAssistantMessage: what the assistant said before the user's message, for context.
- conversation.userMessage: the user's message in this turn.
- conversation.assistantResponse: the assistant's answer, for context.

Rules:
- Save only lasting information about the user that the user stated or confirmed in userMessage. Never save something only the assistant said.
- Do not save small talk, questions, one-off requests, details of the current task that will not matter in later conversations, or anything the user asked not to remember.
- Never save secrets: passwords, API keys, access tokens, payment card or bank account numbers, or government id numbers.
- Write each memory as one short, standalone sentence about the user, in the language the user wrote in, for example "Lives in Lisbon." or "Prefers answers without emoji."
- If an existing memory already says the same thing, do not return it.
- If the user changed something an existing memory with a key states, return the new version with that same key. Otherwise give each memory a new short snake_case key that names what it is about, such as home_city or preferred_language.
- kind is one of: fact (a stable statement about the user), preference (how they like things done), instruction (a standing request for how the assistant should respond), backstory (long-lived background about their life or work).
- importance is low, normal or high. Use high only for things the assistant must not get wrong, such as allergies.
- Usually there is nothing worth saving: then return an empty memories array.`;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configError(name: string, message: string): MnemocyteError {
	return new MnemocyteError(`${name} ${message}`, "CONFIG");
}

function isModel(value: unknown): value is LanguageModel {
	return (
		(typeof value === "string" && value.trim().length > 0) || isRecord(value)
	);
}

/**
 * Check the extraction settings and fill in defaults. `name` prefixes the
 * error messages (`memoryMiddleware save`, `extractMemories`).
 */
export function resolveExtractionOptions(
	name: string,
	options: Record<string, unknown>,
): ResolvedExtractionOptions {
	const { model, instructions, maxMemories, timeout } = options;
	if (!isModel(model)) {
		throw configError(
			name,
			'requires a model: a language model object or a "provider/model" id.',
		);
	}
	if (
		instructions !== undefined &&
		(typeof instructions !== "string" ||
			instructions.length > MAX_INSTRUCTIONS_LENGTH)
	) {
		throw configError(
			name,
			`instructions must be a string of at most ${MAX_INSTRUCTIONS_LENGTH} characters.`,
		);
	}
	if (
		maxMemories !== undefined &&
		(typeof maxMemories !== "number" ||
			!Number.isInteger(maxMemories) ||
			maxMemories < 1 ||
			maxMemories > MAX_MAX_MEMORIES)
	) {
		throw configError(
			name,
			`maxMemories must be an integer from 1 to ${MAX_MAX_MEMORIES}.`,
		);
	}
	if (
		timeout !== undefined &&
		(typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1)
	) {
		throw configError(name, "timeout must be a positive integer (ms).");
	}
	return {
		model,
		instructions:
			instructions === undefined || instructions.trim().length === 0
				? undefined
				: instructions,
		maxMemories: maxMemories ?? DEFAULT_MAX_MEMORIES,
		timeout: timeout ?? DEFAULT_TIMEOUT_MS,
	};
}

function isExtractionClient(value: unknown): value is BoundMemoryClient {
	return (
		isRecord(value) &&
		isRecord(value.scope) &&
		typeof value.search === "function" &&
		typeof value.addMany === "function"
	);
}

/** True for a model call that {@link extractMemories} made. */
export function isExtractionCall(providerOptions: unknown): boolean {
	return (
		isRecord(providerOptions) &&
		isRecord(providerOptions[EXTRACTION_MARKER]) &&
		providerOptions[EXTRACTION_MARKER].extraction === true
	);
}

/** Text parts of a user or assistant message, joined with newlines. */
function messageText(message: MemoryPrompt[number]): string {
	if (message.role === "system") {
		return "";
	}
	return message.content
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n")
		.trim();
}

function tail(text: string, length: number): string {
	return text.length > length ? text.slice(-length) : text;
}

function head(text: string, length: number): string {
	return text.length > length ? text.slice(0, length) : text;
}

interface TurnText {
	readonly previous: string;
	readonly user: string;
}

/**
 * The user messages of the last turn (the run of user messages that ends
 * with the last one) and the text of the assistant message before them.
 * System messages, tool calls, tool results and files are left out.
 */
function readTurn(prompt: MemoryPrompt): TurnText {
	const last = prompt.findLastIndex((message) => message.role === "user");
	if (last < 0) {
		return { previous: "", user: "" };
	}
	let first = last;
	while (first > 0 && prompt[first - 1]?.role === "user") {
		first--;
	}
	const user = prompt
		.slice(first, last + 1)
		.map(messageText)
		.filter((text) => text.length > 0)
		.join("\n\n");
	const before = prompt[first - 1];
	const previous = before?.role === "assistant" ? messageText(before) : "";
	return {
		previous: tail(previous, PREVIOUS_TEXT_LENGTH),
		user: tail(user, USER_TEXT_LENGTH),
	};
}

function sameScope(memory: MemoryWithScore, bound: BoundMemoryClient): boolean {
	const { scope } = bound;
	return (
		memory.scope.namespace === scope.namespace &&
		memory.scope.entityId === scope.entityId &&
		memory.scope.agentId === (scope.agentId ?? null) &&
		memory.scope.sessionId === (scope.sessionId ?? null)
	);
}

/**
 * An existing memory as the model sees it. Only extracted keys in the bound
 * scope are shown: those are the keys an upsert from here would update.
 */
function describeExisting(
	memory: MemoryWithScore,
	bound: BoundMemoryClient,
): Record<string, string> {
	const key =
		memory.key?.startsWith(EXTRACTED_KEY_PREFIX) && sameScope(memory, bound)
			? memory.key.slice(EXTRACTED_KEY_PREFIX.length)
			: undefined;
	return {
		...(key === undefined ? {} : { key }),
		kind: memory.kind,
		content: head(memory.content, EXISTING_CONTENT_LENGTH),
	};
}

/** Lower-case snake_case, at most 64 characters, or `""`. */
function normalizeKey(key: string): string {
	return key
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, MAX_KEY_LENGTH)
		.replace(/_+$/, "");
}

type Validation<T> =
	| { success: true; value: T }
	| { success: false; error: Error };

function invalid(message: string): { success: false; error: Error } {
	return { success: false, error: new TypeError(message) };
}

function isOneOf<T extends string>(
	value: unknown,
	options: readonly T[],
): value is T {
	return (
		typeof value === "string" && (options as readonly string[]).includes(value)
	);
}

/** Check the model's output and normalize keys. */
function validateOutput(value: unknown): Validation<ExtractionOutput> {
	if (!isRecord(value) || !Array.isArray(value.memories)) {
		return invalid("Output must be an object with a memories array.");
	}
	const memories: ExtractedMemory[] = [];
	for (const [index, item] of value.memories.entries()) {
		if (!isRecord(item)) {
			return invalid(`memories[${index}] must be an object.`);
		}
		const { key, content, kind, importance } = item;
		if (typeof key !== "string" || normalizeKey(key).length === 0) {
			return invalid(`memories[${index}].key must be a snake_case name.`);
		}
		if (typeof content !== "string" || content.trim().length === 0) {
			return invalid(`memories[${index}].content must be a non-empty string.`);
		}
		if (!isOneOf(kind, KINDS)) {
			return invalid(`memories[${index}].kind must be ${KINDS.join(", ")}.`);
		}
		if (!isOneOf(importance, IMPORTANCE_LEVELS)) {
			return invalid(
				`memories[${index}].importance must be ${IMPORTANCE_LEVELS.join(", ")}.`,
			);
		}
		memories.push({
			key: normalizeKey(key),
			content: content.trim(),
			kind,
			importance,
		});
	}
	return { success: true, value: { memories } };
}

/**
 * Every property is required and no others are allowed, so providers with
 * a strict JSON Schema mode (OpenAI's structured outputs) accept it. Limits
 * the model may ignore (count, key format) are applied after validation.
 */
const OUTPUT_SCHEMA = jsonSchema<ExtractionOutput>(
	{
		type: "object",
		properties: {
			memories: {
				type: "array",
				description: "Memories to store. Empty when nothing is worth saving.",
				items: {
					type: "object",
					properties: {
						key: {
							type: "string",
							description:
								"snake_case name of what the memory is about, such as home_city. Reuse an existing memory's key to update it.",
						},
						content: {
							type: "string",
							description: "One short, standalone sentence about the user.",
						},
						kind: { type: "string", enum: [...KINDS] },
						importance: { type: "string", enum: [...IMPORTANCE_LEVELS] },
					},
					required: ["key", "content", "kind", "importance"],
					additionalProperties: false,
				},
			},
		},
		required: ["memories"],
		additionalProperties: false,
	},
	{ validate: validateOutput },
);

/** The last occurrence of each key, in first-seen order, at most `limit`. */
function selectMemories(
	memories: readonly ExtractedMemory[],
	limit: number,
): ExtractedMemory[] {
	const byKey = new Map<string, ExtractedMemory>();
	for (const memory of memories) {
		byKey.set(memory.key, memory);
	}
	return [...byKey.values()].slice(0, limit);
}

function combineSignals(
	timeout: AbortSignal,
	signal: AbortSignal | undefined,
): AbortSignal {
	return signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
}

/**
 * Have a language model extract lasting memories about the user from the
 * last turn of a conversation, and store them in the bound scope.
 *
 * The model sees the user messages of the last turn, the assistant message
 * before them and the response; never system messages, tool calls, tool
 * results or files. It also sees up to 20 memories from a `search` of the
 * bound scope, so it can skip facts already stored and update the ones it
 * stored before: every extracted memory has a key prefixed `extracted:`,
 * and `addMany` upserts by key, so a changed fact updates in place.
 * Memories get `source: "extractMemories"`.
 *
 * Returns the stored memories (new or updated); `[]` when the model found
 * nothing or the prompt has no user text. Fails with `"TIMEOUT"` after
 * `timeout` ms and with the AI SDK's `NoObjectGeneratedError` when the
 * model's output does not match the schema. Requires the `ai` package.
 *
 * @example
 * ```ts
 * import { extractMemories, withMemory } from "mnemocyte/ai-sdk";
 *
 * const model = withMemory({
 *   model: openai("gpt-6.1-sol"),
 *   memory: user,
 *   save: (turn) => {
 *     waitUntil(extractMemories({ ...turn, model: openai("gpt-6.1-mini") }));
 *   },
 * });
 * ```
 */
export async function extractMemories(
	input: ExtractMemoriesInput,
): Promise<Memory[]> {
	const name = "extractMemories";
	if (!isRecord(input)) {
		throw configError(name, "requires an input object.");
	}
	const { memory, prompt, text, signal } = input;
	if (!isExtractionClient(memory)) {
		throw configError(
			name,
			"requires a bound client: pass memory.for(scope), not the client itself.",
		);
	}
	if (!Array.isArray(prompt)) {
		throw new MnemocyteError(`${name} prompt must be an array.`, "VALIDATION");
	}
	if (typeof text !== "string") {
		throw new MnemocyteError(`${name} text must be a string.`, "VALIDATION");
	}
	return runExtraction({
		...resolveExtractionOptions(name, input),
		memory,
		prompt,
		text,
		...(signal === undefined ? {} : { signal }),
	});
}

/** {@link extractMemories} with settings already checked. */
export async function runExtraction(
	input: ResolvedExtractionOptions & {
		readonly memory: BoundMemoryClient;
		readonly prompt: MemoryPrompt;
		readonly text: string;
		readonly signal?: AbortSignal;
	},
): Promise<Memory[]> {
	const { memory, maxMemories, timeout } = input;
	const turn = readTurn(input.prompt);
	if (turn.user.length === 0) {
		return [];
	}
	const timer = AbortSignal.timeout(timeout);
	const signal = combineSignals(timer, input.signal);
	try {
		const existing = await memory.search({
			query: turn.user,
			limit: EXISTING_LIMIT,
			trackAccess: false,
			signal,
		});
		const { output } = await generateText({
			model: input.model,
			instructions:
				input.instructions === undefined
					? `${SYSTEM_PROMPT}\n- Return at most ${maxMemories} memories.`
					: `${SYSTEM_PROMPT}\n- Return at most ${maxMemories} memories.\n\nApplication guidance:\n${input.instructions}`,
			prompt: JSON.stringify({
				existingMemories: existing.map((found) =>
					describeExisting(found, memory),
				),
				conversation: {
					previousAssistantMessage: turn.previous,
					userMessage: turn.user,
					assistantResponse: head(input.text.trim(), RESPONSE_TEXT_LENGTH),
				},
			}),
			output: Output.object({
				schema: OUTPUT_SCHEMA,
				name: "memories",
				description: "Long-term memories about the user from this turn.",
			}),
			abortSignal: signal,
			providerOptions: { [EXTRACTION_MARKER]: { extraction: true } },
		});
		const selected = selectMemories(output.memories, maxMemories);
		if (selected.length === 0) {
			return [];
		}
		return await memory.addMany({
			memories: selected.map((extracted) => ({
				key: `${EXTRACTED_KEY_PREFIX}${extracted.key}`,
				content: extracted.content,
				kind: extracted.kind,
				importance: extracted.importance,
				source: EXTRACTION_SOURCE,
			})),
			signal,
		});
	} catch (error) {
		if (timer.aborted && input.signal?.aborted !== true) {
			throw new MnemocyteError(
				`extractMemories timed out after ${timeout} ms.`,
				"TIMEOUT",
				error,
			);
		}
		throw error;
	}
}
