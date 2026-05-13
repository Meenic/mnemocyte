import assert from "node:assert/strict";
import { createMnemocyte, isMnemocyteError } from "../../dist/index.mjs";

function createCountingEmbedder({ failures = 0, delayMs = 0 } = {}) {
	let calls = 0;
	const embedder = {
		model: "resilience-test",
		dimensions: 2,
		async embed(texts, options = {}) {
			calls += 1;
			if (options.signal?.aborted) {
				throw Object.assign(new Error("Aborted"), { name: "AbortError" });
			}
			if (delayMs > 0) {
				await new Promise((resolve, reject) => {
					const timer = setTimeout(resolve, delayMs);
					options.signal?.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							reject(
								Object.assign(new Error("Aborted"), { name: "AbortError" }),
							);
						},
						{ once: true },
					);
				});
			}
			if (calls <= failures) {
				throw new Error("503 Service Unavailable (transient)");
			}
			return texts.map((text) => [text.length, 1]);
		},
	};
	return {
		embedder,
		get calls() {
			return calls;
		},
	};
}

// 1. Retry succeeds after transient failures.
{
	const counter = createCountingEmbedder({ failures: 2 });
	const client = createMnemocyte({
		embedder: counter.embedder,
		provider: { retries: 3, baseDelayMs: 1, maxDelayMs: 2 },
	});
	try {
		const memory = await client.remember({
			entityId: "retry_success",
			content: "remember after transient failures",
		});
		assert.equal(typeof memory.id, "string");
		assert.equal(counter.calls, 3);
	} finally {
		await client.close();
	}
}

// 2. Retry exhausted surfaces an EMBEDDING error wrapping the underlying cause.
{
	const counter = createCountingEmbedder({ failures: 5 });
	const client = createMnemocyte({
		embedder: counter.embedder,
		provider: { retries: 2, baseDelayMs: 1, maxDelayMs: 2 },
	});
	try {
		await assert.rejects(
			() =>
				client.remember({
					entityId: "retry_exhausted",
					content: "always failing",
				}),
			(error) => {
				assert.equal(isMnemocyteError(error), true);
				assert.equal(error.code, "EMBEDDING");
				assert.ok(error.cause instanceof Error);
				return true;
			},
		);
		assert.equal(counter.calls, 3);
	} finally {
		await client.close();
	}
}

// 3. Timeout throws TIMEOUT.
{
	const counter = createCountingEmbedder({ delayMs: 80 });
	const client = createMnemocyte({
		embedder: counter.embedder,
		provider: { timeoutMs: 10, retries: 0 },
	});
	try {
		await assert.rejects(
			() =>
				client.remember({
					entityId: "timeout",
					content: "slow embedder",
				}),
			(error) => {
				assert.equal(isMnemocyteError(error), true);
				assert.equal(error.code, "TIMEOUT");
				return true;
			},
		);
	} finally {
		await client.close();
	}
}

// 4. AbortSignal cancels the operation with ABORTED and disables retry.
{
	const counter = createCountingEmbedder({ delayMs: 80 });
	const client = createMnemocyte({
		embedder: counter.embedder,
		provider: { retries: 3, baseDelayMs: 1, maxDelayMs: 2 },
	});
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 10);
	try {
		await assert.rejects(
			() =>
				client.remember({
					entityId: "aborted",
					content: "slow embedder",
					signal: controller.signal,
				}),
			(error) => {
				assert.equal(isMnemocyteError(error), true);
				assert.equal(error.code, "ABORTED");
				return true;
			},
		);
		assert.equal(counter.calls, 1);
	} finally {
		await client.close();
	}
}

// 5. Custom shouldRetry can opt out of retrying.
{
	const counter = createCountingEmbedder({ failures: 5 });
	let predicateCalls = 0;
	const client = createMnemocyte({
		embedder: counter.embedder,
		provider: {
			retries: 3,
			baseDelayMs: 1,
			maxDelayMs: 2,
			shouldRetry: () => {
				predicateCalls += 1;
				return false;
			},
		},
	});
	try {
		await assert.rejects(() =>
			client.remember({
				entityId: "no_retry",
				content: "fail fast",
			}),
		);
		assert.equal(counter.calls, 1);
		assert.equal(predicateCalls, 1);
	} finally {
		await client.close();
	}
}

// 6. Already-aborted signal short-circuits before calling the embedder.
{
	const counter = createCountingEmbedder();
	const client = createMnemocyte({ embedder: counter.embedder });
	const controller = new AbortController();
	controller.abort();
	try {
		await assert.rejects(
			() =>
				client.recall({
					entityId: "pre_aborted",
					query: "anything",
					signal: controller.signal,
				}),
			(error) => {
				assert.equal(isMnemocyteError(error), true);
				assert.equal(error.code, "ABORTED");
				return true;
			},
		);
		assert.equal(counter.calls, 0);
	} finally {
		await client.close();
	}
}

console.log("Resilience tests passed.");
