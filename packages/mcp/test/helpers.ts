import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { BoundMemoryClient, Embedder, MemoryClient } from "mnemocyte";
import { createMemory } from "mnemocyte";
import { onTestFinished } from "vitest";
import {
	createMemoryMcpServer,
	type MemoryMcpServerOptions,
} from "../src/index.js";
import { embedder as lettersEmbedder } from "./fixtures/app/src/embedder.js";

/** An in-memory client in namespace `"app"`. */
export function createTestMemory(
	embedder: Embedder = lettersEmbedder,
): MemoryClient<true> {
	return createMemory({ namespace: "app", embedder });
}

/** The bound client the tests serve: entity `"u1"` in `"app"`. */
export function boundTo(
	memory: MemoryClient<true>,
	entityId = "u1",
): BoundMemoryClient {
	return memory.for({ entityId });
}

/**
 * An MCP client connected to {@link createMemoryMcpServer} over an
 * in-memory transport pair. Closed when the test finishes.
 */
export async function connect(
	options: MemoryMcpServerOptions,
): Promise<Client> {
	const server = createMemoryMcpServer(options);
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: "test", version: "0.0.0" });
	await client.connect(clientTransport);
	onTestFinished(async () => {
		await client.close();
		await server.close();
	});
	return client;
}

/** The text of a tool result's first content block. */
export function textOf(result: { content?: unknown }): string {
	const [first] = Array.isArray(result.content) ? result.content : [];
	if (
		typeof first === "object" &&
		first !== null &&
		"text" in first &&
		typeof first.text === "string"
	) {
		return first.text;
	}
	throw new Error("The result has no text content.");
}
