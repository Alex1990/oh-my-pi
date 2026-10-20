import * as path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Module hooks for running this repository's TypeScript sources in a fresh
 * Node process: extensionless relative imports and `with { type: "text" }`
 * assets are both Bun-only features that `node-runtime-loader.mjs` supplies.
 */
const LOADER_URL = pathToFileURL(path.resolve(import.meta.dirname, "../../../../scripts/node-runtime-loader.mjs")).href;

/** `process.execPath` arguments that evaluate `script` as ESM against the sources. */
export function nodeEvalArgs(script: string): string[] {
	return [
		"--disable-warning=ExperimentalWarning",
		"--experimental-transform-types",
		// `bun.gc(true)` shims to `global.gc`, which requires this flag.
		"--expose-gc",
		"--import",
		LOADER_URL,
		"--input-type=module",
		"--eval",
		script,
	];
}

/** `process.execPath` arguments that run a TypeScript entry file against the sources. */
export function nodeScriptArgs(file: string): string[] {
	return [
		"--disable-warning=ExperimentalWarning",
		"--experimental-transform-types",
		"--expose-gc",
		"--import",
		LOADER_URL,
		file,
	];
}
