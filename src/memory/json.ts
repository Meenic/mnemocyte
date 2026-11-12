import { MnemocyteError } from "../errors.js";
import type { JsonObject, JsonValue } from "../types.js";
import {
	MAX_METADATA_BYTES,
	MAX_METADATA_DEPTH,
	utf8Length,
} from "./limits.js";

declare const ownedJsonObject: unique symbol;

/** Internal marker for a JSON object that Mnemocyte has validated and cloned. */
export type OwnedJsonObject = JsonObject & {
	readonly [ownedJsonObject]: true;
};

function invalidJsonValue(path: string, cause?: unknown): MnemocyteError {
	return new MnemocyteError(
		`${path} must contain only JSON-compatible value data.`,
		"VALIDATION",
		cause,
	);
}

function cloneJsonValue(
	value: unknown,
	path: string,
	ancestors: Set<object>,
	maxDepth: number,
): JsonValue {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean"
	) {
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw invalidJsonValue(path);
		}
		return Object.is(value, -0) ? 0 : value;
	}
	if (typeof value !== "object") {
		throw invalidJsonValue(path);
	}
	if (ancestors.has(value)) {
		throw invalidJsonValue(path);
	}
	// `ancestors` holds the containers above this one, so its size is the
	// nesting depth of this value minus one.
	if (ancestors.size >= maxDepth) {
		throw new MnemocyteError(
			`${path} must be nested at most ${maxDepth} levels deep.`,
			"VALIDATION",
		);
	}

	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			if (
				Object.getOwnPropertySymbols(value).length > 0 ||
				Object.keys(value).some((key) => !/^(0|[1-9]\d*)$/.test(key))
			) {
				throw invalidJsonValue(path);
			}
			return Array.from({ length: value.length }, (_, index) => {
				if (!Object.hasOwn(value, index)) {
					throw invalidJsonValue(`${path}[${index}]`);
				}
				return cloneJsonValue(
					value[index],
					`${path}[${index}]`,
					ancestors,
					maxDepth,
				);
			});
		}

		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw invalidJsonValue(path);
		}
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const entries: Array<[string, JsonValue]> = [];
		for (const key of Reflect.ownKeys(descriptors)) {
			if (typeof key !== "string") {
				throw invalidJsonValue(path);
			}
			const descriptor = descriptors[key];
			if (
				descriptor === undefined ||
				descriptor.enumerable !== true ||
				!("value" in descriptor)
			) {
				throw invalidJsonValue(`${path}.${key}`);
			}
			entries.push([
				key,
				cloneJsonValue(descriptor.value, `${path}.${key}`, ancestors, maxDepth),
			]);
		}
		return Object.fromEntries(entries);
	} finally {
		ancestors.delete(value);
	}
}

/** Validate and deep-clone a JSON-compatible object. */
export function cloneJsonObject(
	value: unknown,
	path = "metadata",
): OwnedJsonObject {
	try {
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			throw invalidJsonValue(path);
		}
		return cloneJsonValue(
			value,
			path,
			new Set(),
			Number.POSITIVE_INFINITY,
		) as OwnedJsonObject;
	} catch (error) {
		if (error instanceof MnemocyteError) {
			throw error;
		}
		throw invalidJsonValue(path, error);
	}
}

/**
 * Validate, cap and deep-clone caller metadata: at most
 * {@link MAX_METADATA_DEPTH} levels deep (checked while cloning, so deep
 * nesting fails before it can exhaust the stack) and at most
 * {@link MAX_METADATA_BYTES} as UTF-8 JSON.
 */
export function snapshotMetadata(value: unknown): OwnedJsonObject {
	let cloned: OwnedJsonObject;
	try {
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			throw invalidJsonValue("metadata");
		}
		cloned = cloneJsonValue(
			value,
			"metadata",
			new Set(),
			MAX_METADATA_DEPTH,
		) as OwnedJsonObject;
	} catch (error) {
		if (error instanceof MnemocyteError) {
			throw error;
		}
		throw invalidJsonValue("metadata", error);
	}
	if (utf8Length(JSON.stringify(cloned)) > MAX_METADATA_BYTES) {
		throw new MnemocyteError(
			`metadata must be at most ${MAX_METADATA_BYTES} bytes as JSON.`,
			"VALIDATION",
		);
	}
	return cloned;
}
