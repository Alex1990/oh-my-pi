// End-to-end N-API token-count throughput probe.
//
// Build the host addon first, then run from crates/pi-natives:
//   pnpm --dir packages/natives run build
//   node --experimental-transform-types --import ../../../scripts/node-runtime-loader.mjs tools/bench-natives.ts

import { bun } from "@oh-my-pi/pi-utils/node-runtime";
import { countTokens, Encoding } from "../../../packages/natives/native/index.js";

const WINDOW_MS = 300;

const CASES: Record<string, string> = {
	english: "The quick brown fox jumps over the lazy dog. It is a small corpus for tokenizer throughput. ".repeat(512),
	code: "function count<T>(items: readonly T[]): number { return items.length; }\n".repeat(2_000),
	cjk: "东京は日本の首都であり、世界で最も人口の多い都市圏の一つです。深度求索发布了新一代基座模型。".repeat(500),
};
const ENCODINGS = [
	Encoding.O200kBase,
	Encoding.Cl100kBase,
	Encoding.ClaudeV3,
	Encoding.ClaudeV47,
	Encoding.ClaudeV5,
	Encoding.ClaudeV5Sonnet,
	Encoding.Qwen3,
	Encoding.DeepSeekV3,
	Encoding.KimiK2,
	Encoding.Glm5,
	Encoding.Jev,
];

console.log("pi-natives countTokens (JS string → UTF-16 → native)");
for (const encoding of ENCODINGS) {
	for (const name in CASES) {
		const text = CASES[name];
		const tokens = countTokens(text, encoding);
		countTokens(text, encoding); // Warm the lazy table.
		const start = bun.nanoseconds();
		let runs = 0;
		while ((bun.nanoseconds() - start) / 1e6 < WINDOW_MS) {
			countTokens(text, encoding);
			runs++;
		}
		const seconds = (bun.nanoseconds() - start) / 1e9;
		const megabytesPerSecond = (new TextEncoder().encode(text).byteLength * runs) / seconds / 1e6;
		console.log(
			encoding.padEnd(20) + name.padStart(10) + megabytesPerSecond.toFixed(1).padStart(12) + `   ${tokens}`,
		);
	}
}
