// A chat in the terminal that remembers. withMemory adds the user's
// relevant memories to every model call, and `save: { model }` has a model
// store lasting facts from each turn. Type /new to start a new conversation:
// the history is cleared, the memories stay.
//
// Needs AI_GATEWAY_API_KEY: the chat model, the extraction model and the
// embedder all go through the AI Gateway. From the repository root, after
// `pnpm build`:
//
//   node examples/ai-sdk-chat.ts
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import { gateway, type ModelMessage, streamText } from "ai";
import { createMemory } from "mnemocyte";
import { aiSdkEmbedder, withMemory } from "mnemocyte/ai-sdk";

if (!process.env.AI_GATEWAY_API_KEY) {
	console.error("Set AI_GATEWAY_API_KEY to run this example.");
	process.exit(1);
}

// In process memory, so memories last until you quit; pglite.ts shows how
// to keep them.
const memory = createMemory({
	namespace: "examples",
	embedder: aiSdkEmbedder({ model: "openai/text-embedding-3-small" }),
});
const user = memory.for({ entityId: "user_123" });

// Extraction runs after each response and the response does not wait for
// it. A server hands it to its platform's waitUntil; this script collects
// the promises and waits for them before the next turn, so that turn can
// find what this one saved.
const pending: Promise<void>[] = [];

const model = withMemory({
	model: gateway("openai/gpt-6.1-sol"),
	memory: user,
	save: {
		model: "openai/gpt-6.1-mini",
		waitUntil: (promise) => {
			pending.push(promise);
		},
	},
	onError: ({ phase, error }) => console.warn(`[memory ${phase}]`, error),
});

let messages: ModelMessage[] = [];

const rl = createInterface({ input: stdin, output: stdout });
console.log(
	"Tell me about yourself, then type /new and ask what I remember.\n" +
		"/memories lists what is stored. Ctrl+D quits.",
);
rl.setPrompt("\nyou> ");
rl.prompt();

for await (const line of rl) {
	const input = line.trim();
	if (input === "/new") {
		messages = [];
		console.log("New conversation. The memories are still there.");
	} else if (input === "/memories") {
		const { memories } = await user.list({ limit: 50 });
		for (const saved of memories) {
			console.log(`- ${saved.content}`);
		}
		if (memories.length === 0) console.log("Nothing stored yet.");
	} else if (input !== "") {
		messages.push({ role: "user", content: input });
		const result = streamText({
			model,
			instructions: "You are a friendly assistant. Keep answers short.",
			messages,
		});
		stdout.write("ai> ");
		for await (const chunk of result.textStream) {
			stdout.write(chunk);
		}
		stdout.write("\n");
		messages.push(...(await result.response).messages);
		await Promise.all(pending.splice(0));
	}
	rl.prompt();
}

await Promise.all(pending);
