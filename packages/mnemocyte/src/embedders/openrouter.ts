import { MnemocyteError } from "../errors.js";
import { assertKnownKeys, RENAMED_BASE_URL } from "../options.js";
import type { Embedder, EmbeddingPurpose, JsonObject } from "../types.js";
import {
	assertVectorList,
	createFetchEmbedder,
	isRecord,
	type PurposeHints,
	parseIndexedEmbeddings,
	type ResolvedHint,
	resolveApiKey,
	resolveBaseURL,
	resolveFetch,
	resolveHeaders,
	resolveMaxBatch,
	resolveModel,
	resolveModelDimensions,
	resolvePurposes,
} from "./internal/http-embedder.js";
import {
	OPENROUTER_MODELS,
	openrouterPurposeHint,
	withoutVendor,
} from "./internal/openrouter-models.js";
import { createProviderError } from "./internal/provider-error.js";

const NAME = "openrouterEmbedder";

/** The `provider` fields of OpenRouter's embeddings request schema. */
const ROUTING_KEYS = [
	"order",
	"allow_fallbacks",
	"require_parameters",
	"data_collection",
	"zdr",
	"enforce_distillable_text",
	"only",
	"ignore",
	"quantizations",
	"sort",
	"max_price",
	"preferred_min_throughput",
	"preferred_max_latency",
	"options",
];

/** How OpenRouter's `sort` ranks providers. */
type OpenRouterSortBy = "price" | "throughput" | "latency" | "exacto";

/** Percentile cutoffs for OpenRouter's performance preferences. */
export interface OpenRouterPercentiles {
	readonly p50?: number | undefined;
	readonly p75?: number | undefined;
	readonly p90?: number | undefined;
	readonly p99?: number | undefined;
}

/**
 * OpenRouter's provider routing preferences, sent as the request's
 * `provider` object with the names OpenRouter's API uses. See
 * https://openrouter.ai/docs/guides/routing/provider-selection.
 */
export interface OpenRouterRouting {
	/** Provider slugs to try in order, such as `["deepinfra"]`. */
	readonly order?: readonly string[] | undefined;
	/** Try other providers when those in `order` fail. Defaults to `true`. */
	readonly allow_fallbacks?: boolean | undefined;
	/** Only use providers that support every request parameter. */
	readonly require_parameters?: boolean | undefined;
	/** `"deny"` skips providers that may store or train on data. */
	readonly data_collection?: "allow" | "deny" | undefined;
	/** Only use Zero Data Retention endpoints. */
	readonly zdr?: boolean | undefined;
	/** Only use models that allow text distillation. */
	readonly enforce_distillable_text?: boolean | undefined;
	/** Provider slugs to allow. */
	readonly only?: readonly string[] | undefined;
	/** Provider slugs to skip. */
	readonly ignore?: readonly string[] | undefined;
	/** Quantization levels to allow, such as `["fp16", "bf16"]`. */
	readonly quantizations?: readonly string[] | undefined;
	/**
	 * Prefer the cheapest, fastest or quickest-to-answer provider, or
	 * `"exacto"`, the values OpenRouter's schema lists. The object form adds
	 * `partition`: `"none"` sorts endpoints across models instead of within
	 * each.
	 */
	readonly sort?:
		| OpenRouterSortBy
		| {
				readonly by?: OpenRouterSortBy | undefined;
				readonly partition?: "model" | "none" | undefined;
		  }
		| undefined;
	/**
	 * Highest price to pay, in dollars per million tokens or per request,
	 * image or audio unit. OpenRouter's schema types the values as strings;
	 * numbers are sent as given.
	 */
	readonly max_price?:
		| {
				readonly prompt?: number | string | undefined;
				readonly completion?: number | string | undefined;
				readonly request?: number | string | undefined;
				readonly image?: number | string | undefined;
				readonly audio?: number | string | undefined;
		  }
		| undefined;
	/** Preferred lowest throughput, in tokens per second. */
	readonly preferred_min_throughput?:
		| number
		| OpenRouterPercentiles
		| undefined;
	/** Preferred highest latency, in seconds. */
	readonly preferred_max_latency?: number | OpenRouterPercentiles | undefined;
	/**
	 * Settings for one provider, keyed by its slug, such as
	 * `{ openai: { … } }`. OpenRouter forwards only the settings of the
	 * provider that serves the request and drops keys it does not know.
	 */
	readonly options?: Readonly<Record<string, JsonObject>> | undefined;
}

