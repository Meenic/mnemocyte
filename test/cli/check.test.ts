import { describe, expect, test } from "vitest";
import {
	describeInstallation,
	evaluateInstallation,
} from "../../src/cli/check.js";
import type { InstallationReport } from "../../src/db/migrations/inspect.js";

const ALL = [
	"0000_initial",
	"0001_add_mnemocyte_meta",
	"0002_add_embedding_model",
	"0003_schema_v2",
];

const HEALTHY: InstallationReport = {
	pgvectorVersion: "0.8.7",
	migrations: { state: "tracked", applied: ALL, pending: [] },
	column: { dimensions: 1536, vectorType: "vector" },
	meta: {
		dimensions: 1536,
		model: "text-embedding-3-small",
		vectorType: "vector",
	},
};

const APP = { dimensions: 1536, model: "text-embedding-3-small" };

describe("evaluateInstallation", () => {
	test("a current installation that matches the app passes", () => {
		expect(evaluateInstallation(HEALTHY, APP)).toEqual({
			problems: [],
			notes: [],
		});
		// Without a memory file there is nothing to compare with.
		expect(evaluateInstallation(HEALTHY, {})).toEqual({
			problems: [],
			notes: [],
		});
	});

	test("a missing or old pgvector is a problem", () => {
		const missing = evaluateInstallation(
			{ ...HEALTHY, pgvectorVersion: null },
			APP,
		);
		expect(missing.problems).toEqual([
			expect.stringContaining("pgvector is not enabled"),
		]);
		const old = evaluateInstallation(
			{ ...HEALTHY, pgvectorVersion: "0.7.4" },
			APP,
		);
		expect(old.problems).toEqual([
			expect.stringContaining("needs pgvector 0.8.0 or later"),
		]);
	});

	test("missing tables, pending migrations and refused schemas are problems", () => {
		const none = evaluateInstallation(
			{ pgvectorVersion: "0.8.7", migrations: { state: "none" }, column: null },
			APP,
		);
		expect(none.problems).toEqual([
			"Mnemocyte's tables are not installed. Run mnemocyte migrate.",
		]);

		const pending = evaluateInstallation(
			{
				pgvectorVersion: "0.8.7",
				migrations: {
					state: "tracked",
					applied: ALL.slice(0, 3),
					pending: ALL.slice(3),
				},
				column: { dimensions: 1536, vectorType: "vector" },
			},
			APP,
		);
		expect(pending.problems).toEqual([
			"1 migration is pending (0003_schema_v2). Run mnemocyte migrate.",
		]);

		const two = evaluateInstallation(
			{
				pgvectorVersion: "0.8.7",
				migrations: {
					state: "untracked",
					applied: ALL.slice(0, 2),
					pending: ALL.slice(2),
				},
				column: { dimensions: 1536, vectorType: "vector" },
			},
			APP,
		);
		expect(two.problems).toEqual([
			"2 migrations are pending (0002_add_embedding_model, 0003_schema_v2). Run mnemocyte migrate.",
		]);
		expect(two.notes).toHaveLength(1);

		const invalid = evaluateInstallation(
			{
				pgvectorVersion: "0.8.7",
				migrations: { state: "invalid", reason: "matches no migration" },
				column: null,
			},
			APP,
		);
		expect(invalid.problems).toEqual(["matches no migration"]);
	});

	test("a current schema installed without migrate passes with a note", () => {
		const verdict = evaluateInstallation(
			{
				...HEALTHY,
				migrations: { state: "untracked", applied: ALL, pending: [] },
			},
			APP,
		);
		expect(verdict.problems).toEqual([]);
		expect(verdict.notes).toEqual([
			expect.stringContaining("installed without migrate"),
		]);
	});

	test("dimensions that differ from the embedder's are a problem, also before an upgrade", () => {
		expect(
			evaluateInstallation(HEALTHY, { ...APP, dimensions: 768 }).problems,
		).toEqual([
			"The installation stores 1536-dimension embeddings, but the embedder has 768 dimensions. An installation keeps one embedding size.",
		]);
		const behind = evaluateInstallation(
			{
				pgvectorVersion: "0.8.7",
				migrations: {
					state: "tracked",
					applied: ALL.slice(0, 3),
					pending: ALL.slice(3),
				},
				column: { dimensions: 1536, vectorType: "vector" },
			},
			{ dimensions: 768 },
		);
		expect(behind.problems).toHaveLength(2);
	});

	test("a missing or inconsistent installation row is a problem", () => {
		expect(
			evaluateInstallation({ ...HEALTHY, meta: null }, APP).problems,
		).toEqual([expect.stringContaining('no "installation" row')]);
		expect(
			evaluateInstallation(
				{
					...HEALTHY,
					meta: { dimensions: 768, model: null, vectorType: "halfvec" },
					storedModels: [],
				},
				APP,
			).problems,
		).toEqual([
			"mnemocyte_meta records halfvec(768), but the embedding column is vector(1536). Correct the installation row to match the column.",
		]);
	});

	test("the embedding model is compared the way the client does", () => {
		expect(
			evaluateInstallation(HEALTHY, { ...APP, model: "voyage-4" }).problems,
		).toEqual([
			'The installation\'s embedding model is "text-embedding-3-small", but the embedder\'s is "voyage-4". An installation keeps one embedding model.',
		]);

		const unrecorded = {
			...HEALTHY,
			meta: { dimensions: 1536, model: null, vectorType: "vector" },
		};
		// Empty installation: the first add records the embedder's model.
		expect(
			evaluateInstallation({ ...unrecorded, storedModels: [] }, APP),
		).toEqual({
			problems: [],
			notes: [expect.stringContaining("No embedding model is recorded yet")],
		});
		// One stored model: that is what the client records, then compares.
		expect(
			evaluateInstallation(
				{ ...unrecorded, storedModels: ["text-embedding-3-small"] },
				APP,
			),
		).toEqual({ problems: [], notes: [] });
		expect(
			evaluateInstallation({ ...unrecorded, storedModels: ["voyage-4"] }, APP)
				.problems,
		).toEqual([expect.stringContaining('embedding model is "voyage-4"')]);
		expect(
			evaluateInstallation(
				{ ...unrecorded, storedModels: ["voyage-4", "other"] },
				APP,
			).problems,
		).toEqual([expect.stringContaining("the stored memories use several")]);
	});
});

describe("describeInstallation", () => {
	test("prints the four facts", () => {
		expect(describeInstallation(HEALTHY)).toEqual([
			"pgvector    0.8.7",
			"migrations  4 of 4 applied",
			"dimensions  1536 (vector)",
			"model       text-embedding-3-small",
		]);
		expect(
			describeInstallation({
				pgvectorVersion: null,
				migrations: { state: "none" },
				column: null,
			}),
		).toEqual([
			"pgvector    not enabled",
			"migrations  not installed",
			"dimensions  -",
			"model       -",
		]);
		expect(
			describeInstallation({
				pgvectorVersion: "0.8.7",
				migrations: {
					state: "untracked",
					applied: ALL.slice(0, 3),
					pending: ALL.slice(3),
				},
				column: { dimensions: 3072, vectorType: "halfvec" },
			}),
		).toEqual([
			"pgvector    0.8.7",
			"migrations  3 of 4 applied, pending: 0003_schema_v2 (not recorded)",
			"dimensions  3072 (halfvec)",
			"model       -",
		]);
	});
});
