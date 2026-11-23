import type { Embedder } from "mnemocyte";

// A deterministic embedder for tests: letter counts, so texts that share
// words score higher. No network.
export const embedder: Embedder = {
	model: "letters",
	dimensions: 26,
	async embed(texts) {
		return texts.map((text) => {
			const vector = new Array<number>(26).fill(0);
			for (const char of text.toLowerCase()) {
				const index = char.charCodeAt(0) - 97;
				if (index >= 0 && index < 26) {
					vector[index] = (vector[index] ?? 0) + 1;
				}
			}
			vector[0] = (vector[0] ?? 0) + 0.001;
			return vector;
		});
	},
};
