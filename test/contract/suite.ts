import { migrate } from "mnemocyte";
import { type PostgresClient, postgresStore } from "mnemocyte/postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { postgresTables } from "../../src/db/tables.js";
import { toSqlExecutor } from "../../src/sql/clients.js";
import type { SqlExecutor } from "../../src/sql/executor.js";
import { allPages } from "../fixtures/audit-cursor.js";
import { verifyCreatedBoundsRoundTrip } from "../fixtures/scoped-api.js";
import { expectDefined, expectMnemocyteError } from "../helpers.js";
import {
	CONTRACT_DIMENSIONS,
	type ContractStoreInput,
	contractClientFactory,
	registerSharedContract,
} from "./shared.js";

export { CONTRACT_DIMENSIONS, embedText } from "./shared.js";

/**
 * The Postgres contract: the shared contract (shared.ts) plus the checks
 * only Postgres has (savepoints, microsecond timestamps), on every driver
 * Mnemocyte accepts, run on PGlite in the `contract` project and on real
 * Postgres in `integration`. Each run works in its own namespaces and removes them
 * afterwards, so it can share a database with other test files.
 */

/** A connected driver client and how to release it. */
export interface ContractTarget {
	client: PostgresClient;
	close(): Promise<void>;
}

/**
 * Register the contract for one driver. `connect` runs once per file; the
 * suite migrates the database (adopting a schema installed another way) and
 * then works only in namespaces it created. With `schemaName`, the store
 * gets it, `migrate` installs there, and the suite's own SQL names it too.
 */
