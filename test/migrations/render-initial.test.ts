import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

describe("initial migration renderer", () => {
	test("renders the selected embedding dimension to stdout", async () => {
		const { stdout } = await execFileAsync("node", [
			"migrations/render-initial.mjs",
			"--dimensions",
			"768",
		]);

		expect(stdout).toContain('"embedding" vector(768)');
		expect(stdout).toContain('"embedding_model" text');
		expect(stdout).toContain(
			`INSERT INTO "mnemocyte_meta" ("key", "embedding_dimensions", "vector_type") VALUES ('installation', 768, 'vector');`,
		);
		expect(stdout).toContain('("embedding" vector_cosine_ops)');
		expect(stdout).not.toContain("{{");
	});

	test("switches to halfvec above 2,000 dimensions", async () => {
		const { stdout } = await execFileAsync("node", [
			"migrations/render-initial.mjs",
			"--dimensions",
			"3072",
		]);

		expect(stdout).toContain('"embedding" halfvec(3072)');
		expect(stdout).toContain('("embedding" halfvec_cosine_ops)');
		expect(stdout).toContain("VALUES ('installation', 3072, 'halfvec');");
	});

	test("keeps vector at exactly 2,000 dimensions", async () => {
		const { stdout } = await execFileAsync("node", [
			"migrations/render-initial.mjs",
			"--dimensions",
			"2000",
		]);

		expect(stdout).toContain('"embedding" vector(2000)');
	});

	test("rejects dimensions an HNSW index cannot hold", async () => {
		await expect(
			execFileAsync("node", [
				"migrations/render-initial.mjs",
				"--dimensions",
				"4001",
			]),
		).rejects.toThrow();
	});

	test("keeps the checked-in default fresh install byte-for-byte aligned", async () => {
		const temporaryDirectory = await mkdtemp(
			join(tmpdir(), "mnemocyte-fresh-install-"),
		);
		const renderedPath = join(temporaryDirectory, "fresh-install.sql");

		try {
			await execFileAsync("node", [
				"migrations/render-initial.mjs",
				"--dimensions",
				"1536",
				"--out",
				renderedPath,
			]);

			const [rendered, checkedIn] = await Promise.all([
				readFile(renderedPath),
				readFile("migrations/fresh-install.sql"),
			]);
			expect(checkedIn).toEqual(rendered);
		} finally {
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
	});

	test("rejects non-positive dimensions", async () => {
		await expect(
			execFileAsync("node", [
				"migrations/render-initial.mjs",
				"--dimensions",
				"0",
			]),
		).rejects.toThrow();
	});

	test("bundles the schema v2 migration", async () => {
		const migration = await readFile("migrations/0003_schema_v2.sql", "utf8");

		expect(migration).toContain(
			'ADD COLUMN "content_tsv" tsvector GENERATED ALWAYS AS',
		);
		expect(migration).toContain("STORED;");
		expect(migration).toContain('RENAME COLUMN "type" TO "kind"');
		expect(migration).toContain('md5("id")::uuid');
		expect(migration).toContain("NULLS NOT DISTINCT");
	});

	test("bundles the installation-model repair migration", async () => {
		const migration = await readFile(
			"migrations/0002_add_embedding_model.sql",
			"utf8",
		);

		expect(migration).toContain(
			'ALTER TABLE "mnemocyte_meta" ADD COLUMN "embedding_model" text;',
		);
		expect(migration).toContain('count(DISTINCT "embedding_model") = 1');
	});
});
