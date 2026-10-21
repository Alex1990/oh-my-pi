#!/usr/bin/env node

import { createRequire } from "node:module";
import * as path from "node:path";
import { compileCodingAgent } from "./compile-binary";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";
import { isMainModule } from "@oh-my-pi/pi-utils/node-runtime";

const packageDir = path.join(import.meta.dirname, "..");
const repoRoot = path.join(packageDir, "..", "..");

/** Binary cross-compilation settings selected by `CROSS_TARGET`. */
export interface CrossBuild {
	readonly id: string;
	readonly platform: "darwin" | "linux" | "win32";
	readonly arch: "x64" | "arm64";
}

/** Resolves a CROSS_TARGET value to the platform pair used by Node single-executable builds. */
export function resolveCrossBuild(value: string | undefined): CrossBuild | null {
	switch (value) {
		case undefined:
		case "":
			return null;
		case "darwin-arm64":
			return { id: value, platform: "darwin", arch: "arm64" };
		case "darwin-x64":
			return { id: value, platform: "darwin", arch: "x64" };
		case "linux-arm64":
			return { id: value, platform: "linux", arch: "arm64" };
		case "linux-x64":
			return { id: value, platform: "linux", arch: "x64" };
		case "win32-x64":
		case "windows-x64":
			return { id: value, platform: "win32", arch: "x64" };
		case "win32-arm64":
		case "windows-arm64":
			return { id: value, platform: "win32", arch: "arm64" };
		default:
			throw new Error(`Unsupported CROSS_TARGET: ${value}`);
	}
}

// Transformers.js is an optional, native-heavy dependency that is never bundled
// into the binary; the tiny-model worker `bun install`s it into a runtime cache
// on first use. The `catalog:` spec cannot be resolved from inside the compiled
// bunfs (issue #1763), so embed the concrete installed version here for the
// worker to pin its runtime install against.
const transformersManifest: unknown = createRequire(import.meta.url)("@huggingface/transformers/package.json");
if (
	typeof transformersManifest !== "object" ||
	transformersManifest === null ||
	!("version" in transformersManifest) ||
	typeof transformersManifest.version !== "string"
) {
	throw new Error("@huggingface/transformers package manifest has no string version");
}
const transformersVersion = transformersManifest.version;

async function runCommand(command: string[]): Promise<void> {
	const proc = bun.spawn(command, {
		cwd: packageDir,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`Command failed with exit code ${exitCode}: ${command.join(" ")}`);
	}
}

async function main(): Promise<void> {
	const crossBuild = resolveCrossBuild(bun.env.CROSS_TARGET);
	const outName = crossBuild ? `oyp-${crossBuild.id}` : "oyp";
	const outputPath = path.join(packageDir, "dist", outName);
	// Generate inside the try so the finally always restores the empty checked-in
	// placeholders (stats client archive, docs index) even on failure.
	try {
		await runCommand(["pnpm", "--dir", "../stats", "run", "gen:stats"]);
		// The in-memory legacy Pi virtual module reaches the coding-agent
		// `export/html` subpath, whose source imports `tool-views.generated.js`.
		// Rebuild it before compilation so clean checkouts that skipped install
		// hooks still contain that generated bundle.
		await runCommand(["pnpm", "--dir", "../collab-web", "run", "gen:tool-views"]);
		await compileCodingAgent({
			repoRoot,
			entrypoint: path.join(packageDir, "src", "cli.ts"),
			outfile: outputPath,
			transformersVersion,
			native: crossBuild ?? { platform: process.platform, arch: process.arch },
			platform: crossBuild?.platform ?? process.platform,
		});
	} finally {
		await runCommand(["pnpm", "--dir", "../stats", "run", "gen:stats:reset"]);
	}
}

if (isMainModule(import.meta.url)) await main();
