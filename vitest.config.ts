import * as path from "node:path";
import { pathToFileURL } from "node:url";
/**
 * Vitest configuration for the omp workspace.
 *
 * Tests import `@oh-my-pi/pi-utils/test-runtime`, which re-exports Vitest, so no
 * globals are configured. The text-import plugin mirrors `scripts/text-loader.mjs`:
 * source files import prompts and fixtures with `with { type: "text" }`, which
 * Vite does not handle natively.
 */
import { readFile } from "node:fs/promises";
import { defineConfig, type Plugin } from "vitest/config";

const TEXT_EXTENSIONS = new Set([
	".md",
	".txt",
	".py",
	".lark",
	".sh",
	".plist",
	".html",
	".css",
	".rb",
	".jl",
	".applescript",
]);

function textImports(): Plugin {
	return {
		name: "omp-text-imports",
		enforce: "pre",
		async resolveId(source, importer) {
			const clean = source.split("?")[0];
			let absolute: string;
			if (clean.startsWith(".") || clean.startsWith("/")) {
				const base = importer ? path.dirname(importer) : process.cwd();
				absolute = path.resolve(base, clean);
			} else {
				// Package specifiers (e.g. `axe-core/axe.min.js`) need the runner's
				// resolver before the extension check.
				const resolved = await this.resolve(source, importer, { skipSelf: true });
				if (!resolved) return null;
				absolute = resolved.id.split("?")[0];
			}
			// Vite normalizes ids to posix separators, Windows included.
			const packagePath = absolute.split(path.sep).join("/");
			// `with { type: "file" }` assets: the bundler exposes the path, not the
			// module. These are browser payloads under `export/html` and the
			// changelog that compiled binaries embed. Only the browser payload
			// extensions qualify — `.ts` siblings in that directory (`args.ts`,
			// `web-palette.ts`, `index.ts`) are real modules.
			const exportAsset =
				packagePath.includes("/export/html/") && /\.(?:js|html|css)$/i.test(packagePath);
			if (exportAsset || packagePath.endsWith("/coding-agent/CHANGELOG.md")) {
				return `\0omp-asset:${absolute}|omp-asset`;
			}
			const dot = absolute.lastIndexOf(".");
			const extension = dot === -1 ? "" : absolute.slice(dot);
			if (TEXT_EXTENSIONS.has(extension)) return `\0omp-text:${absolute}`;
			// `prelude.js` is only ever imported `with { type: "text" }`.
			if (path.basename(absolute) === "prelude.js") return `\0omp-text:${absolute}`;
			// `axe-core/axe.min.js` is imported `with { type: "text" }`; the runner
			// cannot see the attribute, so recognize this packaged browser payload.
			if (packagePath.includes("/axe-core/")) return `\0omp-text:${absolute}`;
			return null;
		},
		async load(id) {
			if (id.startsWith("\0omp-text:")) {
				const source = await readFile(id.slice("\0omp-text:".length), "utf8");
				return `export default ${JSON.stringify(source)};`;
			}
			if (id.startsWith("\0omp-asset:")) {
				const assetPath = id.slice("\0omp-asset:".length, -"|omp-asset".length);
				return `export default ${JSON.stringify(assetPath)};`;
			}
			return null;
		},
	};
}

export default defineConfig({
	plugins: [textImports()],
	// React 17+ automatic runtime: package sources import components without a
	// default `React` binding, and Vite's default `jsx` transform is classic.
	esbuild: { jsx: "automatic" },
	test: {
		include: [
			"test/**/*.test.{ts,tsx}",
			"src/**/*.test.{ts,tsx}",
			"bench/**/*.test.{ts,tsx}",
			"scripts/**/*.test.{ts,tsx}",
			"packages/*/test/**/*.test.{ts,tsx}",
		],
		exclude: ["**/node_modules/**", "**/dist/**", "**/target/**", "**/.omp/**", "**/bazel-*/**"],
		// `axe-core/axe.min.js` is imported `with { type: "text" }`; Vite would
		// otherwise externalize it and hand back the CJS namespace as the default.
		// Legacy-extension suites also write modules into the OS temp directory at
		// runtime and load them through Node's module hooks; Vite must hand those
		// files to the native loader instead of transforming them, otherwise the
		// hooks (and the legacy specifier remaps they implement) never run.
		server: { deps: { inline: [/axe-core/], external: [/[\\/](?:Temp|tmp)[\\/]/] } },
		globals: false,
		restoreMocks: true,
		testTimeout: 120_000,
		hookTimeout: 60_000,
		pool: "forks",
		// Bun's JS stack is larger than V8's default; the inline-lexer
		// stress tests recurse through thousands of nested delimiters.
		poolOptions: {
			// `--experimental-vm-modules` lets `vm`-compiled eval code resolve
			// dynamic imports; Bun's eval allowed them without a flag. The source
			// loader is inherited by worker_threads so `.ts` workers can resolve
			// extensionless imports.
			forks: {
				execArgv: [
					"--stack-size=4096",
					// `bun.gc(true)` shims to `global.gc`, which is undefined
					// without this flag; release tests rely on it.
					"--expose-gc",
					"--experimental-vm-modules",
					"--experimental-transform-types",
					"--import",
					pathToFileURL(path.join(import.meta.dirname, "scripts/node-runtime-loader.mjs")).href,
				],
			},
		},
		reporters: ["dot"],
	},
});