export function describeStoreContract(
	name: string,
	connect: () => Promise<ContractTarget>,
	options: { skip?: boolean; directClient?: boolean; schemaName?: string } = {},
): void {
	const suiteOptions = options;
	const tables = postgresTables(options.schemaName ?? null);
	describe.skipIf(options.skip ?? false)(`Postgres contract (${name})`, () => {
		let target: ContractTarget | undefined;
		let executor: SqlExecutor | undefined;
		const namespaces: string[] = [];

		function db(): SqlExecutor {
			return expectDefined(executor, "contract target is not connected");
		}

		/**
		 * The store input: the client itself with `directClient`, as
		 * `createMemory({ store: sql })` users pass it, else `postgresStore`.
		 */
		function storeInput(): ContractStoreInput {
			const connected = expectDefined(target, "not connected").client;
			return suiteOptions.directClient === true
				? connected
				: postgresStore({
						client: connected,
						...(suiteOptions.schemaName === undefined
							? {}
							: { schemaName: suiteOptions.schemaName }),
					});
		}

		const client = contractClientFactory(storeInput, namespaces);

		/**
		 * Fails only this namespace's audit inserts, so other suites sharing
		 * the database are not affected. The namespace is generated from
		 * [a-z0-9_], so it is a safe identifier.
		 */
		async function failAuditWrites(
			namespace: string,
			failing: boolean,
		): Promise<void> {
			const name = `fail_${namespace}`;
			if (failing) {
				await db().query(
					`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
					BEGIN
						RAISE EXCEPTION 'audit write refused';
					END
					$$`,
					[],
				);
				await db().query(
					`CREATE TRIGGER ${name} BEFORE INSERT ON ${tables.events}
					FOR EACH ROW WHEN (NEW.namespace = '${namespace}')
					EXECUTE FUNCTION ${name}()`,
					[],
				);
				return;
			}
			await db().query(
				`DROP TRIGGER IF EXISTS ${name} ON ${tables.events}`,
				[],
			);
			await db().query(`DROP FUNCTION IF EXISTS ${name}()`, []);
		}

		beforeAll(async () => {
			target = await connect();
			executor = toSqlExecutor(target.client);
			await migrate({ store: storeInput(), dimensions: CONTRACT_DIMENSIONS });
		}, 120_000);

		afterAll(async () => {
			if (!target) {
				return;
			}
			try {
				for (const namespace of namespaces) {
					// One statement per table, so consolidation links between
					// deleted rows never block the delete.
					await db().query(
						`DELETE FROM ${tables.memories} WHERE namespace LIKE $1`,
						[`${namespace}%`],
					);
					await db().query(
						`DELETE FROM ${tables.events} WHERE namespace LIKE $1`,
						[`${namespace}%`],
					);
				}
			} finally {
				await target.close();
			}
		}, 120_000);

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

		test("transactions commit, roll back and nest as savepoints", async () => {
			const { namespace } = client("tx");
			const transaction = expectDefined(
				db().transaction?.bind(db()),
				"every built-in adapter has transaction",
			);
			const insertEvent = (tx: SqlExecutor, description: string) =>
				tx.query(
					`INSERT INTO ${tables.events} (id, namespace, entity_id, description, metadata)
					 VALUES (gen_random_uuid(), $1, 'tx', $2, '{}'::jsonb)`,
					[namespace, description],
				);
			const descriptions = async () =>
				(
					await db().query<{ description: string }>(
						`SELECT description FROM ${tables.events} WHERE namespace = $1 ORDER BY description`,
						[namespace],
					)
				).map((row) => row.description);

			await transaction(async (tx) => {
				await insertEvent(tx, "committed");
			});
			await expect(
				transaction(async (tx) => {
					await insertEvent(tx, "rolled back");
					throw new Error("roll back");
				}),
			).rejects.toThrow("roll back");
			await transaction(async (tx) => {
				await insertEvent(tx, "outer");
				const nested = expectDefined(tx.transaction?.bind(tx));
				await expect(
					nested(async (inner) => {
						await insertEvent(inner, "savepoint rolled back");
						throw new Error("inner");
					}),
				).rejects.toThrow("inner");
				await nested(async (inner) => {
					await insertEvent(inner, "savepoint released");
				});
			});
			expect(await descriptions()).toEqual([
				"committed",
				"outer",
				"savepoint released",
			]);

			// A failed statement aborts the transaction; the adapter rolls back
			// and the connection stays usable.
			await expect(
				transaction(async (tx) => {
					await tx.query("SELECT 1 / 0", []);
				}),
			).rejects.toThrow();
			await expect(db().query("SELECT 1 AS one", [])).resolves.toEqual([
				{ one: 1 },
			]);
		});

		test("an aborted signal stops a statement before it is sent", async () => {
			const controller = new AbortController();
			controller.abort();
			await expectMnemocyteError(
				db().query("SELECT 1", [], { signal: controller.signal }),
				"ABORTED",
			);
		});

		test("created bounds round-trip a createdAt cut from microseconds", async () => {
			const { memory, namespace } = client("created-micros");
			await verifyCreatedBoundsRoundTrip(
				memory,
				namespace,
				async (id, micros) => {
					await db().query(
						`UPDATE ${tables.memories}
					SET created_at = created_at + make_interval(secs => $1::double precision)
					WHERE id = $2::uuid`,
						[micros / 1_000_000, id],
					);
				},
			);
		});

		test("audit pages keep microseconds a Date would cut", async () => {
			const { memory, namespace } = client("micro");
			// Rows written by the column default `now()`, or by hand, carry
			// microseconds. Five events in one millisecond, two of them at
			// the same microsecond, in two entities.
			const times = [
				"2026-01-01T00:00:00.123000Z",
				"2026-01-01T00:00:00.123400Z",
				"2026-01-01T00:00:00.123400Z",
				"2026-01-01T00:00:00.123401Z",
				"2026-01-01T00:00:00.123999Z",
			];
			for (const [index, time] of times.entries()) {
				await db().query(
					`INSERT INTO ${tables.events} (id, namespace, entity_id, description, metadata, timestamp)
					 VALUES (gen_random_uuid(), $1, $2, 'memory.created', '{}'::jsonb, $3::timestamptz)`,
					[namespace, index % 2 === 0 ? "even" : "odd", time],
				);
			}
			const expected = async (entity: string | null) =>
				(
					await db().query<{ id: string }>(
						`SELECT id::text AS id FROM ${tables.events}
						 WHERE namespace = $1 AND ($2::text IS NULL OR entity_id = $2)
						 ORDER BY timestamp DESC, id DESC`,
						[namespace, entity],
					)
				).map((row) => row.id);
			for (const entityId of ["even", null] as const) {
				const scope =
					entityId === null ? { namespace } : { namespace, entityId };
				const { events } = await allPages(
					(cursor) =>
						memory.listAuditLog({
							scope,
							limit: 1,
							...(cursor === undefined ? {} : { cursor }),
						}),
					1,
				);
				expect(events.map((event) => event.id)).toEqual(
					await expected(entityId),
				);
			}
		});

		registerSharedContract({ storeInput, client, failAuditWrites });
	});
}
