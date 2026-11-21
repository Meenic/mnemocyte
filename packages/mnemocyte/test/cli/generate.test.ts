import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	DRIZZLE_SCHEMA_HEADER,
	readDrizzleSchemaShape,
	renderDrizzleSchema,
	renderDrizzleSetupSql,
} from "../../src/cli/drizzle.js";
import {
	drizzleNextSteps,
	drizzleUpdateSteps,
} from "../../src/cli/generate.js";
import { main } from "../../src/cli/main.js";
import { contentTsvExpression } from "../../src/db/text-search.js";
import { createTestIo } from "./io.js";

let cwd: string;

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "mnemocyte-cli-generate-"));
});

afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

describe("renderDrizzleSchema", () => {
	test("starts with the header and records how it was made", () => {
		const source = renderDrizzleSchema({ dimensions: 1536, version: "1.2.3" });
		expect(source.startsWith(`${DRIZZLE_SCHEMA_HEADER}\n`)).toBe(true);
		expect(source).toContain(
			'// mnemocyte 1.2.3, 1536 dimensions, text search configuration\n// "english", tables in search_path (usually public).',
		);
		expect(source).toContain('from "drizzle-orm/pg-core";');
		expect(source).toContain(
			'embedding: vector("embedding", { dimensions: 1536 }),',
		);
		expect(source).toContain('table.embedding.op("vector_cosine_ops")');
		expect(source).toContain("export const mnemocyteEvents = pgTable(");
		expect(source).toContain("export const mnemocyteMeta = pgTable(");
		expect(source).toContain("export const mnemocyteMemories = pgTable(");
		expect(source).not.toContain("pgSchema");
		expect(source).not.toContain("halfvec,");
		// drizzle-orm cannot write it; the custom migration does.
		expect(source).not.toContain('index("mnemocyte_memories_scope_key_idx")');
	});

	test("uses halfvec above 2,000 dimensions", () => {
		const source = renderDrizzleSchema({ dimensions: 3072, version: "1" });
		expect(source).toContain(
			'embedding: halfvec("embedding", { dimensions: 3072 }),',
		);
		expect(source).toContain('table.embedding.op("halfvec_cosine_ops")');
		expect(source).toContain("\thalfvec,\n");
		expect(source).not.toContain("\tvector,\n");
	});

	test("puts the tables in a pgSchema with a schema name", () => {
		const source = renderDrizzleSchema({
			dimensions: 3,
			schema: "memory",
			version: "1",
		});
		expect(source).toContain(
			'export const mnemocyteSchema = pgSchema("memory");',
		);
		expect(source).toContain(
			"export const mnemocyteMemories = mnemocyteSchema.table(",
		);
		expect(source).not.toContain("pgTable");
		expect(source).toContain("tables in memory.");
	});

	test("writes any configuration name so the sql tag reads it back as given", () => {
		// A backtick, a template placeholder and a backslash.
		const name = ["we'ird`", "$", "{x}\\"].join("");
		const source = renderDrizzleSchema({
			dimensions: 3,
			textSearchConfig: name,
			version: "1",
		});
		const tag =
			/tsvector\("content_tsv"\)\.generatedAlwaysAs\(\n\t+(sql`(?:[^`\\]|\\.)*`)/.exec(
				source,
			)?.[1];
		expect(tag).toBeDefined();
		// Evaluate the tagged template with a tag that joins the cooked
		// strings, as drizzle-orm's sql does when there are no parameters.
		const cooked = new Function("sql", `return ${tag};`)(
			(strings: TemplateStringsArray) => strings.join(""),
		) as string;
		expect(cooked).toBe(contentTsvExpression(name));
		// The header comment stays on its lines.
		expect(source).toContain(`// ${JSON.stringify(name)}, tables in`);
	});
});