/** Your app, as OpenRouter shows it in its rankings and your activity. */
export interface OpenRouterApp {
	/** Your app's URL, sent as `HTTP-Referer`. */
	readonly url: string;
	/**
	 * Your app's name, sent as `X-OpenRouter-Title`. OpenRouter needs it to
	 * track an app whose `url` is on `localhost`.
	 */
	readonly name?: string | undefined;
}

/**
 * Options for {@link openrouterEmbedder}. Only `model` is required; a model
 * it does not know also needs `dimensions`.
 */
export interface OpenRouterEmbedderOptions {
	/** OpenRouter API key. Defaults to `process.env.OPENROUTER_API_KEY`. */
	readonly apiKey?: string | undefined;
	/** OpenRouter model id, such as `"openai/text-embedding-3-small"`. */
	readonly model: string;
	/**
	 * Vector length. Known models default to theirs, and those whose vendor
	 * documents shorter vectors accept those sizes, which are then sent.
	 * Required for other models, where it is not sent.
	 */
	readonly dimensions?: number | undefined;
	/**
	 * Which providers may serve the request, sent as `provider`. Pin one
	 * host with `{ order: ["deepinfra"], allow_fallbacks: false }`. A field
	 * not listed here throws `"CONFIG"`, since OpenRouter would ignore it.
	 */
	readonly routing?: OpenRouterRouting | undefined;
	/** Your app, sent as OpenRouter's attribution headers. */
	readonly app?: OpenRouterApp | undefined;
	/**
	 * How to mark queries and documents: a text `prefix` and/or request
	 * `body` fields such as `{ input_type: "query" }`. Replaces the built-in
	 * hints (`input_type` for Perplexity's v2, Cohere and Voyage models, text
	 * prefixes for `google/gemini-embedding-2`); a purpose left out gets no
	 * hint.
	 */
	readonly purposes?: PurposeHints | undefined;
	/** API base URL. Defaults to `https://openrouter.ai/api/v1`. */
	readonly baseURL?: string | undefined;
	/**
	 * Extra request headers, for proxies and gateways. `authorization`,
	 * `content-type` and, with `app`, `http-referer` and
	 * `x-openrouter-title` are set by the embedder and replace a caller's
	 * copy.
	 */
	readonly headers?: Readonly<Record<string, string>> | undefined;
	/**
	 * The `fetch` every request goes through, for tests and proxies. It is
	 * called with the URL as a string and a `RequestInit` that carries the
	 * call's `signal`. Defaults to the global `fetch`.
	 */
	readonly fetch?: typeof globalThis.fetch | undefined;
	/** Most texts per request. Defaults to `100`. */
	readonly maxBatch?: number | undefined;
}

function configError(message: string, cause?: unknown): MnemocyteError {
	return new MnemocyteError({
		message: `${NAME} ${message}`,
		code: "CONFIG",
		reason: "INVALID_OPTION",
		cause,
	});
}

function resolveRouting(routing: unknown): JsonObject | undefined {
	if (routing === undefined) {
		return undefined;
	}
	if (!isRecord(routing)) {
		throw configError("routing must be an object.");
	}
	// OpenRouter ignores fields it does not know, so a typo such as
	// `allow_fallback` would silently leave fallbacks on.
	assertKnownKeys(`${NAME} routing`, routing, ROUTING_KEYS);
	try {
		// Snapshot the caller's object and prove it can be sent.
		return JSON.parse(JSON.stringify(routing)) as JsonObject;
	} catch (error) {
		throw configError("routing must be JSON.", error);
	}
}

function assertHeaderValue(value: string, field: string): void {
	try {
		new Headers([["x-check", value]]);
	} catch {
		// No cause: the TypeError quotes the value.
		throw configError(`${field} is not a valid HTTP header value.`);
	}
}

function resolveApp(app: unknown): Record<string, string> {
	if (app === undefined) {
		return {};
	}
	if (!isRecord(app)) {
		throw configError("app must be an object.");
	}
	assertKnownKeys(`${NAME} app`, app, ["url", "name"]);
	const { url, name } = app;
	if (typeof url !== "string" || !URL.canParse(url)) {
		throw configError("app.url must be an absolute URL.");
	}
	assertHeaderValue(url, "app.url");
	if (name === undefined) {
		return { "http-referer": url };
	}
	if (typeof name !== "string" || name.trim().length === 0) {
		throw configError("app.name must be a non-empty string.");
	}
	assertHeaderValue(name, "app.name");
	return { "http-referer": url, "x-openrouter-title": name };
}

/**
 * The HTTP status in a success body that holds only OpenRouter's error
 * object. OpenRouter sends the 200 before the provider answers, so a
 * provider that fails after that comes back this way.
 */
