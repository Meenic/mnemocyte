import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { migrate } from "mnemocyte";
import { libsqlStore } from "mnemocyte/libsql";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import {
	CONTRACT_DIMENSIONS,
	type ContractStoreInput,
	contractClientFactory,
	registerSharedContract,
} from "../../src/store-test/contract.js";
import { expectDefined } from "../helpers.js";

declare module "vitest" {
	export interface ProvidedContext {
		/** The folder from `libsql.global-setup.ts`. */
		libsqlRoot: string;
	}
}

/** A libSQL database in a temporary file, and how to close it. */
export interface LibsqlDatabase {
	readonly client: Client;
	readonly url: string;
	close(): Promise<void>;
}

/**
 * A new, empty libSQL database in a file of its own, under the project's
 * temporary folder. Not `:memory:`: that
 * client has one connection, and while a transaction holds it every other
 * call fails with `TRANSACTION_ACTIVE`.
 */
export async function openLibsql(): Promise<LibsqlDatabase> {
	const dir = await mkdtemp(join(inject("libsqlRoot"), "db-"));
	const url = `file:${join(dir, "memory.db").replaceAll("\\", "/")}`;
	const client = createClient({ url });
	return {
		client,
		url,
		async close() {
			// The global setup removes the folder once the workers exit.
			client.close();
		},
	};
}

/**
 * Register the shared contract on libSQL. `input` builds the store value
 * from the client: `libsqlStore({ client })`, the client itself, or a
 * Drizzle instance over it. `open` gives the database: a temporary file by
 * default, or a libSQL server (test/integration/libsql-remote.test.ts).
 */
export function describeLibsqlContract(
	name: string,
	input: (client: Client) => ContractStoreInput,
	options: { open?: () => Promise<LibsqlDatabase>; skip?: boolean } = {},
): void {
	const open = options.open ?? openLibsql;
	describe.skipIf(options.skip ?? false)(`libSQL contract (${name})`, () => {
		let database: LibsqlDatabase | undefined;
		const namespaces: string[] = [];
		const client = (): Client =>
			expectDefined(database, "libSQL is not open").client;
		const storeInput = (): ContractStoreInput => input(client());

		beforeAll(async () => {
			database = await open();
			await migrate({ store: storeInput(), dimensions: CONTRACT_DIMENSIONS });
		});

		afterAll(async () => {
			await database?.close();
		});

		test("migrate is a no-op once the schema is current", async () => {
			await expect(
				migrate({ store: storeInput(), dimensions: CONTRACT_DIMENSIONS }),
			).resolves.toEqual({
				applied: [],
				adopted: [],
				extensionCreated: false,
				schemaCreated: false,
			});
		});

		registerSharedContract({
			storeInput,
			client: contractClientFactory(storeInput, namespaces),
			async failAuditWrites(namespace, failing) {
				// The namespace is generated from [a-z0-9_].
				const name = `fail_${namespace}`;
				await client().execute(
					failing
						? `CREATE TRIGGER "${name}" BEFORE INSERT ON "mnemocyte_events"
							WHEN NEW."namespace" = '${namespace}'
							BEGIN SELECT RAISE(ABORT, 'audit write refused'); END`
						: `DROP TRIGGER IF EXISTS "${name}"`,
				);
			},
		});
	});
}

/** The store value for a direct client run. */
export function directLibsqlInput(client: Client): ContractStoreInput {
	return client;
}

/** The store value for a `libsqlStore` run. */
export function libsqlStoreInput(client: Client): ContractStoreInput {
	return libsqlStore({ client });
}
