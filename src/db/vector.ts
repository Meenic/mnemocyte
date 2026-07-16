export function formatVectorComponent(value: number): string {
	if (!Number.isFinite(value)) {
		throw new Error("Vector values must be finite numbers.");
	}
	return Object.is(value, -0) ? "0" : value.toString();
}
