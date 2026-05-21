import { createMnemocyte } from "mnemocyte";
import { describe, expect, test } from "vitest";
import { expectMnemocyteError } from "../helpers.js";

describe("resilience", () => {
	test("handles retries, timeouts, aborts, and retry filters", async () => {
		function createCountingEmbedder({ failures = 0, delayMs = 0 } = {}) {
			let calls = 0;
			const embedder = {
				model: "resilience-test",
				dimensions: 2,
				async embed(
					texts: readonly string[],
					options: { signal?: AbortSignal } = {},
				) {
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
				expect(typeof memory.id).toBe("string");
				expect(counter.calls).toBe(3);
			} finally {
				await client.close();
			}
		}

		// 2. Numeric provider status codes trigger the default retry heuristic.
		{
			let calls = 0;
			const client = createMnemocyte({
				embedder: {
					model: "status-retry-test",
					dimensions: 2,
					async embed(texts) {
						calls += 1;
						if (calls === 1) {
							throw Object.assign(new Error("rate limited"), { status: 429 });
						}
						return texts.map((text) => [text.length, 1]);
					},
				},
				provider: { retries: 1, baseDelayMs: 1, maxDelayMs: 1 },
			});
			try {
				const memory = await client.remember({
					entityId: "status_retry",
					content: "remember after provider status failure",
				});
				expect(typeof memory.id).toBe("string");
				expect(calls).toBe(2);
			} finally {
				await client.close();
			}
		}

		// 3. Retry exhausted surfaces an EMBEDDING error wrapping the underlying cause.
		{
			const counter = createCountingEmbedder({ failures: 5 });
			const client = createMnemocyte({
				embedder: counter.embedder,
				provider: { retries: 2, baseDelayMs: 1, maxDelayMs: 2 },
			});
			try {
				const error = await expectMnemocyteError(
					client.remember({
						entityId: "retry_exhausted",
						content: "always failing",
					}),
					"EMBEDDING",
				);
				expect(error.cause).toBeInstanceOf(Error);
				expect(counter.calls).toBe(3);
			} finally {
				await client.close();
			}
		}

		// 4. Timeout throws TIMEOUT.
		{
			const counter = createCountingEmbedder({ delayMs: 80 });
			const client = createMnemocyte({
				embedder: counter.embedder,
				provider: { timeoutMs: 10, retries: 0 },
			});
			try {
				await expectMnemocyteError(
					client.remember({
						entityId: "timeout",
						content: "slow embedder",
					}),
					"TIMEOUT",
				);
			} finally {
				await client.close();
			}
		}

		// 5. AbortSignal cancels the operation with ABORTED and disables retry.
		{
			const counter = createCountingEmbedder({ delayMs: 80 });
			const client = createMnemocyte({
				embedder: counter.embedder,
				provider: { retries: 3, baseDelayMs: 1, maxDelayMs: 2 },
			});
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 10);
			try {
				await expectMnemocyteError(
					client.remember({
						entityId: "aborted",
						content: "slow embedder",
						signal: controller.signal,
					}),
					"ABORTED",
				);
				expect(counter.calls).toBe(1);
			} finally {
				await client.close();
			}
		}

		// 6. Custom shouldRetry can opt out of retrying.
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
				await expect(
					client.remember({
						entityId: "no_retry",
						content: "fail fast",
					}),
				).rejects.toThrow();
				expect(counter.calls).toBe(1);
				expect(predicateCalls).toBe(1);
			} finally {
				await client.close();
			}
		}

		// 7. Already-aborted signal short-circuits before calling the embedder.
		{
			const counter = createCountingEmbedder();
			const client = createMnemocyte({ embedder: counter.embedder });
			const controller = new AbortController();
			controller.abort();
			try {
				await expectMnemocyteError(
					client.recall({
						entityId: "pre_aborted",
						query: "anything",
						signal: controller.signal,
					}),
					"ABORTED",
				);
				expect(counter.calls).toBe(0);
			} finally {
				await client.close();
			}
		}
	});
});
