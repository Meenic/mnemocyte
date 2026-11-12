import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createMemory } from "mnemocyte";
import { postgresJs, postgresStore } from "mnemocyte/postgres";
import postgres from "postgres";
import { describe, expect, test } from "vitest";
import {
	verifyGetAndScopeValidation,
	verifyKeyedAdd,
	verifyKeyedAddAudit,
	verifyListPaging,
	verifyScopeVisibility,
	verifyUpdate,
} from "../fixtures/scoped-api.js";

const envPath = resolve(".env");
if (!process.env.DATABASE_URL && existsSync(envPath)) {
	process.loadEnvFile(envPath);
}

const databaseUrl = process.env.DATABASE_URL;

async function applyMigrations(sql: ReturnType<typeof postgres>) {
	for (const [file, ignoredCode] of [
		["0000_initial.sql", "42P07"],
		["0001_add_mnemocyte_meta.sql", "42P07"],
		["0002_add_embedding_model.sql", "42701"],
		["0003_schema_v2.sql", "42701"],
	] as const) {
		try {
			await sql.unsafe(await readFile(resolve("migrations", file), "utf8"));
		} catch (error) {
			const code =
				error && typeof error === "object" && "code" in error
					? error.code
					: undefined;
			if (code !== ignoredCode) {
				throw error;
			}
		}
	}
}

function createEmbedding(seed: string): number[] {
	const values = Array.from({ length: 1536 }, () => 0);
	for (const char of seed.toLowerCase()) {
		const index = char.charCodeAt(0) % values.length;
		values[index] = (values[index] ?? 0) + 1;
	}
	values[1535] = 1;
	return values;
}

function uniqueNamespace(label: string): string {
	return `scoped_${label}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/** Runs `check` on a fresh client and deletes the namespace afterwards. */
async function withClient(
	label: string,
	check: (
		client: ReturnType<typeof createMemory>,
		namespace: string,
		embedCalls: () => number,
		sql: ReturnType<typeof postgres>,
	) => Promise<void>,
	options: { audit?: boolean } = {},
): Promise<void> {
	const sql = postgres(databaseUrl ?? "", { max: 5, onnotice: () => {} });
	const namespace = uniqueNamespace(label);
	let embedCalls = 0;
	await applyMigrations(sql);
	const client = createMemory({
		store: postgresStore({ client: postgresJs(sql) }),
		embedder: {
			model: "mnemocyte-integration-test",
			dimensions: 1536,
			async embed(texts) {
				embedCalls += 1;
				return texts.map(createEmbedding);
			},
		},
		...(options.audit ? { audit: { enabled: true } } : {}),
	});
	try {
		await check(client, namespace, () => embedCalls, sql);
	} finally {
		await sql`DELETE FROM mnemocyte_memories WHERE namespace LIKE ${`${namespace}%`}`;
		await sql`DELETE FROM mnemocyte_events WHERE namespace LIKE ${`${namespace}%`}`;
		await sql.end();
	}
}

describe("scoped API (Postgres)", () => {
	test.skipIf(!databaseUrl)(
		"reads see the scope plus shared memories; bulk operations select",
		() => withClient("visibility", verifyScopeVisibility),
		60_000,
	);

	test.skipIf(!databaseUrl)(
		"add with a key upserts through ON CONFLICT on the partial index",
		() => withClient("keys", verifyKeyedAdd),
		60_000,
	);

	test.skipIf(!databaseUrl)(
		"keyed adds are audited as created, then updated",
		() => withClient("audit", verifyKeyedAddAudit, { audit: true }),
		60_000,
	);

	test.skipIf(!databaseUrl)(
		"list pages newest first with an opaque cursor",
		() => withClient("paging", verifyListPaging),
		60_000,
	);

	test.skipIf(!databaseUrl)(
		"list pages rows whose created_at has microseconds",
		() =>
			withClient("micro", async (client, namespace, _calls, sql) => {
				const scope = { namespace, entityId: "micro" };
				const added = await client.addMany({
					scope,
					memories: [{ content: "a" }, { content: "b" }, { content: "c" }],
				});
				// Rows written by the column default carry microseconds; give the
				// three rows distinct sub-millisecond times within one millisecond.
				for (const [index, memory] of added.entries()) {
					await sql`
						UPDATE mnemocyte_memories
						SET created_at = '2026-01-01 00:00:00.123'::timestamptz
							+ make_interval(secs => ${(index + 1) * 0.0001})
						WHERE id = ${memory.id}::uuid
					`;
				}
				const seen: string[] = [];
				let cursor: string | undefined;
				do {
					const page = await client.list({
						scope,
						limit: 1,
						...(cursor === undefined ? {} : { cursor }),
					});
					seen.push(...page.memories.map((memory) => memory.id));
					cursor = page.nextCursor ?? undefined;
				} while (cursor !== undefined);
				expect(seen.sort()).toEqual(added.map((memory) => memory.id).sort());
			}),
		60_000,
	);

	test.skipIf(!databaseUrl)(
		"update changes fields and re-embeds only new content",
		() => withClient("update", verifyUpdate),
		60_000,
	);

	test.skipIf(!databaseUrl)(
		"get reads by id or key, and every method validates its scope",
		() => withClient("get", verifyGetAndScopeValidation),
		60_000,
	);

	test.skipIf(!databaseUrl)(
		"deleteScope removes the scope's audit events in the same statement",
		() =>
			withClient(
				"erase",
				async (client, namespace, _calls, sql) => {
					const scope = { namespace, entityId: "erase" };
					await client.add({ scope, content: "one" });
					await client.add({
						scope: { ...scope, agentId: "a" },
						content: "two",
					});
					const [before] = await sql<{ count: number }[]>`
						SELECT count(*)::int AS count FROM mnemocyte_events
						WHERE namespace = ${namespace}
					`;
					expect(before?.count).toBe(2);
					await expect(client.deleteScope({ scope })).resolves.toEqual({
						deletedCount: 2,
					});
					const [after] = await sql<{ count: number }[]>`
						SELECT count(*)::int AS count FROM mnemocyte_events
						WHERE namespace = ${namespace}
					`;
					expect(after?.count).toBe(0);
				},
				{ audit: true },
			),
		60_000,
	);
});
