export type MnemocyteErrorCode =
	| "CONFIG"
	| "VALIDATION"
	| "DB"
	| "EMBEDDING"
	| "NOT_FOUND"
	| "MIGRATION";

export class MnemocyteError extends Error {
	readonly code: MnemocyteErrorCode;
	override readonly cause?: unknown;

	constructor(message: string, code: MnemocyteErrorCode, cause?: unknown) {
		super(message);
		this.name = "MnemocyteError";
		this.code = code;
		this.cause = cause;
	}
}

export function isMnemocyteError(error: unknown): error is MnemocyteError {
	return error instanceof MnemocyteError;
}