function errorStatusOf(body: unknown): number | undefined {
	if (!isRecord(body) || body.data !== undefined || !isRecord(body.error)) {
		return undefined;
	}
	const { code } = body.error;
	return typeof code === "number" &&
		Number.isInteger(code) &&
		code >= 400 &&
		code <= 599
		? code
		: undefined;
}

/**
 * Read OpenRouter's `{ data: [{ embedding, index? }] }`. Its schema makes
 * `index` optional, so a response with no indexes is read in order; one
 * with indexes is checked and sorted like OpenAI's. A body with only an
 * error object throws a `ProviderError` with its code as the status, so
 * the client retries it as it would that HTTP status.
 */
function parseResponse(body: unknown, expectedCount: number): number[][] {
	const status = errorStatusOf(body);
	if (status !== undefined) {
		throw createProviderError({
			provider: "OpenRouter",
			status,
			headers: new Headers(),
			body,
		});
	}
	if (
		isRecord(body) &&
		Array.isArray(body.data) &&
		body.data.every((item) => isRecord(item) && item.index === undefined)
	) {
		return assertVectorList(
			body.data.map((item: Record<string, unknown>) => item.embedding),
			expectedCount,
			"OpenRouter",
		);
	}
	return parseIndexedEmbeddings(body, expectedCount, "OpenRouter");
}

function defaultHints(model: string): Record<EmbeddingPurpose, ResolvedHint> {
	const hint = openrouterPurposeHint(model);
	const resolve = (purpose: EmbeddingPurpose): ResolvedHint => {
		if (hint === undefined) {
			return { prefix: "", body: {} };
		}
		if ("inputType" in hint) {
			return { prefix: "", body: { input_type: hint.inputType[purpose] } };
		}
		return { prefix: hint.prefix[purpose], body: {} };
	};
	return { query: resolve("query"), document: resolve("document") };
}

/**
 * Create an OpenRouter {@link Embedder} that calls `POST /embeddings` with
 * `fetch`; there is no SDK. `model` is OpenRouter's id; the embedder's
 * `model` leaves out the vendor prefix (`text-embedding-3-small`), so an
 * installation can move to and from the vendor's own embedder.
 *
 * Perplexity's v2, Cohere and Voyage models get `input_type`, as their own
 * APIs take it, and `google/gemini-embedding-2` the text prefixes Google
 * documents for it; other models get no query or document hint unless
 * `purposes` sets one.
 *
 * @example
 * ```ts
 * import { openrouterEmbedder } from "mnemocyte/embedders";
 *
 * // Reads OPENROUTER_API_KEY.
 * const embedder = openrouterEmbedder({
 *   model: "openai/text-embedding-3-small",
 * });
 * ```
 */
export function openrouterEmbedder(
	options: OpenRouterEmbedderOptions,
): Embedder {
	assertKnownKeys(
		NAME,
		options,
		[
			"apiKey",
			"model",
			"dimensions",
			"routing",
			"app",
			"purposes",
			"baseURL",
			"headers",
			"fetch",
			"maxBatch",
		],
		RENAMED_BASE_URL,
	);
	const apiKey = resolveApiKey(options.apiKey, "OPENROUTER_API_KEY", NAME);
	const headers = resolveHeaders(options.headers, NAME);
	const customFetch = resolveFetch(options.fetch, NAME);
	const model = resolveModel(options.model, NAME);
	const reported = resolveModel(withoutVendor(model), NAME);
	const size = resolveModelDimensions({
		name: NAME,
		model,
		dimensions: options.dimensions,
		known: OPENROUTER_MODELS,
	});
	const routing = resolveRouting(options.routing);
	const attribution = resolveApp(options.app);
	const hints =
		options.purposes === undefined
			? defaultHints(model)
			: resolvePurposes(options.purposes, NAME);
	const baseURL = resolveBaseURL(
		options.baseURL ?? "https://openrouter.ai/api/v1",
		NAME,
	);
	return createFetchEmbedder({
		name: NAME,
		provider: "OpenRouter",
		model: reported,
		dimensions: size.dimensions,
		maxBatch: resolveMaxBatch(options.maxBatch, NAME, undefined),
		url: `${baseURL}/embeddings`,
		headers: {
			...headers,
			...attribution,
			authorization: `Bearer ${apiKey}`,
		},
		fetch: customFetch,
		buildBody(texts, purpose) {
			const hint = hints[purpose];
			return {
				...hint.body,
				model,
				input:
					hint.prefix.length === 0
						? [...texts]
						: texts.map((text) => `${hint.prefix}${text}`),
				encoding_format: "float",
				...(size.send ? { dimensions: size.dimensions } : {}),
				...(routing === undefined ? {} : { provider: routing }),
			};
		},
		parseResponse,
	});
}
