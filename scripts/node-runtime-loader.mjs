/**
 * Node ESM loader hooks for this repository's TypeScript source tree.
 *
 * Two gaps make raw `node src/cli.ts` (or a worker re-entering `src/cli.ts`)
 * fail against sources written for a bundler:
 *
 * 1. Extensionless relative specifiers (`./fs-error`) — Node's ESM resolver
 *    requires a full filename.
 * 2. `with { type: "text" }` imports of prompts and fixtures, which only Bun's
 *    loader understood.
 *
 * Both are handled here. Register with
 * `node --experimental-transform-types --import ./scripts/node-runtime-loader.mjs …`.
 * Bundled distributions (`dist/cli.js`) need neither hook.
 */
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TEXT_EXTENSIONS = new Set([".txt", ".md", ".py", ".lark"]);
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".py", ".lark", ".sh", ".plist", ".html", ".css", ".rb", ".jl", ".applescript"]);
const RESOLVE_SUFFIXES = [".ts", ".tsx", ".mts", ".js", "/index.ts", "/index.tsx", "/index.js"];

registerHooks({
	resolve(specifier, context, nextResolve) {
		try {
			return nextResolve(specifier, context);
		} catch (error) {
			if (!specifier.startsWith(".") && !specifier.startsWith("/")) throw error;
			// TypeScript's NodeNext style writes `./foo.js` for `foo.ts`.
			if (specifier.endsWith(".js")) {
				for (const replacement of [".ts", ".tsx"]) {
					try {
						return nextResolve(specifier.slice(0, -3) + replacement, context);
					} catch {
						// try the next candidate
					}
				}
			}
			for (const suffix of RESOLVE_SUFFIXES) {
				try {
					return nextResolve(specifier + suffix, context);
				} catch {
					// try the next candidate
				}
			}
			throw error;
		}
	},
	load(url, context, nextLoad) {
		if (!url.startsWith("file:")) return nextLoad(url, context);
		// Bun resolved `.json` without an import attribute; Node requires one, so
		// serve JSON modules directly and skip the attribute check.
		if (url.endsWith(".json") && context.importAttributes?.type !== "json") {
			return { format: "json", source: readFileSync(fileURLToPath(url), "utf8"), shortCircuit: true };
		}
		const pathname = fileURLToPath(url);
		const dot = pathname.lastIndexOf(".");
		const extension = dot === -1 ? "" : pathname.slice(dot);
		// Bun resolved `with { type: "file" }` to a path string; do the same.
		if (context.importAttributes?.type === "file") {
			return {
				format: "module",
				source: `export default ${JSON.stringify(pathname)};`,
				shortCircuit: true,
			};
		}
		// `prelude.js` (and siblings) are only ever imported as text; the sync hook
		// does not always deliver import attributes, so recognize them by name.
		if (pathname.endsWith(`${path.sep}prelude.js`)) {
			return {
				format: "module",
				source: `export default ${JSON.stringify(readFileSync(pathname, "utf8"))};`,
				shortCircuit: true,
			};
		}
		// `with { type: "text" }` is authoritative: Bun exposed third-party `.js`
		// assets as text too, so no extension filter applies. Attribute-less imports
		// of bunfig's text extensions behave the same way.
		const attributeType = context.importAttributes?.type;
		const implicitText = attributeType === undefined && DEFAULT_TEXT_EXTENSIONS.has(extension);
		if (attributeType === "text" || implicitText) {
			const source = readFileSync(pathname, "utf8");
			return {
				format: "module",
				source: `export default ${JSON.stringify(source)};`,
				shortCircuit: true,
			};
		}
		return nextLoad(url, context);
	},
});
