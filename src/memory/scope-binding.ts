import { MnemocyteError } from "../errors.js";
import { observe } from "../observability.js";
import type {
	AddInput,
	AddManyInput,
	BoundMemoryClient,
	ConsolidateInput,
	ContextInput,
	DeleteInput,
	DeleteScopeInput,
	FindDuplicatesInput,
	GetInput,
	ListAuditLogInput,
	ListInput,
	MemoryClient,
	MemoryConfig,
	MemoryScope,
	MnemocyteBackend,
	MnemocyteOperation,
	PruneAuditLogInput,
	PruneInput,
	SearchInput,
	StatsInput,
	UpdateInput,
} from "../types.js";
import type { CoreMemoryClient } from "./client-core.js";
import {
	attachMemoryClientInternals,
	type MemoryClientInternals,
} from "./client-internals.js";
import type { StoreScope } from "./store.js";
import { validateScope } from "./validation.js";

/** What the namespace layer and bound clients need besides the core. */
export interface ScopeBindingContext {
	readonly config: MemoryConfig;
	readonly backend: MnemocyteBackend;
	/** `createMemory({ namespace })`, already validated. */
	readonly namespace: string | undefined;
	readonly internals: MemoryClientInternals;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `scope` with the default namespace when it names none. Anything that is not
 * an object stays as it is, for validation to reject.
 */
function withNamespace(scope: unknown, namespace: string | undefined): unknown {
	if (
		namespace === undefined ||
		!isRecord(scope) ||
		scope.namespace !== undefined
	) {
		return scope;
	}
	return { ...scope, namespace };
}

/**
 * `input` with its scope's namespace filled in. It is copied only when the
 * namespace changes; the core snapshots and validates it as usual, so an
 * input that is still malformed fails there with its usual error and events.
 */
function withScopeNamespace<T>(input: T, namespace: string | undefined): T {
	if (namespace === undefined || !isRecord(input)) {
		return input;
	}
	const scope = withNamespace(input.scope, namespace);
	return scope === input.scope ? input : ({ ...input, scope } as T);
}

/**
 * The client `createMemory` returns: the core methods with the default
 * namespace filled into each call's scope, plus `for()`.
 */
export function createScopedClient(
	core: CoreMemoryClient,
	context: ScopeBindingContext,
): MemoryClient<boolean> {
	const { namespace } = context;
	// Each cast below narrows a scope whose namespace may still be missing to
	// the core's input type; validation rejects a scope that has none.
	const client: MemoryClient<boolean> = {
		add: (input) => core.add(withScopeNamespace(input, namespace) as AddInput),
		addMany: (input) =>
			core.addMany(withScopeNamespace(input, namespace) as AddManyInput),
		search: (input) =>
			core.search(withScopeNamespace(input, namespace) as SearchInput),
		get: (input) => core.get(withScopeNamespace(input, namespace) as GetInput),
		list: (input) =>
			core.list(withScopeNamespace(input, namespace) as ListInput),
		update: (input) =>
			core.update(withScopeNamespace(input, namespace) as UpdateInput),
		delete: (input) =>
			core.delete(withScopeNamespace(input, namespace) as DeleteInput),
		deleteScope: (input) =>
			core.deleteScope(
				withScopeNamespace(input, namespace) as DeleteScopeInput,
			),
		context: (input) =>
			core.context(withScopeNamespace(input, namespace) as ContextInput),
		prune: (input) =>
			core.prune(withScopeNamespace(input, namespace) as PruneInput),
		findDuplicates: (input) =>
			core.findDuplicates(
				withScopeNamespace(input, namespace) as FindDuplicatesInput,
			),
		listAuditLog: (input) =>
			core.listAuditLog(
				withScopeNamespace(input, namespace) as ListAuditLogInput,
			),
		pruneAuditLog: (input) =>
			core.pruneAuditLog(
				withScopeNamespace(input, namespace) as PruneAuditLogInput,
			),
		stats: (input) =>
			core.stats(withScopeNamespace(input, namespace) as StatsInput),
		consolidate: (input) =>
			core.consolidate(
				withScopeNamespace(input, namespace) as ConsolidateInput,
			),
		for: (scope) =>
			bindScope(core, validateScope(withNamespace(scope, namespace)), context),
		experimental: {
			consolidate: (input) => client.consolidate(input),
		},
	};
	return attachMemoryClientInternals(client, context.internals);
}

function bindScope(
	core: CoreMemoryClient,
	validated: StoreScope,
	context: ScopeBindingContext,
): BoundMemoryClient {
	const scope: MemoryScope = Object.freeze({
		namespace: validated.namespace,
		entityId: validated.entityId,
		...(validated.agentId === null ? {} : { agentId: validated.agentId }),
		...(validated.sessionId === null ? {} : { sessionId: validated.sessionId }),
	});
	const metadata = { namespace: scope.namespace, entityId: scope.entityId };

	/**
	 * Run `call` with the caller's input, or reject it through the usual
	 * observation events when it is not an object or tries to name a scope.
	 * An optional input that is omitted is an empty object.
	 */
	function run<Input extends object, Result>(
		operation: MnemocyteOperation,
		input: Input | undefined,
		optional: boolean,
		call: (input: Input) => Promise<Result>,
	): Promise<Result> {
		const value: unknown = input === undefined && optional ? {} : input;
		let message: string | undefined;
		if (!isRecord(value)) {
			message = "input must be an object.";
		} else if (value.scope !== undefined) {
			message =
				"This client is bound to a scope, so its methods take no scope. Call the unbound client to use another scope.";
		} else if (value.allNamespaces !== undefined) {
			message =
				"A bound client cannot take allNamespaces. Call the unbound client for operations across namespaces.";
		}
		if (message !== undefined) {
			const error = new MnemocyteError(message, "VALIDATION");
			return observe(context.config, context.backend, operation, metadata, () =>
				Promise.reject(error),
			);
		}
		return call(value as Input);
	}

	const bound: BoundMemoryClient = {
		scope,
		add: (input) =>
			run("add", input, false, (value) => core.add({ ...value, scope })),
		addMany: (input) =>
			run("addMany", input, false, (value) =>
				core.addMany({ ...value, scope }),
			),
		search: (input) =>
			run("search", input, false, (value) => core.search({ ...value, scope })),
		get: (input) =>
			run("get", input, false, (value) => core.get({ ...value, scope })),
		list: (input) =>
			run("list", input, true, (value) => core.list({ ...value, scope })),
		update: (input) =>
			run("update", input, false, (value) => core.update({ ...value, scope })),
		delete: (input) =>
			run("delete", input, false, (value) => core.delete({ ...value, scope })),
		deleteScope: (input) =>
			run("deleteScope", input, true, (value) =>
				core.deleteScope({ ...value, scope }),
			),
		context: (input) =>
			run("context", input, false, (value) =>
				core.context({ ...value, scope }),
			),
		prune: (input) =>
			run("prune", input, false, (value) => core.prune({ ...value, scope })),
		findDuplicates: (input) =>
			run("findDuplicates", input, true, (value) =>
				core.findDuplicates({ ...value, scope }),
			),
		listAuditLog: (input) =>
			run("listAuditLog", input, true, (value) =>
				core.listAuditLog({ ...value, scope }),
			),
		pruneAuditLog: (input) =>
			run("pruneAuditLog", input, false, (value) =>
				core.pruneAuditLog({ ...value, scope }),
			),
		// Takes no input; one passed from untyped code is still checked.
		stats: (input?: object) =>
			run("stats", input, true, () => core.stats({ scope })),
		consolidate: (input) =>
			run("consolidate", input, false, (value) =>
				core.consolidate({ ...value, scope }),
			),
		experimental: {
			consolidate: (input) => bound.consolidate(input),
		},
	};
	return attachMemoryClientInternals(bound, context.internals);
}
