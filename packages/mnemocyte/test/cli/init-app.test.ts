import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	clientCandidates,
	clientImport,
	driverLabel,
	findDrizzleClients,
	importSpecifier,
	nextMemoryFolder,
	readDrizzleSource,
	stripComments,
	topLevelStatements,
} from "../../src/cli/init-app.js";

describe("readDrizzleSource", () => {
	// The shapes from Drizzle's connection guides and app templates.
	test.each([
		[
			"Drizzle's Next.js + Neon tutorial (src/db/drizzle.ts)",
			`import { config } from "dotenv";
import { drizzle } from 'drizzle-orm/neon-http';

config({ path: ".env" }); // or .env.local

export const db = drizzle(process.env.DATABASE_URL!);
`,
			[{ name: "db", driver: "neon-http" }],
		],
		[
			"neon() passed as the client",
			`import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

const sql = neon(process.env.DATABASE_URL!);
export const db = drizzle({ client: sql });
`,
			[{ name: "db", driver: "neon-http" }],
		],
		[
			"create-t3-app, cached on globalThis",
			`import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "~/env";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as {
  conn: postgres.Sql | undefined;
};

const conn = globalForDb.conn ?? postgres(env.DATABASE_URL);
if (env.NODE_ENV !== "production") globalForDb.conn = conn;

export const db = drizzle(conn, { schema });
`,
			[{ name: "db", driver: "postgres-js" }],
		],
		[
			"a Pool, no semicolons, a type annotation",
			`import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import { Pool } from "pg"

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
export const database: NodePgDatabase = drizzle({
  client: pool,
})
`,
			[{ name: "database", driver: "node-postgres" }],
		],
		[
			"connection options over several lines",
			`import { drizzle } from "drizzle-orm/neon-serverless";
export const db =
  drizzle({ connection: process.env.DATABASE_URL });
`,
			[{ name: "db", driver: "neon-serverless" }],
		],
		[
			"a renamed import and export { … as … }",
			`import { drizzle as createDb } from "drizzle-orm/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
const client = createDb({ connection: { dataDir: "./data", extensions: { vector } } });
export { client as db };
`,
			[{ name: "db", driver: "pglite" }],
		],
		[
			"a default export",
			`import { drizzle } from "drizzle-orm/libsql/web";
export default drizzle({ connection: { url: process.env.TURSO_DATABASE_URL! } });
`,
			[{ name: "default", driver: "libsql/web" }],
		],
		[
			"a declaration exported as default later",
			`import { drizzle } from "drizzle-orm/postgres-js";
const db = drizzle(process.env.DATABASE_URL!);
export default db;
`,
			[{ name: "default", driver: "postgres-js" }],
		],
		[
			"one local exported by name and as default, which is one client",
			`import { drizzle } from "drizzle-orm/postgres-js";
const db = drizzle(process.env.DATABASE_URL!);
export default db;
export { db };
`,
			[{ name: "db", driver: "postgres-js" }],
		],
		[
			"a client cached on globalThis, and a logger callback after the call",
			`import { drizzle } from "drizzle-orm/node-postgres";
export const db =
  globalThis.db ??
  drizzle(process.env.DATABASE_URL!, { logger: { logQuery: (query) => console.log(query) } });
`,
			[{ name: "db", driver: "node-postgres" }],
		],
		[
			"two clients in one file",
			`import { drizzle } from "drizzle-orm/node-postgres";
export const db = drizzle(process.env.DATABASE_URL!);
export const replica = drizzle(process.env.REPLICA_URL!);
`,
			[
				{ name: "db", driver: "node-postgres" },
				{ name: "replica", driver: "node-postgres" },
			],
		],
		[
			"an unsupported driver is still reported",
			`import { drizzle } from "drizzle-orm/mysql2";
export const db = drizzle(process.env.DATABASE_URL!);
`,
			[{ name: "db", driver: "mysql2" }],
		],
	])("%s", (_name, text, exports) => {
		expect(readDrizzleSource(text).exports).toEqual(exports);
	});

	test.each([
		[
			"Drizzle's get-started file, which does not export db",
			`import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
const db = drizzle(process.env.DATABASE_URL!);
`,
			true,
		],
		[
			"a function that returns a client",
			`import { drizzle } from "drizzle-orm/postgres-js";
export const getDb = () => drizzle(process.env.DATABASE_URL!);
export const makeDb = async (url: string) => drizzle(url);
export function createDb() { return drizzle(process.env.DATABASE_URL!); }
export const cachedDb = cache(() => drizzle(process.env.DATABASE_URL!));
export default function () {
  return drizzle(process.env.DATABASE_URL!);
}
`,
			false,
		],
		[
			"a commented-out export",
			`import { drizzle } from "drizzle-orm/postgres-js";
// export const db = drizzle(process.env.DATABASE_URL!);
/* export const other = drizzle(process.env.DATABASE_URL!); */
`,
			false,
		],
		[
			"drizzle imported from elsewhere",
			`import { drizzle } from "./my-wrapper";
export const db = drizzle(process.env.DATABASE_URL!);
`,
			false,
		],
		[
			"a method named drizzle",
			`import { drizzle } from "drizzle-orm/postgres-js";
export const db = factory.drizzle(process.env.DATABASE_URL!);
`,
			false,
		],
		[
			"a re-export from another file",
			`export { db } from "./drizzle";
export * from "./schema";
`,
			false,
		],
	])("finds no client in %s", (_name, text, unexported) => {
		const source = readDrizzleSource(text);
		expect(source.exports).toEqual([]);
		expect(source.unexported).toBe(unexported);
	});

	test("lists the process.env variables the file reads, and pgvector", () => {
		const source =
			readDrizzleSource(`import { drizzle } from "drizzle-orm/neon-http";
const url = process.env.DATABASE_URL ?? process.env["NEON_URL"];
export const db = drizzle(url!, { logger: process.env.DATABASE_URL === "x" });
`);
		expect(source.variables).toEqual(["DATABASE_URL", "NEON_URL"]);
		expect(source.pgvector).toBe(false);
		expect(
			readDrizzleSource(
				'import { vector } from "@electric-sql/pglite-pgvector";',
			).pgvector,
		).toBe(true);
	});
});