describe("readDrizzleSchemaShape", () => {
	// A backslash, a backtick and `$` + `{` are what templateText escapes.
	const names = [
		"english",
		"simple",
		"it's",
		"a\\b`c$" + "{d}",
		'"Mixed Case"',
	];
	test.each(names)(
		"reads back the configuration it wrote: %s",
		(textSearchConfig) => {
			const source = renderDrizzleSchema({
				dimensions: 3,
				textSearchConfig,
				schema: "memory",
				version: "1",
			});
			expect(readDrizzleSchemaShape(source)).toEqual({
				dimensions: 3,
				schema: "memory",
				textSearchConfig,
			});
		},
	);

	test("has no configuration when the content_tsv line was edited", () => {
		const source = renderDrizzleSchema({ dimensions: 3, version: "1" })
			.replace("to_tsvector(", "to_tsvector(unaccent(")
			.replace('"content")`', '"content"))`');
		expect(readDrizzleSchemaShape(source)).toEqual({
			dimensions: 3,
			schema: null,
			textSearchConfig: null,
		});
	});
});

describe("renderDrizzleSetupSql", () => {
	test("is pgvector, then the key index and the installation row", () => {
		expect(renderDrizzleSetupSql({ dimensions: 1536 })).toEqual({
			before: "CREATE EXTENSION IF NOT EXISTS vector;\n",
			after: `CREATE UNIQUE INDEX "mnemocyte_memories_scope_key_idx" ON "mnemocyte_memories" USING btree ("namespace","entity_id","agent_id","session_id","key") NULLS NOT DISTINCT WHERE "key" IS NOT NULL;
--> statement-breakpoint
INSERT INTO "mnemocyte_meta" ("key", "embedding_dimensions", "vector_type") VALUES ('installation', 1536, 'vector');
`,
		});
	});

	test("qualifies the names with a schema and records halfvec", () => {
		const { after } = renderDrizzleSetupSql({
			dimensions: 3072,
			schema: "memory",
		});
		expect(after).toContain('ON "memory"."mnemocyte_memories" USING btree');
		expect(after).toContain(
			`INSERT INTO "memory"."mnemocyte_meta" ("key", "embedding_dimensions", "vector_type") VALUES ('installation', 3072, 'halfvec');`,
		);
	});
});

