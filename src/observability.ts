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

export async function observe<T>(
	config: MnemocyteConfig,
	backend: MnemocyteBackend,
	operation: MnemocyteOperation,
	metadata: ObservationMetadata,
	action: () => Promise<T>,
	successMetadata?: (result: T) => ObservationMetadata,
): Promise<T> {
	const startedAt = Date.now();
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
