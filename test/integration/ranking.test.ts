import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	createMnemocyte,
	type MnemocyteClient,
	type RetrievalConfig,
} from "mnemocyte";
import { postgresJs, postgresStore } from "mnemocyte/postgres";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { expectDefined } from "../helpers.js";

const envPath = resolve(".env");
if (!process.env.DATABASE_URL && existsSync(envPath)) {
	process.loadEnvFile(envPath);
}

const databaseUrl = process.env.DATABASE_URL;
const DIMENSIONS = 1536;

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

/** A vector with the given components set and the rest zero. */
function vector(components: Record<number, number>): number[] {
	const values = Array.from({ length: DIMENSIONS }, () => 0);
	for (const [index, value] of Object.entries(components)) {
		values[Number(index)] = value;
	}
	return values;
}

// Each test text maps to a fixed direction, so the vector ranks are known
// and only the lexical list and the boosts decide the order under test.
const EMBEDDINGS = new Map<string, number[]>([
	["deploy", vector({ 0: 1, 1: 1 })],
	["We deploy on Fridays.", vector({ 0: 1 })],
	["Read the redeployment notes.", vector({ 0: 1 })],
	["invoice reminder", vector({ 2: 1 })],
	["Send the invoice reminder on Monday.", vector({ 2: 0.8, 3: 0.6 })],
	["Billing notices go out weekly.", vector({ 2: 1 })],
	["Invoice reminder template lives in the wiki.", vector({ 4: 1 })],
	["kennel", vector({ 5: 1 })],
	["Alpha notes.", vector({ 5: 1 })],
	["Beta notes.", vector({ 5: 1, 8: 1 })],
	["Quarterly kennel ledger.", vector({ 6: 1 })],
	["standup", vector({ 7: 1 })],
	["Team standup is at nine.", vector({ 7: 1 })],
]);

async function embed(texts: readonly string[]) {
	return texts.map((text) =>
		expectDefined(EMBEDDINGS.get(text), `No test embedding for "${text}".`),
	);
}

describe("Postgres hybrid ranking", () => {
	let sql: ReturnType<typeof postgres>;
	const entityIds: string[] = [];

	beforeAll(async () => {
		if (!databaseUrl) {
			return;
		}
		sql = postgres(databaseUrl, { max: 2 });
		await applyMigrations(sql);
	});

	afterAll(async () => {
		if (!databaseUrl) {
			return;
		}
		for (const entityId of entityIds) {
			await sql`DELETE FROM mnemocyte_memories WHERE entity_id = ${entityId}`;
		}
		await sql.end();
	});

	async function withClient(
		retrieval: RetrievalConfig | undefined,
		run: (client: MnemocyteClient, entityId: string) => Promise<void>,
	) {
		const entityId = `ranking_${Date.now()}_${Math.random().toString(36).slice(2)}`;
		entityIds.push(entityId);
		const client = createMnemocyte({
			store: postgresStore({ client: postgresJs(sql) }),
			embedder: {
				model: "mnemocyte-integration-test",
				dimensions: DIMENSIONS,
				embed,
			},
			...(retrieval ? { retrieval } : {}),
		});
		try {
			await run(client, entityId);
		} finally {
			await client.close();
		}
	}

	test.skipIf(!databaseUrl)(
		"ranks a full-text match above a substring coincidence",
		async () => {
			await withClient(undefined, async (client, entityId) => {
				await client.rememberMany({
					inputs: [
						{ entityId, content: "Read the redeployment notes." },
						{ entityId, content: "We deploy on Fridays." },
					],
				});
				const results = await client.recall({ entityId, query: "deploy" });

				expect(results.map((memory) => memory.content)).toEqual([
					"We deploy on Fridays.",
					"Read the redeployment notes.",
				]);
				const [match, coincidence] = results.map((memory) => memory.scores);
				expect(match?.vectorRank).toBe(coincidence?.vectorRank);
				expect(match?.lexicalRank).toBe(1);
				expect(coincidence?.lexicalRank).toBeNull();
				expect(coincidence?.lexical).toBeNull();
			});
		},
		60_000,
	);

	test.skipIf(!databaseUrl)(
		"ranks a memory found by both searches above single-list hits",
		async () => {
			await withClient(undefined, async (client, entityId) => {
				await client.rememberMany({
					inputs: [
						{ entityId, content: "Billing notices go out weekly." },
						{
							entityId,
							content: "Invoice reminder template lives in the wiki.",
						},
						{ entityId, content: "Send the invoice reminder on Monday." },
					],
				});
				const results = await client.recall({
					entityId,
					query: "invoice reminder",
					limit: 1,
				});

				const top = expectDefined(results[0]);
				expect(top.content).toBe("Send the invoice reminder on Monday.");
				expect(top.scores.vectorRank).toBe(2);
				expect(top.scores.lexicalRank).not.toBeNull();
			});
		},
		60_000,
	);

	test.skipIf(!databaseUrl)(
		"fuses lexical-only candidates without loading their embeddings",
		async () => {
			await withClient({ candidateMultiplier: 1 }, async (client, entityId) => {
				await client.rememberMany({
					inputs: [
						{ entityId, content: "Alpha notes." },
						{ entityId, content: "Beta notes." },
						{ entityId, content: "Quarterly kennel ledger." },
					],
				});
				const results = await client.recall({
					entityId,
					query: "kennel",
					limit: 2,
					explain: true,
				});

				const ledger = expectDefined(
					results.find(
						(memory) => memory.content === "Quarterly kennel ledger.",
					),
				);
				expect(ledger.scores.vectorRank).toBeNull();
				expect(ledger.scores.vector).toBeNull();
				expect(ledger.scores.lexicalRank).toBe(1);
				// ts_rank: positive, and far below 1 for a one-word match.
				expect(ledger.scores.lexical).toBeGreaterThan(0);
				expect(ledger.scores.lexical).toBeLessThan(1);
				expect(ledger.scores.fused).toBe(0.5);
				for (const memory of results) {
					expect(memory.score).toBeGreaterThan(0);
					expect(memory.score).toBeLessThanOrEqual(1);
					expect(memory.explanation?.finalScore).toBe(memory.score);
				}
			});
		},
		60_000,
	);

	test.skipIf(!databaseUrl)(
		"boosts higher importance and newer memories among equal matches",
		async () => {
			await withClient(undefined, async (client, entityId) => {
				const [low, critical, older, newer] = await client.rememberMany({
					inputs: [
						{
							entityId,
							content: "Team standup is at nine.",
							importance: "low",
						},
						{
							entityId,
							content: "Team standup is at nine.",
							importance: "critical",
						},
						{ entityId, content: "Team standup is at nine." },
						{ entityId, content: "Team standup is at nine." },
					],
				});
				await sql`
					UPDATE mnemocyte_memories
					SET created_at = now() - interval '365 days'
					WHERE entity_id = ${entityId} AND id = ${expectDefined(older).id}::uuid
				`;
				const results = await client.recall({ entityId, query: "standup" });
				const scoreOf = (id: string | undefined) =>
					expectDefined(results.find((memory) => memory.id === id)).score;

				expect(results.every((memory) => memory.scores.fused === 1)).toBe(true);
				expect(results[0]?.id).toBe(critical?.id);
				expect(scoreOf(critical?.id)).toBeGreaterThan(scoreOf(low?.id));
				expect(scoreOf(newer?.id)).toBeGreaterThan(scoreOf(older?.id));
			});
		},
		60_000,
	);
});
