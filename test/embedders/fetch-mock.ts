import { afterEach, beforeEach, vi } from "vitest";

/**
 * Stub the global `fetch` for one test file and read back what the
 * embedder sent. Also clears stubbed environment variables between tests.
 */
export function useFetchMock() {
	const originalFetch = globalThis.fetch;
	const fetchMock = vi.fn<typeof fetch>();

	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
		vi.unstubAllEnvs();
	});

	afterEach(() => {
		vi.stubGlobal("fetch", originalFetch);
		vi.unstubAllEnvs();
	});

	function respondJson(body: unknown, status = 200): void {
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			}),
		);
	}

	function lastRequest(): { url: string; init: RequestInit } {
		const call = fetchMock.mock.calls.at(-1);
		if (!call) {
			throw new Error("fetch was not called");
		}
		return { url: String(call[0]), init: call[1] ?? {} };
	}

	function lastBody(): Record<string, unknown> {
		return JSON.parse(String(lastRequest().init.body));
	}

	return { fetchMock, respondJson, lastRequest, lastBody };
}

/** Resolve with the rejection reason of a promise that must reject. */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => {
			throw new Error("Expected a rejection.");
		},
		(error: unknown) => error,
	);
}
