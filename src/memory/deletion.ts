import { MnemocyteError } from "../errors.js";

export function memoryHasDependentsError(cause?: unknown): MnemocyteError {
	return new MnemocyteError(
		"Memory cannot be deleted while other memories reference it as their consolidation survivor.",
		"CONFLICT",
		cause,
	);
}

/** A `delete` with `dependents: "restore" | "delete"` met a hidden dependent. */
export function hiddenDependentsError(): MnemocyteError {
	return new MnemocyteError(
		"Memory cannot be deleted: a memory consolidated into it is not visible at this scope.",
		"CONFLICT",
	);
}
