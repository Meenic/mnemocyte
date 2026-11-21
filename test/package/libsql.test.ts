import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createPackedConsumer } from "./packed-consumer.js";

describe("libSQL from the packed package", () => {
	test("migrates, writes and searches through ESM and require(), with the client linked in", async () => {
		const packed = await createPackedConsumer();
		try {
			// Without the peer, the subpath still loads: it imports no driver.
			const bare = join(packed.dir, "bare.mjs");
			await writeFile(
				bare,
				`import { libsqlStore } from "mnemocyte/libsql";
				process.stdout.write(typeof libsqlStore);`,
				"utf8",
			);
			expect((await packed.run(bare)).stdout).toBe("function");

			await packed.linkLibsql();
			const embedder = `{
				model: "packed-libsql",
				dimensions: 3,
				async embed(texts) {
					return texts.map((text) => [text.length, 1, text.includes("tea") ? 1 : 0]);
				},
			}`;
			const esm = join(packed.dir, "libsql.mjs");
			await writeFile(
				esm,
				`import { createClient } from "@libsql/client";
				import { createMemory, migrate } from "mnemocyte";
				import { libsqlStore } from "mnemocyte/libsql";

				const client = createClient({ url: "file:esm.db" });
				const memory = createMemory({ store: libsqlStore({ client }), embedder: ${embedder} });
				await migrate({ memory });
				const scope = { namespace: "packed", entityId: "libsql" };
				const added = await memory.add({ scope, content: "Drinks green tea." });
				const found = await memory.search({ scope, query: "green tea" });
				if (found[0]?.id !== added.id) {
					throw new Error("search did not find the memory.");
				}
				client.close();
				process.stdout.write("packed-libsql-esm-ok");`,
				"utf8",
			);
			expect((await packed.run(esm)).stdout).toBe("packed-libsql-esm-ok");

			// require(esm), with the client itself as store: the lazily
			// imported backend chunk must not use top-level await.
			const cjs = join(packed.dir, "libsql.cjs");
			await writeFile(
				cjs,
				`const { createClient } = require("@libsql/client");
				const { createMemory, migrate } = require("mnemocyte");

				(async () => {
					const client = createClient({ url: "file:cjs.db" });
					const memory = createMemory({ store: client, embedder: ${embedder} });
					await migrate({ memory });
					const scope = { namespace: "packed", entityId: "libsql" };
					await memory.add({ scope, content: "Drinks green tea." });
					const stats = await memory.stats({ scope });
					if (stats.memoryCount !== 1) {
						throw new Error("unexpected stats");
					}
					client.close();
					process.stdout.write("packed-libsql-cjs-ok");
				})().catch((error) => {
					console.error(error);
					process.exit(1);
				});`,
				"utf8",
			);
			const required = await packed.run(cjs);
			expect(required.stdout).toBe("packed-libsql-cjs-ok");
			expect(required.stderr).toBe("");
		} finally {
			await packed.remove().catch(() => undefined);
		}
	});
});
