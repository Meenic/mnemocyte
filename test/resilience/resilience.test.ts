import {
	createMnemocyte,
	isMnemocyteError,
	MnemocyteError,
	type ProviderResilienceConfig,
} from "mnemocyte";
import { describe, expect, test } from "vitest";
import { defaultShouldRetry } from "../../src/resilience.js";
import { expectMnemocyteError } from "../helpers.js";

describe("resilience", () => {
	test("does not retry typed relationship conflicts", () => {
		expect(
			defaultShouldRetry(new MnemocyteError("has dependents", "CONFLICT")),
		).toBe(false);
	});

	test("validates provider resilience configuration at construction", async () => {
		const invalidConfigs: readonly [
			label: string,
			config: ProviderResilienceConfig,
		][] = [
			["NaN retries", { retries: Number.NaN }],
			["infinite retries", { retries: Number.POSITIVE_INFINITY }],
			["negative retries", { retries: -1 }],
			["fractional retries", { retries: 1.5 }],
			["NaN timeout", { timeoutMs: Number.NaN }],
			["infinite timeout", { timeoutMs: Number.POSITIVE_INFINITY }],
			["negative timeout", { timeoutMs: -1 }],
			["NaN base delay", { baseDelayMs: Number.NaN }],
			["infinite base delay", { baseDelayMs: Number.POSITIVE_INFINITY }],
			["negative base delay", { baseDelayMs: -1 }],
			["NaN max delay", { maxDelayMs: Number.NaN }],
			["infinite max delay", { maxDelayMs: Number.POSITIVE_INFINITY }],
			["negative max delay", { maxDelayMs: -1 }],
			[
				"non-function retry predicate",
				{
					shouldRetry: true as unknown as NonNullable<
						ProviderResilienceConfig["shouldRetry"]
					>,
				},
			],
		];

		for (const [label, provider] of invalidConfigs) {
			let embedCalls = 0;
			try {
				createMnemocyte({
					embedder: {
						model: "invalid-provider-config",
						dimensions: 1,
						async embed(texts) {
							embedCalls += 1;
							return texts.map(() => [1]);
						},
					},
					provider,
				});
			} catch (error) {
				expect(isMnemocyteError(error), label).toBe(true);
				if (!isMnemocyteError(error)) {
					throw error;
				}
				expect(error.code, label).toBe("CONFIG");
				expect(embedCalls, label).toBe(0);
				continue;
			}
			throw new Error(`Expected CONFIG for ${label}.`);
		}

		let zeroCalls = 0;
		const zeroClient = createMnemocyte({
			embedder: {
				model: "zero-provider-config",
				dimensions: 1,
				async embed(texts) {
					zeroCalls += 1;
					return texts.map(() => [1]);
				},
			},
			provider: {
				timeoutMs: 0,
				retries: 0,
				baseDelayMs: 0,
				maxDelayMs: 0,
				shouldRetry: () => false,
			},
		});
		try {
			await zeroClient.remember({
				entityId: "zero_provider_config",
				content: "valid zero boundaries",
			});
			expect(zeroCalls).toBe(1);
		} finally {
			await zeroClient.close();
		}

		let normalizedDelayCalls = 0;
		const normalizedDelayClient = createMnemocyte({
			embedder: {
				model: "normalized-delay-config",
				dimensions: 1,
				async embed(texts) {
					normalizedDelayCalls += 1;
					if (normalizedDelayCalls === 1) {
						throw new Error("503 transient");
					}
					return texts.map(() => [1]);
				},
			},
			provider: {
				timeoutMs: 1_000,
				retries: 1,
				baseDelayMs: 2,
				maxDelayMs: 1,
			},
		});
		try {
			await normalizedDelayClient.remember({
				entityId: "normalized_delay_config",
				content: "max delay below base remains supported",
			});
			expect(normalizedDelayCalls).toBe(2);
		} finally {
			await normalizedDelayClient.close();
		}
	});

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

		// 5. Timeout aborts the per-attempt provider signal.
		{
			let calls = 0;
			let sawAbort = false;
			const client = createMnemocyte({
				embedder: {
					model: "timeout-abort-test",
					dimensions: 2,
					async embed(_texts, options = {}) {
						calls += 1;
						return new Promise<number[][]>((_resolve, reject) => {
							options.signal?.addEventListener(
								"abort",
								() => {
									sawAbort = true;
									reject(
										Object.assign(new Error("Aborted"), { name: "AbortError" }),
									);
								},
								{ once: true },
							);
						});
					},
				},
				provider: { timeoutMs: 10, retries: 0 },
			});
			try {
				await expectMnemocyteError(
					client.remember({
						entityId: "timeout_signal",
						content: "slow embedder",
					}),
					"TIMEOUT",
				);
				expect(calls).toBe(1);
				expect(sawAbort).toBe(true);
			} finally {
				await client.close();
			}
		}

		// 6. AbortSignal cancels the operation with ABORTED and disables retry.
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

		// 7. Custom shouldRetry can opt out of retrying.
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

		// 8. Already-aborted signal short-circuits before calling the embedder.
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
