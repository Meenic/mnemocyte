import { MnemocyteError } from "../errors.js";
import { isUuid } from "./records.js";
import type { StoreListPosition } from "./store.js";

/**
 * `list` cursors are opaque to callers: base64url of the JSON array
 * `[createdAt ISO string, id]` of the page's last memory. Pages are ordered by
 * `(createdAt, id)` descending, which is a total order, so a cursor stays
 * valid while rows are added or deleted.
 */
export function encodeListCursor(position: StoreListPosition): string {
	const json = JSON.stringify([position.createdAt.toISOString(), position.id]);
	return btoa(json)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

function invalidCursor(): MnemocyteError {
	return new MnemocyteError(
		"cursor must be a nextCursor value returned by list.",
		"VALIDATION",
	);
}

export function decodeListCursor(cursor: unknown): StoreListPosition {
	if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
		throw invalidCursor();
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(
			atob(cursor.replaceAll("-", "+").replaceAll("_", "/")),
		) as unknown;
	} catch {
		throw invalidCursor();
	}
	if (!Array.isArray(parsed) || parsed.length !== 2) {
		throw invalidCursor();
	}
	const [timestamp, id] = parsed as unknown[];
	if (typeof timestamp !== "string" || typeof id !== "string" || !isUuid(id)) {
		throw invalidCursor();
	}
	const createdAt = new Date(timestamp);
	if (!Number.isFinite(createdAt.getTime())) {
		throw invalidCursor();
	}
	return { createdAt, id };
}
