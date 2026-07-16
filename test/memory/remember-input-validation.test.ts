import { createMnemocyte } from "mnemocyte";
import { describe, test } from "vitest";
import {
	createCountingEmbedder,
	verifyRememberInputValidation,
} from "../fixtures/remember-input-validation.js";

describe("remember input validation", () => {
	test("rejects malformed runtime values before embedding or storage", async () => {
		const counter = createCountingEmbedder("remember-input-validation", 2);
		const client = createMnemocyte({ embedder: counter.embedder });

		try {
			await verifyRememberInputValidation(
				client,
				counter.getCalls,
				"validation_in_memory",
			);
		} finally {
			await client.close();
		}
	});
});
