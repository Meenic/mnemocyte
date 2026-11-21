import { createClient } from "@libsql/client";
import {
	describeLibsqlContract,
	libsqlStoreInput,
} from "../contract/libsql.js";

/**
 * The libSQL contract over the network, on a libSQL server (sqld) whose
 * URL is `LIBSQL_URL`, such as `http://127.0.0.1:8080`: the Hrana protocol
 * Turso users connect with, where batches and transactions travel as
 * requests. Skipped without the variable; CI does not run it yet
 * (`chore/libsql-remote-ci` in docs/ROADMAP.md). The database must be empty
 * and disposable: the suite migrates it and leaves its rows.
 */
const url = process.env.LIBSQL_URL;

describeLibsqlContract("sqld over HTTP", libsqlStoreInput, {
	skip: url === undefined || url === "",
	async open() {
		const client = createClient({
			url: url ?? "",
			...(process.env.LIBSQL_AUTH_TOKEN === undefined
				? {}
				: { authToken: process.env.LIBSQL_AUTH_TOKEN }),
		});
		return {
			client,
			url: url ?? "",
			async close() {
				client.close();
			},
		};
	},
});