describe("text helpers", () => {
	test("stripComments keeps strings, template literals and line breaks", () => {
		expect(
			stripComments(
				'const a = "https://x.dev"; // gone\nconst b = `/* kept */`; /* gone\n */ const c = 1;',
			),
		).toBe(
			'const a = "https://x.dev"; \nconst b = `/* kept */`;        \n    const c = 1;',
		);
	});

	test("topLevelStatements splits on ; and on new lines at column 0", () => {
		expect(
			topLevelStatements(
				"import a from 'a'\nconst b = f(\n  1,\n)\n  .then(g)\nexport { b }; export default b",
			),
		).toEqual([
			"import a from 'a'",
			"const b = f(\n  1,\n)\n  .then(g)",
			"export { b }",
			"export default b",
		]);
	});
});

test.each([
	["postgres-js", "Drizzle on postgres.js"],
	["node-postgres", "Drizzle on node-postgres"],
	["pglite", "Drizzle on PGlite"],
	["neon-http", "Drizzle on Neon's HTTP driver"],
	["neon-serverless", "Drizzle on Neon's Pool"],
	["libsql", "Drizzle on libSQL"],
	["libsql/web", "Drizzle on libSQL"],
	["libsql/node", "Drizzle on libSQL"],
	["libsql/nope", undefined],
	["mysql2", undefined],
	["vercel-postgres", undefined],
	["postgres-js/migrator", undefined],
])("driverLabel(%j) is %j", (driver, label) => {
	expect(driverLabel(driver)).toBe(label);
});

