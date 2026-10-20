/**
 * `Transpiler` replacement backed by esbuild.
 *
 * Bun exposed an in-process transpiler for TS/TSX → JS. esbuild's synchronous
 * `transformSync` gives the same contract (used by the JS eval runtime and the
 * legacy Pi compatibility loader) without a Bun runtime.
 */
import { transform, transformSync } from "esbuild";

export type TranspilerLoader = "js" | "jsx" | "ts" | "tsx";

export interface TranspilerOptions {
	loader?: TranspilerLoader;
	/** Preserve JSX instead of lowering it. */
	jsx?: "preserve" | "transform" | "automatic";
	target?: string;
}

export class Transpiler {
	readonly #loader: TranspilerLoader;
	readonly #options: TranspilerOptions;

	constructor(options: TranspilerOptions = {}) {
		this.#loader = options.loader ?? "ts";
		this.#options = options;
	}

	/** Transpile source synchronously. */
	transformSync(source: string): string {
		return transformSync(source, this.#toEsbuildOptions()).code;
	}

	/** Transpile source asynchronously. */
	async transform(source: string): Promise<string> {
		return (await transform(source, this.#toEsbuildOptions())).code;
	}

	#toEsbuildOptions() {
		return {
			loader: this.#loader,
			format: "esm" as const,
			target: this.#options.target ?? "es2024",
			jsx: this.#options.jsx ?? ("preserve" as const),
			// Bun resolved `with { type: "file" | "text" }` imports itself.
			// esbuild drops import attributes it believes the target cannot
			// parse, which left Node's loader handling bare `.js` assets as
			// modules (no exports) instead of the resource the source expects.
			supported: { "import-attributes": true },
			sourcemap: false,
		};
	}
}
