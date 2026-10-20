import type { BunPlugin as BunPluginSpec } from "@oh-my-pi/pi-utils/module-hooks";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";

/** Assets below this size stay object literals. */
const DEFAULT_MIN_BYTES = 256 * 1024;

/**
 * Load large JSON from compressed assets without retaining its source in bytecode.
 *
 * JSON.parse keeps the fast JSON parser without retaining a second copy of
 * the source as a JavaScript string constant. Compression also keeps embedded
 * file pages small. Only default imports are supported (`import MODELS from
 * "./models.json"`); a named import of a large
 * asset fails the build loudly instead of silently reading `undefined`.
 */
export function createJsonParsePlugin(minBytes: number = DEFAULT_MIN_BYTES): BunPluginSpec {
	return {
		name: "omp-json-parse-asset",
		setup(build) {
			build.onResolve({ filter: /^omp-json-asset:/ }, ({ path }) => ({
				path: `${path.slice("omp-json-asset:".length)}.zst`,
				namespace: "omp-json-asset",
			}));
			build.onLoad({ filter: /.*/, namespace: "omp-json-asset" }, async ({ path }) => ({
				contents: bun.zstdCompressSync(await bun.file(path.slice(0, -4)).text()),
				loader: "file",
			}));
			build.onLoad({ filter: /\.json$/ }, async ({ path }) => {
				const file = bun.file(path);
				if (file.size < minBytes) return undefined;
				const text = await file.text();
				JSON.parse(text);
				return {
					contents: `import * as fs from "node:fs";
import * as path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import asset from ${JSON.stringify(`omp-json-asset:${path}`)};
export default JSON.parse(zstdDecompressSync(fs.readFileSync(path.resolve(import.meta.dirname, asset))).toString("utf8"));`,
					loader: "js",
				};
			});
		},
	};
}
