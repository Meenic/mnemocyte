import { MnemocyteError } from "./errors.js";

export function parsePostgresDatabaseUrl(databaseUrl: string): URL {
	let url: URL;
	try {
		url = new URL(databaseUrl);
	} catch (error) {
		throw new MnemocyteError(
			"databaseUrl must be a valid Postgres connection URL.",
			"CONFIG",
			error,
		);
	}
	if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
		throw new MnemocyteError(
			"databaseUrl must use the postgres: or postgresql: protocol.",
			"CONFIG",
		);
	}
	return url;
}
