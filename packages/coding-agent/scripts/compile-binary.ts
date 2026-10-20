// Deep import: the pi-utils barrel loads the host native addon, which is
// absent on cross-compiling release runners.
import { USER_AGENT } from "@oh-my-pi/pi-utils/dirs";
import { build } from "@oh-my-pi/pi-utils/node-build";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildDocsIndexPayload } from "./generate-docs-index";
import { createBunImportAttributesPlugin } from "./import-attributes-plugin";
import { createJsonParsePlugin } from "./json-parse-plugin";
import { createLegacyPiVirtualModulePlugin } from "./legacy-pi-virtual-module";

/** Native runtime dependencies always resolved from the on-disk install instead of being bundled. */
export const COMPILED_EXTERNAL_DEPENDENCIES: readonly string[] = Object.freeze([
	"@oh-my-pi/pi-natives",
	"fastembed",
	"onnxruntime-node",
	// Loads its own implementation files through dynamic require.
	"prettier",
]);

/** `with { type: "text" }` imports are inlined by esbuild's text loader. */
const TEXT_LOADERS = {
	".md": "text" as const,
	".txt": "text" as const,
	".py": "text" as const,
	".lark": "text" as const,
	".plist": "text" as const,
};

/** Inputs shared by local and release coding-agent builds. */
export interface CodingAgentCompileOptions {
	/** Absolute repository root used for package resolution. */
	readonly repoRoot: string;
	/** Absolute CLI entrypoint. */
	readonly entrypoint: string;
	/** Absolute output path: the launcher, or the bundle when it ends in `.js`. */
	readonly outfile: string;
	/** Concrete Transformers.js version baked into the tiny-model worker. */
	readonly transformersVersion: string;
	/** Kept for call-site compatibility; native addons load from `node_modules` next to the bundle. */
	readonly native?: { platform: string; arch: string } | null;
	/** Platform whose launcher to emit; defaults to the host. */
	readonly platform?: NodeJS.Platform;
	/** Match release builds that minify identifiers while retaining names. */
	readonly minifyIdentifiers?: boolean;
}

const LAUNCHER_POSIX = `#!/bin/sh
# omp launcher: runs the bundled CLI with the Node.js runtime.
set -e
self=$0
while [ -L "$self" ]; do
	link=$(readlink "$self")
	case $link in
	/*) self=$link ;;
	*) self=$(dirname "$self")/$link ;;
	esac
done
exec node "$(dirname "$self")/cli.js" "$@"
`;

const LAUNCHER_WINDOWS = `@echo off
rem omp launcher: runs the bundled CLI with the Node.js runtime.
node "%~dp0cli.js" %*
`;

/** Path the esbuild bundle is written to for a launcher at `outfile`. */
function bundlePathFor(outfile: string): string {
	return outfile.endsWith(".js") ? outfile : path.join(path.dirname(outfile), "cli.js");
}

/**
 * Bundle the coding-agent CLI into `cli.js` next to `options.outfile`.
 *
 * Returns the absolute bundle path. The bundle targets Node and leaves the
 * native addon external so napi loads it from the installed package.
 */
export async function bundleCodingAgent(options: CodingAgentCompileOptions): Promise<string> {
	const bundlePath = bundlePathFor(options.outfile);
	await fs.mkdir(path.dirname(bundlePath), { recursive: true });
	const output = await build({
		entrypoints: [options.entrypoint],
		outfile: bundlePath,
		root: options.repoRoot,
		external: [...COMPILED_EXTERNAL_DEPENDENCIES],
		define: {
			"process.env.PI_COMPILED": JSON.stringify("true"),
			"process.env.PI_TINY_TRANSFORMERS_VERSION": JSON.stringify(options.transformersVersion),
			"process.env.PI_DOCS_EMBED": JSON.stringify((await buildDocsIndexPayload()).payload),
			"process.env.PI_USER_AGENT": JSON.stringify(USER_AGENT),
		},
		format: "esm",
		target: "node",
		platform: "node",
		loader: TEXT_LOADERS,
		splitting: false,
		minify: { identifiers: options.minifyIdentifiers ?? false, keepNames: true },
		plugins: [createJsonParsePlugin(), await createLegacyPiVirtualModulePlugin(), createBunImportAttributesPlugin()],
		logLevel: "silent",
	});
	if (!output.success) {
		throw new Error(`Coding-agent bundle failed:\n${output.logs.map(log => log.message).join("\n")}`);
	}
	return bundlePath;
}

/** Write the platform launcher that starts `cli.js` on Node. */
export async function writeLauncher(outfile: string, platform: NodeJS.Platform): Promise<void> {
	if (platform === "win32") {
		await fs.writeFile(outfile.endsWith(".cmd") ? outfile : `${outfile}.cmd`, LAUNCHER_WINDOWS.replaceAll("\r\n", "\n"));
		return;
	}
	await fs.writeFile(outfile, LAUNCHER_POSIX, { mode: 0o755 });
}

/** Bundle the CLI and write its launcher in one step. */
export async function compileCodingAgent(options: CodingAgentCompileOptions): Promise<void> {
	await bundleCodingAgent(options);
	await writeLauncher(options.outfile, options.platform ?? process.platform);
}
