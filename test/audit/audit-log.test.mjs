import assert from "node:assert/strict";
import { createMnemocyte, isMnemocyteError } from "../../dist/index.mjs";

function createClient(auditEnabled) {
	return createMnemocyte({
		embedder: {
			model: "audit-test",
			dimensions: 2,
			async embed(texts) {
				return texts.map((text) => [text.length % 7, 1]);
			},
		},
		audit: { enabled: auditEnabled },
	});
}

// 1. Empty entityId rejected with VALIDATION.
{
	const client = createClient(true);
	try {
		await assert.rejects(
			() => client.listAuditLog({ entityId: "" }),
			(error) => {
				assert.equal(isMnemocyteError(error), true);
				assert.equal(error.code, "VALIDATION");
				return true;
			},
		);
	} finally {
		await client.close();
	}
}

// 2. With audit.enabled=false (default behaviour), no events are recorded.
{
	const client = createClient(false);
	try {
		const mem = await client.remember({
			entityId: "alice",
			content: "hello",
		});
		await client.forget({ entityId: "alice", memoryId: mem.id });
		const log = await client.listAuditLog({ entityId: "alice" });
		assert.equal(log.length, 0);
	} finally {
		await client.close();
	}
}

// 3. With audit enabled, remember + forget produce two ordered events.
{
	const client = createClient(true);
	try {
		const mem = await client.remember({
			entityId: "alice",
			content: "hello",
			type: "preference",
			importance: "high",
		});
		await client.forget({ entityId: "alice", memoryId: mem.id });
		const log = await client.listAuditLog({ entityId: "alice" });
		assert.equal(log.length, 2);
		// newest first
		assert.equal(log[0].description, "memory.deleted");
		assert.equal(log[0].entityId, "alice");
		assert.equal(log[0].metadata.memoryId, mem.id);
		assert.equal(log[1].description, "memory.created");
		assert.equal(log[1].metadata.memoryId, mem.id);
		assert.equal(log[1].metadata.type, "preference");
		assert.equal(log[1].metadata.importance, "high");
		for (const event of log) {
			assert.ok(event.id.startsWith("evt_"));
			assert.ok(event.timestamp instanceof Date);
		}
	} finally {
		await client.close();
	}
}

// 4. forgetAll preserves prior audit events and adds an entity.cleared entry.
{
	const client = createClient(true);
	try {
		await client.remember({ entityId: "alice", content: "one" });
		await client.remember({ entityId: "alice", content: "two" });
		const beforeClear = await client.listAuditLog({ entityId: "alice" });
		assert.equal(beforeClear.length, 2);
		await client.forgetAll({ entityId: "alice" });
		const afterClear = await client.listAuditLog({ entityId: "alice" });
		assert.equal(afterClear.length, 3);
		assert.equal(afterClear[0].description, "entity.cleared");
		assert.equal(afterClear[0].metadata.count, 2);
		// Original memory.created events still readable.
		const created = afterClear.filter(
			(event) => event.description === "memory.created",
		);
		assert.equal(created.length, 2);
	} finally {
		await client.close();
	}
}

// 5. prune writes memory.pruned only for real (non-dry) runs.
{
	const client = createClient(true);
	try {
		await client.remember({ entityId: "alice", content: "one" });
		await client.remember({ entityId: "alice", content: "two" });
		await client.prune({ entityId: "alice", dryRun: true });
		const afterDry = await client.listAuditLog({ entityId: "alice" });
		assert.equal(
			afterDry.filter((event) => event.description === "memory.pruned").length,
			0,
		);
		await client.prune({ entityId: "alice" });
		const afterReal = await client.listAuditLog({ entityId: "alice" });
		const pruned = afterReal.filter(
			(event) => event.description === "memory.pruned",
		);
		assert.equal(pruned.length, 1);
		assert.equal(pruned[0].metadata.count, 2);
	} finally {
		await client.close();
	}
}

// 6. Audit log is entity-scoped.
{
	const client = createClient(true);
	try {
		await client.remember({ entityId: "alice", content: "a" });
		await client.remember({ entityId: "bob", content: "b" });
		const alice = await client.listAuditLog({ entityId: "alice" });
		const bob = await client.listAuditLog({ entityId: "bob" });
		assert.equal(alice.length, 1);
		assert.equal(bob.length, 1);
		assert.equal(alice[0].entityId, "alice");
		assert.equal(bob[0].entityId, "bob");
	} finally {
		await client.close();
	}
}

// 7. before / after time filters work.
{
	const client = createClient(true);
	try {
		await client.remember({ entityId: "alice", content: "first" });
		// Pad the cutoff so the first event is strictly before it and the
		// second event is strictly after it on any clock resolution.
		await new Promise((resolve) => setTimeout(resolve, 10));
		const cutoff = new Date();
		await new Promise((resolve) => setTimeout(resolve, 10));
		await client.remember({ entityId: "alice", content: "second" });
		const afterOnly = await client.listAuditLog({
			entityId: "alice",
			after: cutoff,
		});
		const beforeOnly = await client.listAuditLog({
			entityId: "alice",
			before: cutoff,
		});
		assert.equal(afterOnly.length, 1);
		assert.equal(afterOnly[0].metadata.memoryId !== undefined, true);
		assert.equal(beforeOnly.length, 1);
	} finally {
		await client.close();
	}
}

// 8. limit caps the number of returned entries (newest first).
{
	const client = createClient(true);
	try {
		for (let i = 0; i < 5; i += 1) {
			await client.remember({ entityId: "alice", content: `m${i}` });
		}
		const log = await client.listAuditLog({ entityId: "alice", limit: 2 });
		assert.equal(log.length, 2);
		assert.equal(log[0].metadata.memoryId !== log[1].metadata.memoryId, true);
	} finally {
		await client.close();
	}
}

// 9. Emits a listAuditLog observability event with the entry count.
{
	const events = [];
	const client = createMnemocyte({
		embedder: {
			model: "audit-observability",
			dimensions: 2,
			async embed(texts) {
				return texts.map((text) => [text.length, 1]);
			},
		},
		audit: { enabled: true },
		observability: {
			onEvent(event) {
				events.push(event);
			},
		},
	});
	try {
		await client.remember({ entityId: "alice", content: "x" });
		const log = await client.listAuditLog({ entityId: "alice" });
		assert.equal(log.length, 1);
		const success = events.find(
			(event) =>
				event.operation === "listAuditLog" && event.phase === "success",
		);
		assert.equal(success?.entityId, "alice");
		assert.equal(success?.count, 1);
	} finally {
		await client.close();
	}
}

console.log("Audit log tests passed.");
