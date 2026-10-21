/**
 * Preload for child processes that run repository test scripts written against
 * the compatibility globals. It exposes the two globals those scripts use
 * (`bun` and `serve`) on top of Node built-ins, so the scripts stay
 * runtime-agnostic.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { serve as nodeServe } from "@oh-my-pi/pi-utils/node-serve";

/** Flags a Node child needs to load this repository's TypeScript sources and this shim. */
const PRELOAD_FLAGS = [
	"--experimental-transform-types",
	"--import",
	pathToFileURL(path.resolve(import.meta.dirname, "../../../../scripts/node-runtime-loader.mjs")).href,
	"--import",
	import.meta.url,
];

interface SpawnOptions {
	cwd?: string;
	env?: Record<string, string | undefined>;
	stdin?: "pipe" | "ignore";
	stdout?: "pipe" | "ignore";
	stderr?: "pipe" | "ignore";
}

function stdio(mode: "pipe" | "ignore" | undefined): "pipe" | "ignore" {
	return mode === "pipe" ? "pipe" : "ignore";
}

function spawn(cmd: readonly string[], options: SpawnOptions = {}) {
	// Scripts spawned by test fixtures are TypeScript too; carry the preload forward.
	const [executable, ...args] = /^node(?:\.exe)?$/i.test(path.basename(cmd[0]!))
		? [cmd[0]!, ...PRELOAD_FLAGS, ...cmd.slice(1)]
		: cmd;
	const child = nodeSpawn(executable!, args, {
		cwd: options.cwd,
		env: options.env as NodeJS.ProcessEnv | undefined,
		stdio: [stdio(options.stdin), stdio(options.stdout), stdio(options.stderr)],
		windowsHide: true,
	});
	const { promise: exited, resolve: resolveExited } = Promise.withResolvers<number>();
	child.once("exit", (code, signal) => resolveExited(code ?? 128 + (signal ? 1 : 0)));
	return {
		...child,
		exited,
		stdout: child.stdout ? Readable.toWeb(child.stdout) : null,
		stderr: child.stderr ? Readable.toWeb(child.stderr) : null,
	};
}

Object.assign(globalThis, {
	bun: {
		env: process.env,
		write: writeFile,
		sleep: (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds)),
		spawn,
	},
	serve: nodeServe,
});
