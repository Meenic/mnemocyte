import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createMnemocyte } from "mnemocyte";
import postgres from "postgres";
import { describe, expect, test } from "vitest";
import { expectMnemocyteError } from "../helpers.js";

const envPath = resolve(".env");
if (!process.env.DATABASE_URL && existsSync(envPath)) {
	process.loadEnvFile(envPath);
}

const databaseUrl = process.env.DATABASE_URL;

function createEmbedding(seed: string) {
	const values = Array.from({ length: 1536 }, () => 0);
	for (const char of seed) {
		const index = char.charCodeAt(0) % values.length;
		values[index] = (values[index] ?? 0) + 1;
	}
	return values;
}

async function applyMigrations(sql: ReturnType<typeof postgres>) {
	const migration = await readFile(
		resolve("migrations", "0000_initial.sql"),
		"utf8",
	);
	const metaMigration = await readFile(
		resolve("migrations", "0001_add_mnemocyte_meta.sql"),
		"utf8",
	);

	try {
		await sql.unsafe(migration);
	} catch (error) {
		if (
			!(
				error &&
				typeof error === "object" &&
				"code" in error &&
				error.code === "42P07"
			)
		) {
			throw error;
		}
	}
	try {
		await sql.unsafe(metaMigration);
	} catch (error) {
		if (
			!(
				error &&
				typeof error === "object" &&
				"code" in error &&
				error.code === "42P07"
			)
		) {
			throw error;
		}
		await sql`
			INSERT INTO mnemocyte_meta (key, embedding_dimensions)
			VALUES ('installation', 1536)
			ON CONFLICT (key) DO UPDATE
			SET embedding_dimensions = EXCLUDED.embedding_dimensions
		`;
	}
}

function holdMemoryLock(sql: ReturnType<typeof postgres>, memoryId: string) {
	let releaseLock: (() => void) | undefined;
	let markLocked: (() => void) | undefined;
	let markLockFailed: ((error: unknown) => void) | undefined;
	const released = new Promise<void>((resolveReleased) => {
		releaseLock = resolveReleased;
	});
	const locked = new Promise<void>((resolveLocked, rejectLocked) => {
		markLocked = resolveLocked;
		markLockFailed = rejectLocked;
	});
	const done = sql
		.begin(async (transaction) => {
			await transaction`
				SELECT id
				FROM mnemocyte_memories
				WHERE id = ${memoryId}
				FOR UPDATE
			`;
			markLocked?.();
			await released;
		})
		.catch((error: unknown) => {
			markLockFailed?.(error);
			throw error;
		});

	return {
		locked,
		release() {
			releaseLock?.();
		},
		done,
	};
}

async function waitForBlockedQuery(
	sql: ReturnType<typeof postgres>,
	operation: "delete" | "update",
) {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const rows = await sql<{ blocked: boolean }[]>`
			SELECT EXISTS (
				SELECT 1
				FROM pg_stat_activity
				WHERE pid <> pg_backend_pid()
					AND state = 'active'
					AND wait_event_type = 'Lock'
					AND query ILIKE ${`%${operation}%mnemocyte_memories%`}
			) AS blocked
		`;
		if (rows[0]?.blocked === true) {
			return;
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
	throw new Error(`Timed out waiting for blocked ${operation} query.`);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs = 5_000) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error("Timed out waiting for cancellation.")),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}

async function runCancellationScenario(databaseUrl: string) {
	const admin = postgres(databaseUrl, { max: 1 });
	const locker = postgres(databaseUrl, { max: 1 });
	const observer = postgres(databaseUrl, { max: 1 });
	const entityId = `cancellation_${Date.now()}_${Math.random().toString(36).slice(2)}`;

	await applyMigrations(admin);
	await admin`DELETE FROM mnemocyte_memories WHERE entity_id = ${entityId}`;
	await admin`DELETE FROM mnemocyte_events WHERE entity_id = ${entityId}`;

	const client = createMnemocyte({
		databaseUrl,
		embedder: {
			model: "cancellation-integration-test",
			dimensions: 1536,
			async embed(texts) {
				return texts.map(createEmbedding);
			},
		},
		audit: { enabled: true },
	});

	try {
		const [survivor, loser, pruneTarget] = await client.rememberMany({
			inputs: [
				{ entityId, content: "survivor" },
				{ entityId, content: "loser" },
				{ entityId, content: "prune target", tags: ["prune-target"] },
			],
		});
		if (!survivor || !loser || !pruneTarget) {
			throw new Error("Expected cancellation integration memories.");
		}

		const preAborted = new AbortController();
		preAborted.abort("cancel before Postgres work");
		await expectMnemocyteError(
			client.prune({ entityId, signal: preAborted.signal }),
			"ABORTED",
		);
		await expectMnemocyteError(
			client.findDuplicates({ entityId, signal: preAborted.signal }),
			"ABORTED",
		);
		await expectMnemocyteError(
			client.listAuditLog({ entityId, signal: preAborted.signal }),
			"ABORTED",
		);
		await expectMnemocyteError(
			client.experimental.consolidate({
				entityId,
				survivorId: survivor.id,
				supersededIds: [loser.id],
				signal: preAborted.signal,
			}),
			"ABORTED",
		);
		await expect(client.stats({ entityId })).resolves.toMatchObject({
			memoryCount: 3,
			supersededMemoryCount: 0,
		});

		const pruneLock = holdMemoryLock(locker, pruneTarget.id);
		await pruneLock.locked;
		try {
			const controller = new AbortController();
			const pending = client.prune({
				entityId,
				tags: ["prune-target"],
				signal: controller.signal,
			});
			await waitForBlockedQuery(observer, "delete");
			controller.abort("cancel blocked delete");

			await expectMnemocyteError(withTimeout(pending), "ABORTED");
		} finally {
			pruneLock.release();
			await pruneLock.done;
		}
		await expect(client.stats({ entityId })).resolves.toMatchObject({
			memoryCount: 3,
		});

		const consolidateLock = holdMemoryLock(locker, loser.id);
		await consolidateLock.locked;
		const controller = new AbortController();
		const pending = client.experimental.consolidate({
			entityId,
			survivorId: survivor.id,
			supersededIds: [loser.id],
			signal: controller.signal,
		});
		let settled = false;
		void pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		try {
			await waitForBlockedQuery(observer, "update");
			controller.abort("cancel blocked consolidation");
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
			expect(settled).toBe(false);
		} finally {
			consolidateLock.release();
			await consolidateLock.done;
		}
		await expectMnemocyteError(withTimeout(pending), "ABORTED");
		await expect(client.stats({ entityId })).resolves.toMatchObject({
			memoryCount: 3,
			supersededMemoryCount: 0,
		});
	} finally {
		await client.close();
		await admin`DELETE FROM mnemocyte_memories WHERE entity_id = ${entityId}`;
		await admin`DELETE FROM mnemocyte_events WHERE entity_id = ${entityId}`;
		await Promise.all([admin.end(), locker.end(), observer.end()]);
	}
}

describe("Postgres cancellation", () => {
	test.skipIf(!databaseUrl)(
		"cancels standalone queries and rolls back an aborted consolidation",
		async () => {
			await runCancellationScenario(databaseUrl ?? "");
		},
		60_000,
	);
});
