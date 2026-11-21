import { MnemocyteError } from "../errors.js";
import type { MemoryStore } from "./store.js";
import type { MemoryStoreV1, MemoryStoreV1Capabilities } from "./store-v1.js";

/** The `specificationVersion` values this copy of the package accepts. */
const SUPPORTED_VERSIONS = ["v1"] as const;

/** The data methods every {@link MemoryStoreV1} has. */
const REQUIRED_METHODS = [
	"insert",
	"searchCandidates",
	"get",
	"list",
	"update",
	"markAccessed",
	"delete",
	"consolidate",
	"findDuplicates",
	"listAudit",
	"pruneAudit",
	"stats",
] as const satisfies readonly (keyof MemoryStoreV1)[];

const OPTIONAL_METHODS = [
	"migrate",
	"ensureEmbeddingCompatibility",
] as const satisfies readonly (keyof MemoryStoreV1)[];

/** The values each capability may take; `maxDimensions` is checked apart. */
const CAPABILITY_VALUES = {
	vectorSearch: ["exact", "approximate"],
	filteredVectorSearch: ["prefilter", "postfilter", "iterative"],
	lexicalSearch: ["bm25", "ts_rank", "overlap", "none"],
	locking: ["row", "database"],
} as const satisfies Record<
	Exclude<keyof MemoryStoreV1Capabilities, "maxDimensions">,
	readonly string[]
>;

function invalid(message: string): MnemocyteError {
	return new MnemocyteError({
		message: `defineMemoryStore: ${message}`,
		code: "CONFIG",
		reason: "INVALID_OPTION",
	});
}

function checkCapabilities(value: unknown): MemoryStoreV1Capabilities {
	if (typeof value !== "object" || value === null) {
		throw invalid("store.capabilities must be an object.");
	}
	const record = value as Record<string, unknown>;
	for (const [field, allowed] of Object.entries(CAPABILITY_VALUES)) {
		const given = record[field];
		if (!(allowed as readonly unknown[]).includes(given)) {
			throw invalid(
				`store.capabilities.${field} must be one of ${allowed.map((item) => `"${item}"`).join(", ")}.`,
			);
		}
	}
	const { maxDimensions } = record;
	if (
		typeof maxDimensions !== "number" ||
		!(
			maxDimensions === Number.POSITIVE_INFINITY ||
			(Number.isSafeInteger(maxDimensions) && maxDimensions > 0)
		)
	) {
		throw invalid(
			"store.capabilities.maxDimensions must be a positive integer or Number.POSITIVE_INFINITY.",
		);
	}
	// Validated field by field above.
	const capabilities = record as unknown as MemoryStoreV1Capabilities;
	return Object.freeze({
		vectorSearch: capabilities.vectorSearch,
		filteredVectorSearch: capabilities.filteredVectorSearch,
		lexicalSearch: capabilities.lexicalSearch,
		locking: capabilities.locking,
		maxDimensions: capabilities.maxDimensions,
	});
}

/**
 * Check that `value` is a {@link MemoryStoreV1}: its version, name,
 * capabilities and methods. The method signatures cannot be checked at
 * runtime; the contract suite (`mnemocyte/store/test`) does that.
 *
 * @throws {MnemocyteError} `"CONFIG"` (`"INVALID_OPTION"`) naming the first
 * problem, including a `specificationVersion` this copy does not support.
 */
export function assertMemoryStoreV1(
	value: unknown,
): asserts value is MemoryStoreV1 {
	if (typeof value !== "object" || value === null) {
		throw invalid("store must be an object that implements MemoryStoreV1.");
	}
	const record = value as Record<string, unknown>;
	const version = record.specificationVersion;
	if (!(SUPPORTED_VERSIONS as readonly unknown[]).includes(version)) {
		throw invalid(
			typeof version === "string"
				? `store.specificationVersion is "${version}", which this version of mnemocyte does not support (it supports ${SUPPORTED_VERSIONS.map((item) => `"${item}"`).join(", ")}). Update mnemocyte, or use a release of the store built for this version.`
				: `store.specificationVersion must be "v1".`,
		);
	}
	if (typeof record.name !== "string" || record.name.trim() === "") {
		throw invalid("store.name must be a non-empty string.");
	}
	checkCapabilities(record.capabilities);
	for (const method of REQUIRED_METHODS) {
		if (typeof record[method] !== "function") {
			throw invalid(`store.${method} must be a function.`);
		}
	}
	for (const method of OPTIONAL_METHODS) {
		if (record[method] !== undefined && typeof record[method] !== "function") {
			throw invalid(`store.${method} must be a function when set.`);
		}
	}
}

/**
 * The core's {@link MemoryStore} over a {@link MemoryStoreV1}, the way the AI
 * SDK upgrades an older model specification to the one it runs on. It
 * supplies what V1 leaves out or makes optional, with the answers of a
 * store without schema (the in-memory store's): no installation report, no
 * text search configuration, nothing to migrate, every embedder accepted.
 * Each call goes through `store`, so methods keep their `this`.
 *
 * @throws {MnemocyteError} `"CONFIG"` when `store` is not a valid V1 store.
 */
export function fromMemoryStoreV1(store: unknown): MemoryStore {
	assertMemoryStoreV1(store);
	const capabilities = checkCapabilities(store.capabilities);
	const name = store.name;
	return {
		backend: "custom",
		capabilities,
		custom: Object.freeze({ name, migrates: store.migrate !== undefined }),
		migrate: async (input) =>
			store.migrate === undefined
				? {
						applied: [],
						adopted: [],
						extensionCreated: false,
						schemaCreated: false,
					}
				: store.migrate(input),
		setTextSearchConfig: async () => ({
			previous: null,
			current: null,
			changed: false,
		}),
		inspectInstallation: async () => null,
		ensureEmbeddingCompatibility: async (input) => {
			if (store.ensureEmbeddingCompatibility !== undefined) {
				await store.ensureEmbeddingCompatibility(input);
			}
		},
		insert: (input) => store.insert(input),
		searchCandidates: (input) => store.searchCandidates(input),
		get: (input) => store.get(input),
		list: (input) => store.list(input),
		update: (input) => store.update(input),
		markAccessed: (input) => store.markAccessed(input),
		delete: (input) => store.delete(input),
		consolidate: (input) => store.consolidate(input),
		findDuplicates: (input) => store.findDuplicates(input),
		listAudit: (input) => store.listAudit(input),
		pruneAudit: (input) => store.pruneAudit(input),
		stats: (input) => store.stats(input),
	};
}
