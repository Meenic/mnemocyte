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
	return toBase64Url(
		JSON.stringify([position.createdAt.toISOString(), position.id]),
	);
}

function invalidCursor(): MnemocyteError {
	return new MnemocyteError(
		"cursor must be a nextCursor value returned by list.",
		"VALIDATION",
	);
}

export function decodeListCursor(cursor: unknown): StoreListPosition {
	const parsed = parseBase64UrlJson(cursor);
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

/**
 * Tag of `findDuplicatesPage` cursors, so a `list` cursor (or one from a
 * later format) is rejected instead of read as a position.
 */
const DUPLICATE_CURSOR_TAG = "d1";

/**
 * `findDuplicatesPage` cursors are opaque to callers: base64url of the JSON
 * array `["d1", id]`, where `id` is the last memory the page compared. Pages
 * compare memories in id order, so the next page starts after it.
 */
export function encodeDuplicateCursor(id: string): string {
	return toBase64Url(JSON.stringify([DUPLICATE_CURSOR_TAG, id]));
}

export function decodeDuplicateCursor(cursor: unknown): string {
	const invalid = () =>
		new MnemocyteError(
			"cursor must be a nextCursor value returned by findDuplicatesPage.",
			"VALIDATION",
		);
	const parsed = parseBase64UrlJson(cursor);
	if (!Array.isArray(parsed) || parsed.length !== 2) {
		throw invalid();
	}
	const [tag, id] = parsed as unknown[];
	if (tag !== DUPLICATE_CURSOR_TAG || typeof id !== "string" || !isUuid(id)) {
		throw invalid();
	}
	// Postgres orders uuids by their bytes, which is the order of their
	// lower-case text; the in-memory store compares that text.
	return id.toLowerCase();
}

function toBase64Url(text: string): string {
	return btoa(text)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

/** The JSON a base64url cursor holds, or `undefined` when it holds none. */
function parseBase64UrlJson(cursor: unknown): unknown {
	if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
		return undefined;
	}
	try {
		return JSON.parse(
			atob(cursor.replaceAll("-", "+").replaceAll("_", "/")),
		) as unknown;
	} catch {
		return undefined;
	}
}
