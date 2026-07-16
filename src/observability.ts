import type {
	MnemocyteBackend,
	MnemocyteConfig,
	MnemocyteObservation,
	MnemocyteOperation,
} from "./types.js";

interface ObservationMetadata {
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
		...(metadata.entityId === undefined ? {} : { entityId: metadata.entityId }),
		...(metadata.memoryId === undefined ? {} : { memoryId: metadata.memoryId }),
		...(metadata.count === undefined ? {} : { count: metadata.count }),
	};
}

async function emitObservation(
	config: MnemocyteConfig,
	event: MnemocyteObservation,
): Promise<void> {
	try {
		await config.observability?.onEvent?.(event);
	} catch {
		return;
	}
}

async function observeFromStartedAt<T>(
	config: MnemocyteConfig,
	backend: MnemocyteBackend,
	operation: MnemocyteOperation,
	metadata: ObservationMetadata,
	startedAt: number,
	action: () => Promise<T>,
	successMetadata?: (result: T) => ObservationMetadata,
): Promise<T> {
	await emitObservation(
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
		await emitObservation(
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
		await emitObservation(
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
	config: MnemocyteConfig,
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
	config: MnemocyteConfig,
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
