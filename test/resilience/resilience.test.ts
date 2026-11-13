import {
	createMemory,
	isMnemocyteError,
	MnemocyteError,
	ProviderError,
	type ProviderResilienceConfig,
} from "mnemocyte";
import { describe, expect, test } from "vitest";
import { computeDelayMs, defaultShouldRetry } from "../../src/resilience.js";
import { expectMnemocyteError, testScope } from "../helpers.js";

describe("resilience", () => {
	test("does not retry typed relationship conflicts", () => {
		expect(
			defaultShouldRetry(new MnemocyteError("has dependents", "CONFLICT")),
		).toBe(false);
	});

	test("decides retries from status and error codes, not messages", () => {
		const withStatus = (status: number) =>
			Object.assign(new Error("failed"), { status });
		for (const status of [408, 429, 500, 502, 503, 504]) {
			expect(defaultShouldRetry(withStatus(status)), String(status)).toBe(true);
		}
		for (const status of [400, 401, 403, 404, 409, 422, 501, 505]) {
			expect(defaultShouldRetry(withStatus(status)), String(status)).toBe(
				false,
			);
		}
		expect(
			defaultShouldRetry(
				new ProviderError({ message: "busy", status: 503, body: {} }),
			),
		).toBe(true);
		expect(
			defaultShouldRetry(new ProviderError({ message: "bad", status: 400 })),
		).toBe(false);

		// Messages no longer decide anything.
		expect(defaultShouldRetry(new Error("got 500 tokens"))).toBe(false);
		expect(defaultShouldRetry(new Error("network timeout"))).toBe(false);

		// fetch rejects with a TypeError whose cause carries the network code.
		const fetchFailure = (code: string) =>
			new TypeError("fetch failed", {
				cause: Object.assign(new Error("socket"), { code }),
			});
		for (const code of [
			"ECONNRESET",
			"ECONNREFUSED",
			"ETIMEDOUT",
			"EPIPE",
			"EAI_AGAIN",
			"UND_ERR_SOCKET",
			"UND_ERR_CONNECT_TIMEOUT",
			"UND_ERR_HEADERS_TIMEOUT",
			"UND_ERR_BODY_TIMEOUT",
		]) {
			expect(defaultShouldRetry(fetchFailure(code)), code).toBe(true);
		}
		expect(defaultShouldRetry(fetchFailure("ENOTFOUND"))).toBe(false);
		expect(
			defaultShouldRetry(
				Object.assign(new Error("reset"), { code: "ECONNRESET" }),
			),
		).toBe(true);

		expect(defaultShouldRetry(new MnemocyteError("slow", "TIMEOUT"))).toBe(
			true,
		);
		for (const code of ["EMBEDDING", "VALIDATION", "CONFIG", "DB"] as const) {
			expect(defaultShouldRetry(new MnemocyteError("x", code)), code).toBe(
				false,
			);
		}
		expect(defaultShouldRetry("string error")).toBe(false);
		expect(defaultShouldRetry(undefined)).toBe(false);
	});

	test("jitters backoff between half and all of the capped delay", () => {
		expect(computeDelayMs(1, 500, 8000, () => 0)).toBe(250);
		expect(computeDelayMs(1, 500, 8000, () => 1)).toBe(500);
		expect(computeDelayMs(3, 500, 8000, () => 0.5)).toBe(1500);
		expect(computeDelayMs(10, 500, 8000, () => 1)).toBe(8000);
		expect(computeDelayMs(10, 500, 8000, () => 0)).toBe(4000);
		expect(computeDelayMs(1, 0, 0, () => 1)).toBe(0);
		for (let attempt = 1; attempt <= 6; attempt += 1) {
			const delay = computeDelayMs(attempt, 100, 2000);
			const cap = Math.min(2000, 100 * 2 ** (attempt - 1));
			expect(delay).toBeGreaterThanOrEqual(cap / 2);
			expect(delay).toBeLessThanOrEqual(cap);
		}
	});

	test("retries twice by default and honours retryAfterMs up to its cap", async () => {
		function failingEmbedder(errors: unknown[]) {
			let calls = 0;
			return {
				get calls() {
					return calls;
				},
				embedder: {
					model: "retry-after-test",
					dimensions: 1,
					async embed(texts: readonly string[]) {
						const error = errors[calls];
						calls += 1;
						if (error !== undefined) {
							throw error;
						}
						return texts.map(() => [1]);
					},
				},
			};
		}
		const busy = (retryAfterMs?: number) =>
			new ProviderError({
				message: "busy",
				status: 503,
				...(retryAfterMs === undefined ? {} : { retryAfterMs }),
			});

		// Default retries: two more attempts after the first.
		{
			const counter = failingEmbedder([busy(), busy(), busy()]);
			const client = createMemory({
				embedder: counter.embedder,
				provider: { baseDelayMs: 0 },
			});
			const error = await expectMnemocyteError(
				client.add({ scope: testScope("default_retries"), content: "x" }),
				"EMBEDDING",
			);
			expect(error).toBeInstanceOf(ProviderError);
			expect(counter.calls).toBe(3);
		}

		// A server-requested wait replaces the backoff.
		{
			const counter = failingEmbedder([busy(30)]);
			const client = createMemory({
				embedder: counter.embedder,
				provider: { baseDelayMs: 60_000, maxDelayMs: 60_000 },
			});
			const started = performance.now();
			await client.add({ scope: testScope("retry_after"), content: "x" });
			const elapsed = performance.now() - started;
			expect(counter.calls).toBe(2);
			expect(elapsed).toBeGreaterThanOrEqual(25);
			expect(elapsed).toBeLessThan(5_000);
		}

		// A wait longer than maxRetryAfterMs (default 60 s) is not retried.
		{
			const counter = failingEmbedder([busy(120_000)]);
			const client = createMemory({ embedder: counter.embedder });
			await expectMnemocyteError(
				client.add({ scope: testScope("retry_after_cap"), content: "x" }),
				"EMBEDDING",
			);
			expect(counter.calls).toBe(1);
		}
		{
			const counter = failingEmbedder([busy(50)]);
			const client = createMemory({
				embedder: counter.embedder,
				provider: { maxRetryAfterMs: 10 },
			});
			await expectMnemocyteError(
				client.add({ scope: testScope("retry_after_low_cap"), content: "x" }),
				"EMBEDDING",
			);
			expect(counter.calls).toBe(1);
		}

		// Plain errors carrying retryAfterMs count too.
		{
			const counter = failingEmbedder([
				Object.assign(new Error("limited"), { status: 429, retryAfterMs: 0 }),
			]);
			const client = createMemory({
				embedder: counter.embedder,
				provider: { baseDelayMs: 60_000, maxDelayMs: 60_000 },
			});
			await client.add({ scope: testScope("duck_retry_after"), content: "x" });
			expect(counter.calls).toBe(2);
		}

		// A message mentioning 500 is not retried.
		{
			const counter = failingEmbedder([new Error("HTTP 500 from provider")]);
			const client = createMemory({
				embedder: counter.embedder,
				provider: { baseDelayMs: 0 },
			});
			await expectMnemocyteError(
				client.add({ scope: testScope("message_500"), content: "x" }),
				"EMBEDDING",
			);
			expect(counter.calls).toBe(1);
		}
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
			["NaN max Retry-After", { maxRetryAfterMs: Number.NaN }],
			["negative max Retry-After", { maxRetryAfterMs: -1 }],
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
				createMemory({
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
		const zeroClient = createMemory({
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
		await zeroClient.add({
			scope: testScope("zero_provider_config"),
			content: "valid zero boundaries",
		});
		expect(zeroCalls).toBe(1);

		let normalizedDelayCalls = 0;
		const normalizedDelayClient = createMemory({
			embedder: {
				model: "normalized-delay-config",
				dimensions: 1,
				async embed(texts) {
					normalizedDelayCalls += 1;
					if (normalizedDelayCalls === 1) {
						throw Object.assign(new Error("transient"), { status: 503 });
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
		await normalizedDelayClient.add({
			scope: testScope("normalized_delay_config"),
			content: "max delay below base remains supported",
		});
		expect(normalizedDelayCalls).toBe(2);
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
						throw Object.assign(new Error("Service Unavailable"), {
							status: 503,
						});
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
			const client = createMemory({
				embedder: counter.embedder,
				provider: { retries: 3, baseDelayMs: 1, maxDelayMs: 2 },
			});
			const memory = await client.add({
				scope: testScope("retry_success"),
				content: "remember after transient failures",
			});
			expect(typeof memory.id).toBe("string");
			expect(counter.calls).toBe(3);
		}

		// 2. Numeric provider status codes trigger the default retry heuristic.
		{
			let calls = 0;
			const client = createMemory({
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
			const memory = await client.add({
				scope: testScope("status_retry"),
				content: "remember after provider status failure",
			});
			expect(typeof memory.id).toBe("string");
			expect(calls).toBe(2);
		}

		// 3. Retry exhausted surfaces an EMBEDDING error wrapping the underlying cause.
		{
			const counter = createCountingEmbedder({ failures: 5 });
			const client = createMemory({
				embedder: counter.embedder,
				provider: { retries: 2, baseDelayMs: 1, maxDelayMs: 2 },
			});
			const error = await expectMnemocyteError(
				client.add({
					scope: testScope("retry_exhausted"),
					content: "always failing",
				}),
				"EMBEDDING",
			);
			expect(error.cause).toBeInstanceOf(Error);
			expect(counter.calls).toBe(3);
		}

		// 4. Timeout throws TIMEOUT.
		{
			const counter = createCountingEmbedder({ delayMs: 80 });
			const client = createMemory({
				embedder: counter.embedder,
				provider: { timeoutMs: 10, retries: 0 },
			});
			await expectMnemocyteError(
				client.add({
					scope: testScope("timeout"),
					content: "slow embedder",
				}),
				"TIMEOUT",
			);
		}

		// 5. Timeout aborts the per-attempt provider signal.
		{
			let calls = 0;
			let sawAbort = false;
			const client = createMemory({
				embedder: {
					model: "timeout-abort-test",
					dimensions: 2,
					async embed(_texts, options) {
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
			await expectMnemocyteError(
				client.add({
					scope: testScope("timeout_signal"),
					content: "slow embedder",
				}),
				"TIMEOUT",
			);
			expect(calls).toBe(1);
			expect(sawAbort).toBe(true);
		}

		// 6. AbortSignal cancels the operation with ABORTED and disables retry.
		{
			const counter = createCountingEmbedder({ delayMs: 80 });
			const client = createMemory({
				embedder: counter.embedder,
				provider: { retries: 3, baseDelayMs: 1, maxDelayMs: 2 },
			});
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 10);
			await expectMnemocyteError(
				client.add({
					scope: testScope("aborted"),
					content: "slow embedder",
					signal: controller.signal,
				}),
				"ABORTED",
			);
			expect(counter.calls).toBe(1);
		}

		// 7. Custom shouldRetry can opt out of retrying.
		{
			const counter = createCountingEmbedder({ failures: 5 });
			let predicateCalls = 0;
			const client = createMemory({
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
			await expect(
				client.add({
					scope: testScope("no_retry"),
					content: "fail fast",
				}),
			).rejects.toThrow();
			expect(counter.calls).toBe(1);
			expect(predicateCalls).toBe(1);
		}

		// 8. Already-aborted signal short-circuits before calling the embedder.
		{
			const counter = createCountingEmbedder();
			const client = createMemory({ embedder: counter.embedder });
			const controller = new AbortController();
			controller.abort();
			await expectMnemocyteError(
				client.search({
					scope: testScope("pre_aborted"),
					query: "anything",
					signal: controller.signal,
				}),
				"ABORTED",
			);
			expect(counter.calls).toBe(0);
		}
	});
});
