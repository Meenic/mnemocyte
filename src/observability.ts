import type {
	MemoryConfig,
	MnemocyteBackend,
	MnemocyteObservation,
	MnemocyteOperation,
} from "./types.js";

export interface ObservationMetadata {
	namespace?: string;
	entityId?: string;
	memoryId?: string;
	count?: number;
}

function withMetadata(
	event: MnemocyteObservation,
	metadata: ObservationMetadata,
): MnemocyteObservation {
	return {
		...event,
		...(metadata.namespace === undefined
			? {}
			: { namespace: metadata.namespace }),
		...(metadata.entityId === undefined ? {} : { entityId: metadata.entityId }),
		...(metadata.memoryId === undefined ? {} : { memoryId: metadata.memoryId }),
		...(metadata.count === undefined ? {} : { count: metadata.count }),
	};
}

function reportHookError(
	config: MemoryConfig,
	error: unknown,
	event: MnemocyteObservation,
): void {
	try {
		const reported = config.observability?.onError?.({ error, event });
		// A misbehaving error hook must not fail anything either.
		(reported as unknown as PromiseLike<unknown> | undefined)?.then?.(
			undefined,
			() => undefined,
		);
	} catch {
		// Telemetry never affects the call.
	}
}

/**
 * Calls `onEvent` without waiting for it. The call is synchronous, so events
 * of one operation are delivered in order; a returned promise is never
 * awaited and a throw or rejection goes to `onError`, never to the caller.
 */
function emitObservation(
	config: MemoryConfig,
	event: MnemocyteObservation,
): void {
	try {
		const result: unknown = config.observability?.onEvent?.(event);
		if (
			result !== null &&
			typeof result === "object" &&
			typeof (result as PromiseLike<unknown>).then === "function"
		) {
			(result as PromiseLike<unknown>).then(undefined, (error: unknown) => {
				reportHookError(config, error, event);
			});
		}
	} catch (error) {
		reportHookError(config, error, event);
	}
}

async function observeFromStartedAt<T>(
	config: MemoryConfig,
	backend: MnemocyteBackend,
	operation: MnemocyteOperation,
	metadata: ObservationMetadata,
	startedAt: number,
	action: () => Promise<T>,
	successMetadata?: (result: T) => ObservationMetadata,
): Promise<T> {
	emitObservation(
		config,
		withMetadata(
			{
				operation,
				phase: "start",
				backend,
				timestamp: new Date(startedAt),
			},
			metadata,
		),
	);
	try {
		const result = await action();
		emitObservation(
			config,
			withMetadata(
				{
					operation,
					phase: "success",
					backend,
					timestamp: new Date(),
					durationMs: Date.now() - startedAt,
				},
				{ ...metadata, ...successMetadata?.(result) },
			),
		);
		return result;
	} catch (error) {
		emitObservation(
			config,
			withMetadata(
				{
					operation,
					phase: "error",
					backend,
					timestamp: new Date(),
					durationMs: Date.now() - startedAt,
					error,
				},
				metadata,
			),
		);
		throw error;
	}
}

export function observe<T>(
	config: MemoryConfig,
	backend: MnemocyteBackend,
	operation: MnemocyteOperation,
	metadata: ObservationMetadata,
	action: () => Promise<T>,
	successMetadata?: (result: T) => ObservationMetadata,
): Promise<T> {
	return observeFromStartedAt(
		config,
		backend,
		operation,
		metadata,
		Date.now(),
		action,
		successMetadata,
	);
}

export function observePrepared<Prepared, Result>(
	config: MemoryConfig,
	backend: MnemocyteBackend,
	operation: MnemocyteOperation,
	metadata: ObservationMetadata,
	prepare: () => Prepared,
	action: (prepared: Prepared) => Promise<Result>,
	successMetadata?: (result: Result) => ObservationMetadata,
): Promise<Result> {
	const startedAt = Date.now();
	try {
		const prepared = prepare();
		return observeFromStartedAt(
			config,
			backend,
			operation,
			metadata,
			startedAt,
			() => action(prepared),
			successMetadata,
		);
	} catch (error) {
		return observeFromStartedAt(
			config,
			backend,
			operation,
			metadata,
			startedAt,
			async () => {
				throw error;
			},
		);
	}
}
