import type { InstallationReport } from "../db/migrations/inspect.js";
import { MnemocyteError } from "../errors.js";
import type { DirectConnection } from "../sql/detect.js";
import type {
	MemoryRecordScope,
	MigrateResult,
	MnemocyteBackend,
	TextSearchConfigResult,
} from "../types.js";
import type {
	MemoryStoreV1,
	MemoryStoreV1AuditLogEntry,
	MemoryStoreV1AuditLogInput,
	MemoryStoreV1AuditPosition,
	MemoryStoreV1AuditPruneInput,
	MemoryStoreV1CallOptions,
	MemoryStoreV1Capabilities,
	MemoryStoreV1ConsolidateInput,
	MemoryStoreV1ConsolidateResult,
	MemoryStoreV1DeletedMemory,
	MemoryStoreV1DeleteFilterInput,
	MemoryStoreV1DeleteInput,
	MemoryStoreV1DeleteMemoryInput,
	MemoryStoreV1DeleteResult,
	MemoryStoreV1DeleteScopeInput,
	MemoryStoreV1DuplicateFilter,
	MemoryStoreV1DuplicateInput,
	MemoryStoreV1DuplicatePage,
	MemoryStoreV1DuplicatePageInput,
	MemoryStoreV1DuplicatePair,
	MemoryStoreV1DuplicateResult,
	MemoryStoreV1DuplicateTop,
	MemoryStoreV1DuplicateTopInput,
	MemoryStoreV1EmbedderInput,
	MemoryStoreV1EntitySelector,
	MemoryStoreV1Filter,
	MemoryStoreV1GetByIdsInput,
	MemoryStoreV1GetByKeyInput,
	MemoryStoreV1GetInput,
	MemoryStoreV1InsertInput,
	MemoryStoreV1LexicalCandidate,
	MemoryStoreV1LexicalQuery,
	MemoryStoreV1ListInput,
	MemoryStoreV1ListPosition,
	MemoryStoreV1MarkAccessedInput,
	MemoryStoreV1MigrateInput,
	MemoryStoreV1Patch,
	MemoryStoreV1PruneFilter,
	MemoryStoreV1SearchCandidates,
	MemoryStoreV1SearchInput,
	MemoryStoreV1Selector,
	MemoryStoreV1StatsInput,
	MemoryStoreV1UpdateInput,
	MemoryStoreV1VectorCandidate,
	MemoryStoreV1VectorQuery,
	MemoryStoreV1Visibility,
} from "./store-v1.js";

/**
 * The internal names of the {@link MemoryStoreV1} types (store-v1.ts), which
 * hold the declarations and their docs.
 */
export type StoreScope = MemoryRecordScope;
export type StoreVisibility = MemoryStoreV1Visibility;
export type StoreSelector = MemoryStoreV1Selector;
export type StoreEntitySelector = MemoryStoreV1EntitySelector;
export type StoreCapabilities = MemoryStoreV1Capabilities;
export type StoreOperationOptions = MemoryStoreV1CallOptions;
export type StoreMemoryFilter = MemoryStoreV1Filter;
export type StoreVectorQuery = MemoryStoreV1VectorQuery;
export type StoreLexicalQuery = MemoryStoreV1LexicalQuery;
export type StoreSearchInput = MemoryStoreV1SearchInput;
export type StoreVectorCandidate = MemoryStoreV1VectorCandidate;
export type StoreLexicalCandidate = MemoryStoreV1LexicalCandidate;
export type StoreSearchCandidates = MemoryStoreV1SearchCandidates;
export type StoreGetByIdsInput = MemoryStoreV1GetByIdsInput;
export type StoreGetByKeyInput = MemoryStoreV1GetByKeyInput;
export type StoreGetInput = MemoryStoreV1GetInput;
export type StoreListPosition = MemoryStoreV1ListPosition;
export type StoreListInput = MemoryStoreV1ListInput;
export type StoreInsertInput = MemoryStoreV1InsertInput;
export type StoreMemoryPatch = MemoryStoreV1Patch;
export type StoreUpdateInput = MemoryStoreV1UpdateInput;
export type StoreMarkAccessedInput = MemoryStoreV1MarkAccessedInput;
export type StoreDeleteMemoryInput = MemoryStoreV1DeleteMemoryInput;
export type StoreDeleteScopeInput = MemoryStoreV1DeleteScopeInput;
export type StoreDeleteFilterInput = MemoryStoreV1DeleteFilterInput;
export type StoreDeleteInput = MemoryStoreV1DeleteInput;
export type StoreDeletedMemory = MemoryStoreV1DeletedMemory;
export type StoreDeleteResult = MemoryStoreV1DeleteResult;
export type StoreDuplicateFilter = MemoryStoreV1DuplicateFilter;
export type StoreDuplicateTopInput = MemoryStoreV1DuplicateTopInput;
export type StoreDuplicatePageInput = MemoryStoreV1DuplicatePageInput;
export type StoreDuplicateInput = MemoryStoreV1DuplicateInput;
export type StoreDuplicatePair = MemoryStoreV1DuplicatePair;
export type StoreDuplicateTop = MemoryStoreV1DuplicateTop;
export type StoreDuplicatePage = MemoryStoreV1DuplicatePage;
export type StoreDuplicateResult = MemoryStoreV1DuplicateResult;
export type StoreAuditPosition = MemoryStoreV1AuditPosition;
export type StoreAuditLogInput = MemoryStoreV1AuditLogInput;
export type StoreAuditLogEntry = MemoryStoreV1AuditLogEntry;
export type StoreAuditPruneInput = MemoryStoreV1AuditPruneInput;
export type StoreConsolidateInput = MemoryStoreV1ConsolidateInput;
export type StoreConsolidateResult = MemoryStoreV1ConsolidateResult;
export type StoreStatsInput = MemoryStoreV1StatsInput;
export type StoreMigrateInput = MemoryStoreV1MigrateInput;
export type StoreEmbedderInput = MemoryStoreV1EmbedderInput;
export type ValidatedPruneFilter = MemoryStoreV1PruneFilter;

