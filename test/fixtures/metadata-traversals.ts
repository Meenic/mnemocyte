import type {
	AuditEvent,
	JsonObject,
	Memory,
	MnemocyteClient,
} from "mnemocyte";
import { expect, vi } from "vitest";

const PROBE_KEY = "__mnemocyteMetadataTraversalProbe";

interface TraversalCounts {
	audit: number;
	probes: Map<string, number>;
}

async function countTraversals(
	action: () => Promise<void>,
): Promise<TraversalCounts> {
	const counts: TraversalCounts = {
		audit: 0,
		probes: new Map(),
	};
	const original = Object.getOwnPropertyDescriptors;
	const spy = vi
		.spyOn(Object, "getOwnPropertyDescriptors")
		.mockImplementation((value) => {
			if (
				value !== null &&
				typeof value === "object" &&
				!Array.isArray(value)
			) {
				const candidate = value as Record<string, unknown>;
				const probe = candidate[PROBE_KEY];
				if (typeof probe === "string") {
					counts.probes.set(probe, (counts.probes.get(probe) ?? 0) + 1);
				} else if (
					typeof candidate.memoryId === "string" &&
					typeof candidate.type === "string" &&
					typeof candidate.importance === "string"
				) {
					counts.audit += 1;
				}
			}
			return original(value);
		});

	try {
		await action();
	} finally {
		spy.mockRestore();
	}
	return counts;
}

function metadata(probe: string): JsonObject {
	return {
		[PROBE_KEY]: probe,
		nested: { value: probe },
	};
}

export async function verifyMetadataTraversalCounts(
	client: MnemocyteClient,
	entityPrefix: string,
): Promise<void> {
	const singleEntity = `${entityPrefix}_single`;
	let singleMemory: Memory | undefined;
	let singleLog: AuditEvent[] | undefined;
	const single = await countTraversals(async () => {
		singleMemory = await client.remember({
			entityId: singleEntity,
			content: "single traversal",
			metadata: metadata("single"),
		});
		singleLog = await client.listAuditLog({ entityId: singleEntity });
	});
	expect(single.probes.get("single")).toBe(2);
	expect(single.audit).toBe(2);
	if (!singleMemory || !singleLog) {
		throw new Error("Expected single traversal results.");
	}
	expect(singleMemory.metadata).toEqual(metadata("single"));
	expect(singleLog).toHaveLength(1);
	expect(singleLog[0]?.description).toBe("memory.created");

	singleMemory.metadata[PROBE_KEY] = "mutated-public-memory";
	if (singleLog[0]) {
		singleLog[0].metadata.memoryId = "mutated-public-event";
	}
	const recalled = await client.recall({
		entityId: singleEntity,
		query: "single traversal",
	});
	expect(recalled[0]?.metadata[PROBE_KEY]).toBe("single");
	const rereadLog = await client.listAuditLog({ entityId: singleEntity });
	expect(rereadLog[0]?.metadata.memoryId).toBe(singleMemory.id);

	const batchEntity = `${entityPrefix}_batch`;
	let batchMemories: Memory[] | undefined;
	let batchLog: AuditEvent[] | undefined;
	const batch = await countTraversals(async () => {
		batchMemories = await client.rememberMany({
			inputs: [
				{
					entityId: batchEntity,
					content: "batch traversal one",
					metadata: metadata("batch-one"),
				},
				{
					entityId: batchEntity,
					content: "batch traversal two",
					metadata: metadata("batch-two"),
				},
			],
		});
		batchLog = await client.listAuditLog({ entityId: batchEntity });
	});
	expect(batch.probes.get("batch-one")).toBe(2);
	expect(batch.probes.get("batch-two")).toBe(2);
	expect(batch.audit).toBe(4);
	expect(batchMemories?.map((memory) => memory.metadata[PROBE_KEY])).toEqual([
		"batch-one",
		"batch-two",
	]);
	expect(batchLog).toHaveLength(2);
}