describe("generate --adapter drizzle", () => {
	const file = () => join(cwd, "mnemocyte-schema.ts");

	test("writes the file and prints the drizzle-kit steps", async () => {
		const io = createTestIo(cwd);
		expect(
			await main(
				["generate", "--adapter", "drizzle", "--dimensions", "1536"],
				io,
				"1.2.3",
			),
		).toBe(0);
		expect(await readFile(file(), "utf8")).toBe(
			renderDrizzleSchema({ dimensions: 1536, version: "1.2.3" }),
		);
		expect(io.stdout()).toBe(
			`Wrote mnemocyte-schema.ts (1536 dimensions, text search configuration english).\n\n${drizzleNextSteps({ file: "./mnemocyte-schema.ts", dimensions: 1536, run: "npx" })}`,
		);
		expect(io.stdout()).toContain(
			'1. Add "./mnemocyte-schema.ts" to schema in drizzle.config.ts.',
		);
		expect(io.stderr()).toBe("");
	});

	test("replaces its own file and says when nothing changed", async () => {
		const args = ["generate", "--adapter", "drizzle", "--dimensions", "3"];
		await main(args, createTestIo(cwd), "1.2.3");

		const again = createTestIo(cwd);
		expect(await main(args, again, "1.2.3")).toBe(0);
		expect(again.stdout()).toBe(
			"mnemocyte-schema.ts is up to date (3 dimensions, text search configuration english).\n",
		);

		const changed = createTestIo(cwd);
		expect(
			await main([...args, "--text-search-config", "simple"], changed, "1.2.3"),
		).toBe(0);
		expect(changed.stdout()).toBe(
			`Updated mnemocyte-schema.ts (3 dimensions, text search configuration simple).\n\n${drizzleUpdateSteps({ textSearchChanged: true, run: "npx" })}`,
		);
		expect(changed.stdout()).toContain(
			'CREATE INDEX "mnemocyte_memories_content_tsv_idx" ON "mnemocyte_memories" USING gin ("content_tsv");',
		);

		const upgraded = createTestIo(cwd);
		expect(
			await main(
				[...args, "--text-search-config", "simple"],
				upgraded,
				"1.2.4",
			),
		).toBe(0);
		expect(upgraded.stdout()).toBe(
			"Updated mnemocyte-schema.ts (3 dimensions, text search configuration simple).\n\nNext: npx drizzle-kit generate, read the new migration, then\nnpx drizzle-kit migrate.\n",
		);
		expect(await readFile(file(), "utf8")).toBe(
			renderDrizzleSchema({
				dimensions: 3,
				textSearchConfig: "simple",
				version: "1.2.4",
			}),
		);
	});

	test("keeps the text search configuration when run again without the flag", async () => {
		const args = ["generate", "--adapter", "drizzle", "--dimensions", "3"];
		await main(
			[...args, "--text-search-config", "simple"],
			createTestIo(cwd),
			"1.2.3",
		);
		const before = await readFile(file(), "utf8");

		const again = createTestIo(cwd);
		expect(await main(args, again, "1.2.3")).toBe(0);
		expect(again.stdout()).toBe(
			"mnemocyte-schema.ts is up to date (3 dimensions, text search configuration simple).\n",
		);
		expect(await readFile(file(), "utf8")).toBe(before);

		// A new release changes the header only: no index steps.
		const upgraded = createTestIo(cwd);
		expect(await main(args, upgraded, "1.2.4")).toBe(0);
		expect(upgraded.stdout()).toBe(
			"Updated mnemocyte-schema.ts (3 dimensions, text search configuration simple).\n\nNext: npx drizzle-kit generate, read the new migration, then\nnpx drizzle-kit migrate.\n",
		);
		expect(await readFile(file(), "utf8")).toBe(
			renderDrizzleSchema({
				dimensions: 3,
				textSearchConfig: "simple",
				version: "1.2.4",
			}),
		);

		// The flag still changes it.
		const back = createTestIo(cwd);
		expect(
			await main([...args, "--text-search-config", "english"], back, "1.2.4"),
		).toBe(0);
		expect(back.stdout()).toContain(
			"text search configuration english).\n\n" +
				drizzleUpdateSteps({ textSearchChanged: true, run: "npx" }),
		);
	});

	describe("when content_tsv was edited by hand", () => {
		const args = ["generate", "--adapter", "drizzle", "--dimensions", "3"];
		let edited: string;

		beforeEach(async () => {
			await main(
				[...args, "--text-search-config", "simple"],
				createTestIo(cwd),
				"1",
			);
			edited = (await readFile(file(), "utf8")).replace(
				'"content")`',
				"\"content\") || ''`",
			);
			await writeFile(file(), edited);
		});

		test("exits 2 without the flag and keeps the file", async () => {
			const io = createTestIo(cwd);
			expect(await main(args, io, "1")).toBe(2);
			expect(io.stderr()).toContain("content_tsv column is not the one");
			expect(await readFile(file(), "utf8")).toBe(edited);
		});

		test("the flag replaces it", async () => {
			expect(
				await main(
					[...args, "--text-search-config", "simple"],
					createTestIo(cwd),
					"1",
				),
			).toBe(0);
			expect(await readFile(file(), "utf8")).toBe(
				renderDrizzleSchema({
					dimensions: 3,
					textSearchConfig: "simple",
					version: "1",
				}),
			);
		});

		test("--dry-run shows english and says why, writing nothing", async () => {
			const io = createTestIo(cwd);
			expect(await main([...args, "--dry-run"], io, "1")).toBe(0);
			expect(io.stdout()).toBe(
				renderDrizzleSchema({ dimensions: 3, version: "1" }),
			);
			expect(io.stderr()).toContain(
				"Could not read the text search configuration from mnemocyte-schema.ts, so this shows english.",
			);
			expect(await readFile(file(), "utf8")).toBe(edited);
		});
	});

	test("--dry-run uses the configuration of the existing file", async () => {
		const args = ["generate", "--adapter", "drizzle", "--dimensions", "3"];
		await main(
			[...args, "--text-search-config", "simple"],
			createTestIo(cwd),
			"1",
		);
		const io = createTestIo(cwd);
		expect(await main([...args, "--dry-run"], io, "1")).toBe(0);
		expect(io.stdout()).toBe(
			renderDrizzleSchema({
				dimensions: 3,
				textSearchConfig: "simple",
				version: "1",
			}),
		);
		expect(io.stderr()).not.toContain("Could not read");
	});

	test.each([
		[
			["--dimensions", "4"],
			"mnemocyte-schema.ts is for 3 dimensions, not 4. An installation keeps its embedding size",
		],
		[
			["--dimensions", "3", "--schema", "memory"],
			"mnemocyte-schema.ts puts the tables in search_path, not schema memory",
		],
	])("will not change the size or the schema: %j", async (flags, message) => {
		const args = ["generate", "--adapter", "drizzle"];
		await main([...args, "--dimensions", "3"], createTestIo(cwd), "1");
		const before = await readFile(file(), "utf8");
		const io = createTestIo(cwd);
		expect(await main([...args, ...flags], io, "1")).toBe(2);
		expect(io.stderr()).toContain(message);
		expect(await readFile(file(), "utf8")).toBe(before);
	});

	test("keeps its own file when the embedding line was edited", async () => {
		const args = ["generate", "--adapter", "drizzle", "--dimensions", "3"];
		await main(args, createTestIo(cwd), "1");
		const edited = (await readFile(file(), "utf8")).replace(
			'vector("embedding", { dimensions: 3 })',
			'vector("embedding", { dimensions: 3 }).notNull()',
		);
		await writeFile(file(), edited);
		const io = createTestIo(cwd);
		expect(await main(args, io, "1")).toBe(2);
		expect(io.stderr()).toContain("was changed by hand");
		expect(await readFile(file(), "utf8")).toBe(edited);
	});

	test("keeps a file it did not write and exits 2", async () => {
		await writeFile(file(), "export const mine = 1;\n");
		const io = createTestIo(cwd);
		expect(
			await main(
				["generate", "--adapter", "drizzle", "--dimensions", "3"],
				io,
				"1",
			),
		).toBe(2);
		expect(io.stderr()).toContain(
			"mnemocyte-schema.ts exists and was not written by mnemocyte generate, so it was left as is.",
		);
		expect(await readFile(file(), "utf8")).toBe("export const mine = 1;\n");
	});

	test("--dry-run prints the file and writes nothing", async () => {
		const io = createTestIo(cwd);
		expect(
			await main(
				[
					"generate",
					"--adapter",
					"drizzle",
					"--dimensions",
					"3",
					"--schema",
					"memory",
					"--dry-run",
				],
				io,
				"1",
			),
		).toBe(0);
		expect(io.stdout()).toBe(
			renderDrizzleSchema({ dimensions: 3, schema: "memory", version: "1" }),
		);
		expect(io.stderr()).toContain('INSERT INTO "memory"."mnemocyte_meta"');
		await expect(readFile(file(), "utf8")).rejects.toThrow();
	});

	test("prints the project's own runner", async () => {
		await writeFile(
			join(cwd, "package.json"),
			JSON.stringify({ devEngines: { packageManager: { name: "pnpm" } } }),
		);
		const io = createTestIo(cwd);
		expect(
			await main(
				["generate", "--adapter", "drizzle", "--dimensions", "3"],
				io,
				"1",
			),
		).toBe(0);
		expect(io.stdout()).toContain("  3. pnpm exec drizzle-kit generate\n");
		expect(io.stdout()).toContain("then pnpm exec mnemocyte check\n");
	});

	test("--out creates its folder and names the file in drizzle.config.ts form", async () => {
		const io = createTestIo(cwd);
		expect(
			await main(
				[
					"generate",
					"--adapter",
					"drizzle",
					"--dimensions",
					"3",
					"--out",
					"src/db/mnemocyte.ts",
				],
				io,
				"1",
			),
		).toBe(0);
		expect(io.stdout()).toContain(
			'1. Add "./src/db/mnemocyte.ts" to schema in drizzle.config.ts.',
		);
		expect(
			(
				await readFile(join(cwd, "src", "db", "mnemocyte.ts"), "utf8")
			).startsWith(DRIZZLE_SCHEMA_HEADER),
		).toBe(true);
	});

	test("without a size or a memory file exits 2", async () => {
		const io = createTestIo(cwd);
		expect(await main(["generate", "--adapter", "drizzle"], io, "1")).toBe(2);
		expect(io.stderr()).toContain(
			"generate needs the embedding size: pass --dimensions <n>",
		);
	});
});
