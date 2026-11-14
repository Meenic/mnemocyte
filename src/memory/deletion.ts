import { MnemocyteError } from "../errors.js";

export function memoryHasDependentsError(cause?: unknown): MnemocyteError {
	return new MnemocyteError({
		message:
			"Memory cannot be deleted while other memories reference it as their consolidation survivor.",
		code: "CONFLICT",
		reason: "HAS_DEPENDENTS",
		cause: cause,
	});
}

/** A `delete` with `dependents: "restore" | "delete"` met a hidden dependent. */
export function hiddenDependentsError(): MnemocyteError {
	return new MnemocyteError({
		message:
			"Memory cannot be deleted: a memory consolidated into it is not visible at this scope.",
		code: "CONFLICT",
		reason: "HIDDEN_DEPENDENTS",
	});
}
