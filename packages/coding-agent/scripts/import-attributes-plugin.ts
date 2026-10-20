/**
 * esbuild plugin for Bun's non-JSON import attributes.
 *
 * The source tree imports prompts and fixtures with `with { type: "text" }` and
 * bundled assets with `with { type: "file" }`. esbuild only understands
 * `type: "json"` and rejects the other attributes at parse time, so this plugin
 * rewrites those import specifiers to query-tagged virtual ones before parsing
 * and serves them with the matching loader.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BunPluginSpec } from "@oh-my-pi/pi-utils/module-hooks";

const TEXT_ATTRIBUTE = /(from\s+["'][^"']+["'])\s+with\s*\{\s*type:\s*"text"\s*\}/g;
const FILE_ATTRIBUTE = /(from\s+["'][^"']+["'])\s+with\s*\{\s*type:\s*"file"\s*\}/g;
const DYNAMIC_TEXT = /(import\(\s*["'][^"']+["'])\s*,\s*\{\s*with:\s*\{\s*type:\s*"text"\s*\}\s*\}/g;

function tagSpecifiers(source: string, pattern: RegExp, tag: string): string {
	return source.replace(pattern, (_match, head: string) => {
		return head.replace(
			/^(from\s+|import\(\s*)(["'])([^"']+)\2$/,
			(_m, prefix: string, quote: string, spec: string) => {
				return `${prefix}${quote}${spec}${tag}${quote}`;
			},
		);
	});
}

export function createBunImportAttributesPlugin(): BunPluginSpec {
	return {
		name: "omp-bun-import-attributes",
		setup(build) {
			// Serve tagged specifiers from their own namespaces. Package specifiers
			// (`axe-core/axe.min.js`) go through esbuild's resolver; relative ones
			// resolve against the importing file.
			const tagNamespace =
				(tag: string, namespace: string) => async (args: { path: string; resolveDir: string; kind: string }) => {
					const specifier = args.path.slice(0, -tag.length);
					if (specifier.startsWith(".") || path.isAbsolute(specifier)) {
						return { path: path.resolve(args.resolveDir, specifier), namespace };
					}
					if (!build.resolve) throw new Error("omp-bun-import-attributes: bundler resolver unavailable");
					const resolved = await build.resolve(specifier, {
						resolveDir: args.resolveDir,
						kind: args.kind as never,
					});
					if (resolved.errors.length > 0) return { errors: resolved.errors };
					return { path: resolved.path, namespace };
				};
			build.onResolve({ filter: /\?omp-text$/ }, tagNamespace("?omp-text", "omp-text"));
			build.onResolve({ filter: /\?omp-file$/ }, tagNamespace("?omp-file", "omp-file"));
			build.onLoad({ filter: /.*/, namespace: "omp-text" }, async args => ({
				contents: await fs.readFile(args.path, "utf8"),
				loader: "text",
			}));
			build.onLoad({ filter: /.*/, namespace: "omp-file" }, async args => ({
				contents: await fs.readFile(args.path),
				loader: "file",
			}));

			// Strip the attributes from every TypeScript/JavaScript module first.
			build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async args => {
				const source = await fs.readFile(args.path, "utf8");
				if (!source.includes('type: "text"') && !source.includes('type: "file"')) return null;
				let rewritten = tagSpecifiers(source, TEXT_ATTRIBUTE, "?omp-text");
				rewritten = tagSpecifiers(rewritten, FILE_ATTRIBUTE, "?omp-file");
				rewritten = tagSpecifiers(rewritten, DYNAMIC_TEXT, "?omp-text");
				if (rewritten === source) return null;
				const extension = args.path.split(".").pop();
				const loader =
					extension === "tsx"
						? "tsx"
						: extension === "ts" || extension === "mts" || extension === "cts"
							? "ts"
							: "js";
				return { contents: rewritten, loader };
			});
		},
	};
}
