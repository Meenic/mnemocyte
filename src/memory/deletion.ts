import { MnemocyteError } from "../errors.js";

export function memoryHasDependentsError(cause?: unknown): MnemocyteError {
	return new MnemocyteError(
		"Memory cannot be deleted while other memories reference it as their consolidation survivor.",
		"CONFLICT",
		cause,
	);
}
