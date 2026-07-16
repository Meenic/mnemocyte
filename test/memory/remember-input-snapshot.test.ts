import { createMnemocyte } from "mnemocyte";
import { describe, test } from "vitest";
import {
	createGatedEmbedder,
	verifyRememberInputSnapshots,
} from "../fixtures/remember-input-snapshot.js";

describe("remember input snapshots", () => {
	test("owns mutable single and batch inputs before awaiting", async () => {
		const gate = createGatedEmbedder("remember-input-snapshot", 2);
		const client = createMnemocyte({ embedder: gate.embedder });

		try {
			await verifyRememberInputSnapshots(
				client,
				gate.nextCall,
				"snapshot_in_memory",
			);
		} finally {
			await client.close();
		}
	});
});