describe("in a project", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), "mnemocyte-cli-init-app-"));
	});

	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
	});

	async function files(entries: Record<string, string>): Promise<void> {
		for (const [name, content] of Object.entries(entries)) {
			await mkdir(dirname(join(cwd, name)), { recursive: true });
			await writeFile(join(cwd, name), content);
		}
	}

	test("reads the client folders whole and only db and drizzle files elsewhere", async () => {
		await files({
			"src/db/index.ts": "",
			"src/db/schema.ts": "",
			"src/db/types.d.ts": "",
			"src/db/index.test.ts": "",
			"src/db/notes.md": "",
			"src/db/nested/client.ts": "",
			"src/server/db/index.ts": "",
			"src/lib/db.ts": "",
			"src/lib/utils.ts": "",
			"src/drizzle.ts": "",
			"src/index.ts": "",
			"lib/drizzle.mjs": "",
			"db.ts": "",
			"drizzle.ts": "",
			"drizzle.config.ts": "",
		});
		const names = (await clientCandidates(cwd)).map((file) =>
			file.slice(cwd.length + 1).replaceAll("\\", "/"),
		);
		expect(names).toEqual([
			"src/db/index.ts",
			"src/db/schema.ts",
			"src/server/db/index.ts",
			"src/drizzle.ts",
			"src/lib/db.ts",
			"lib/drizzle.mjs",
			"db.ts",
		]);
	});

	test("finds the exported clients and the files that keep theirs", async () => {
		await files({
			"src/db/drizzle.ts":
				'import { drizzle } from "drizzle-orm/neon-http";\nexport const db = drizzle(process.env.DATABASE_URL!);\n',
			"src/db/schema.ts":
				'import { pgTable, text } from "drizzle-orm/pg-core";\nexport const notes = pgTable("notes", { id: text() });\n',
			"src/lib/db.ts":
				'import { drizzle } from "drizzle-orm/postgres-js";\nconst db = drizzle(process.env.DATABASE_URL!);\n',
		});
		const search = await findDrizzleClients(cwd);
		expect(search.clients).toEqual([
			{
				name: "db",
				driver: "neon-http",
				file: join(cwd, "src/db/drizzle.ts"),
				label: "Drizzle on Neon's HTTP driver",
				variables: ["DATABASE_URL"],
				pgvector: false,
			},
		]);
		expect(search.unexported).toEqual([join(cwd, "src/lib/db.ts")]);
	});

	test.each([
		[["app/page.tsx"], "lib"],
		[["pages/index.tsx"], "lib"],
		[["app/page.tsx", "src/app/page.tsx"], "lib"],
		[["src/app/page.tsx"], "src/lib"],
		[["src/pages/index.tsx"], "src/lib"],
		[["src/other.ts"], "src/lib"],
		[[], "lib"],
	])(
		"a Next.js app with %j keeps the memory file in %s",
		async (paths, folder) => {
			await files(Object.fromEntries(paths.map((path) => [path, ""])));
			expect(await nextMemoryFolder(cwd)).toBe(folder);
		},
	);
});

describe("importSpecifier", () => {
	const root = join(tmpdir(), "app");

	test.each([
		["src/lib", "src/db/drizzle.ts", false, "../db/drizzle"],
		["src/lib", "src/db/index.ts", false, "../db"],
		["src/lib", "src/lib/db.ts", false, "./db"],
		["lib", "lib/db/index.mjs", false, "./db"],
		["", "src/server/db/index.ts", false, "./src/server/db"],
		["", "db.ts", false, "./db"],
		["", "src/db/index.ts", true, "./src/db/index.js"],
		["src/lib", "src/db/client.mts", true, "../db/client.mjs"],
		["src/lib", "src/db/client.js", true, "../db/client.js"],
	])(
		"from %j to %j (extensions %s) is %j",
		(from, to, extensions, specifier) => {
			expect(
				importSpecifier({
					fromDirectory: join(root, from),
					to: join(root, to),
					extensions,
				}),
			).toBe(specifier);
		},
	);
});

test.each([
	["db", { line: 'import { db } from "../db";', local: "db" }],
	[
		"database",
		{ line: 'import { database } from "../db";', local: "database" },
	],
	["default", { line: 'import db from "../db";', local: "db" }],
	["memory", { line: 'import { memory as db } from "../db";', local: "db" }],
	[
		"createMemory",
		{ line: 'import { createMemory as db } from "../db";', local: "db" },
	],
	[
		"openrouterEmbedder",
		{ line: 'import { openrouterEmbedder as db } from "../db";', local: "db" },
	],
])("clientImport(%j)", (name, expected) => {
	expect(clientImport(name, "../db")).toEqual(expected);
});
