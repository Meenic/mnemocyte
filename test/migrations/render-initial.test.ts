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
			`INSERT INTO "mnemocyte_meta" ("key", "embedding_dimensions") VALUES ('installation', 768);`,
		);
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
