export function formatVectorComponent(value: number): string {
	if (!Number.isFinite(value)) {
		throw new Error("Vector values must be finite numbers.");
	}
	return Object.is(value, -0) ? "0" : value.toString();
}

export function formatVector(embedding: readonly number[]): string {
	return `[${embedding.map(formatVectorComponent).join(",")}]`;
}

/** Parse pgvector's text form, `[0.1,0.2]`, which drivers return as a string. */
export function parseVector(value: string): number[] {
	return value.slice(1, -1).split(",").filter(Boolean).map(Number);
}
