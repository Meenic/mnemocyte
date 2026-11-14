import { MnemocyteError } from "./errors.js";

/**
 * The message for the first key of `value` that is not in `accepted`, or
 * `undefined` when every key is known.
 *
 * A key whose value is `undefined` still counts as given, so it must be a
 * known one. A value that is not an object is left to the caller's own type
 * check. `renamed` maps a key an earlier version took to its current name,
 * so the message says what to use instead. `noun` is what the keys are
 * called in the message (`option` for configuration, `key` for method
 * inputs).
 */
export function unknownKeyMessage(
	name: string,
	value: unknown,
	accepted: readonly string[],
	renamed: Readonly<Record<string, string>>,
	noun: "option" | "key",
): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	for (const key of Object.keys(value)) {
		if (accepted.includes(key)) {
			continue;
		}
		const label = noun === "option" ? `the option "${key}"` : `"${key}"`;
		const replacement = Object.hasOwn(renamed, key) ? renamed[key] : undefined;
		return replacement === undefined
			? `${name} does not accept ${label}. Accepted ${noun}s: ${accepted.join(", ")}.`
			: `${name} does not accept ${label}: it was renamed "${replacement}".`;
	}
	return undefined;
}

/**
 * Throw `"CONFIG"` when `value` has a key that is not in `accepted`.
 *
 * TypeScript flags a misspelled key only in an object literal; from
 * JavaScript, or with options built elsewhere, an ignored `baseURL` would
 * send content to a provider's default endpoint. See
 * {@link unknownKeyMessage} for `undefined` values, non-objects and
 * `renamed`.
 *
 * `name` prefixes the message (`openaiEmbedder`, `createMemory retrieval`).
 */
export function assertKnownKeys(
	name: string,
	value: object,
	accepted: readonly string[],
	renamed: Readonly<Record<string, string>> = {},
): void {
	const message = unknownKeyMessage(name, value, accepted, renamed, "option");
	if (message !== undefined) {
		throw new MnemocyteError({
			message,
			code: "CONFIG",
			reason: "INVALID_OPTION",
		});
	}
}

/** Keys the embedders took as `baseUrl` before 1.0. */
export const RENAMED_BASE_URL: Readonly<Record<string, string>> = {
	baseUrl: "baseURL",
};