/** First-party only: not part of {@link MemoryStoreV1}. */
export interface StoreTextSearchConfigInput {
	readonly textSearchConfig: string;
	readonly dryRun?: boolean;
	readonly signal?: AbortSignal;
}

/** Whether the filter has a selector besides its scope. */
export function hasPruneSelector(filter: ValidatedPruneFilter): boolean {
	return (
		filter.expired === true ||
		filter.superseded === true ||
		filter.createdBefore !== undefined ||
		filter.notAccessedSince !== undefined ||
		(filter.kinds !== undefined && filter.kinds.length > 0) ||
		(filter.tags !== undefined && filter.tags.length > 0) ||
		filter.maxImportance !== undefined
	);
}

export function assertPruneFilterHasSelector(
	filter: ValidatedPruneFilter,
): void {
	if (!hasPruneSelector(filter)) {
		throw new MnemocyteError({
			message:
				"prune requires at least one selector besides its scope (expired, superseded, createdBefore, notAccessedSince, kinds, tags, or maxImportance). Use deleteScope to delete a whole scope.",
			code: "VALIDATION",
		});
	}
}

/**
 * The core's storage boundary: {@link MemoryStoreV1} plus what only the
 * first-party backends have. Not exported; a third-party store comes in
 * through `defineMemoryStore` and `fromMemoryStoreV1` (store-v1-adapter.ts),
 * which supplies the members V1 leaves out or makes optional.
 */
export interface MemoryStore
	extends Omit<
		MemoryStoreV1,
		"specificationVersion" | "name" | "migrate" | "ensureEmbeddingCompatibility"
	> {
	readonly backend: MnemocyteBackend;
	/**
	 * The Postgres schema of the tables when the store was given one
	 * (`schemaName`); left out when they resolve through `search_path`. The
	 * CLI reads it from the memory file's store. A store from an older copy
	 * of the package has none.
	 */
	readonly schemaName?: string;
	/**
	 * Set on a store from `defineMemoryStore`: its `name`, and whether it has
	 * a `migrate` of its own. The CLI reads it for its messages.
	 */
	readonly custom?: { readonly name: string; readonly migrates: boolean };
	/**
	 * Set on a Postgres store whose client has no interactive transactions
	 * (Neon's HTTP driver, a `batch`-only `SqlExecutor`), so `migrate` and
	 * `setTextSearchConfig` cannot run on it: the connection the CLI opens
	 * for them instead. Known before a lazy store loads. A store from an
	 * older copy of the package has none.
	 */
	readonly directConnection?: DirectConnection;

	/**
	 * Applies the store's pending schema migrations. This is the only method
	 * that changes schema, and it runs only when the caller asks for it through
	 * `migrate()`. A store without persistent schema resolves with nothing
	 * applied.
	 */
	migrate(input: StoreMigrateInput): Promise<MigrateResult>;
	/**
	 * Changes the text search configuration of keyword search, through
	 * `setTextSearchConfig()`. On Postgres this rewrites the memories table.
	 * A store without one resolves with `null` names and `changed: false`.
	 */
	setTextSearchConfig(
		input: StoreTextSearchConfigInput,
	): Promise<TextSearchConfigResult>;
	/**
	 * What is installed, read without changing anything: the report behind
	 * the CLI's `check`. A store without persistent schema resolves with
	 * `null`.
	 */
	inspectInstallation(
		input?: StoreOperationOptions,
	): Promise<InstallationReport | null>;
	/**
	 * Rejects with `"MIGRATION"` or `"CONFIG"` when the embedder does not match
	 * the installation. A store without persistent installation state resolves
	 * without work.
	 */
	ensureEmbeddingCompatibility(input: StoreEmbedderInput): Promise<void>;
}
